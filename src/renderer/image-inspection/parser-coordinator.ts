import { projectPackedOwnedImages, type AsyncImageSourceContext, type ImageParseTransport } from "./async-source";
import type { ImageProjectionResult, ImageSourceFile } from "./source";

export interface OwnedImageParseTransport extends ImageParseTransport { close(): Promise<void> }
interface Intent {
  readonly owner: object;
  readonly controller: AbortController;
  readonly reject: (error: unknown) => void;
  run(): Promise<void>;
}
const cancelled = () => Object.assign(new Error("Cancelled image parse."), { name: "AbortError" });

/** Private per-App admission and retirement ownership; never retries a failed broker. */
export class ImageParserCoordinator {
  private state: "open" | "failed" | "closed" = "open";
  private transport?: OwnedImageParseTransport;
  private retirement?: Promise<void>;
  private closing?: Promise<void>;
  private active?: { intent: Intent; done: Promise<void> };
  private pending?: Intent;
  private readonly closedOwners = new WeakSet<object>();
  private readonly ownerClosures = new WeakMap<object, Promise<void>>();
  constructor(private readonly factory: () => OwnedImageParseTransport) {}

  project<T extends ImageSourceFile>(context: AsyncImageSourceContext<T>, ownerToken: object): Promise<ImageProjectionResult<T>> {
    if (typeof ownerToken !== "object" || ownerToken === null) return Promise.reject(new Error("Invalid image parser render owner."));
    if (this.closedOwners.has(ownerToken)) return Promise.reject(new Error("Image parser owner is closed."));
    if (this.state !== "open") return Promise.reject(new Error("Image parser closed or unavailable."));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const intent: Intent = { owner: ownerToken, controller, reject, run: async () => {
        try {
          // The projection validates its initial authority before this lazy allocation.
          const result = await projectPackedOwnedImages(context, { parse: (source, signal) => {
            this.transport ??= this.factory();
            return this.transport.parse(source, signal);
          } }, { signal: controller.signal });
          if (controller.signal.aborted) throw cancelled();
          resolve(result);
        } catch (error) {
          const cancellation = controller.signal.aborted && error instanceof Error && error.name === "AbortError";
          if (!cancellation) this.fail(error);
          reject(error);
        }
      } };
      if (this.active) {
        this.pending?.reject(cancelled());
        this.pending = intent;
        this.active.intent.controller.abort();
      } else this.start(intent);
    });
  }

  private start(intent: Intent): void {
    const active = { intent, done: Promise.resolve() };
    this.active = active;
    active.done = intent.run().finally(() => {
      if (this.active !== active) return;
      this.active = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (next && this.state === "open") this.start(next);
      else next?.reject(cancelled());
    });
  }

  private retire(): Promise<void> {
    if (!this.retirement) {
      try { this.retirement = Promise.resolve(this.transport?.close()); }
      catch (error) { this.retirement = Promise.reject(error); }
      // Failure remains observable through close(), including after work already failed.
      void this.retirement.catch(() => {});
    }
    return this.retirement;
  }

  private fail(error: unknown): void {
    if (this.state !== "open") return;
    this.state = "failed";
    this.pending?.reject(error);
    this.pending = undefined;
    void this.retire();
  }

  closeOwner(owner: object): Promise<void> {
    const existing = this.ownerClosures.get(owner);
    if (existing) return existing;
    this.closedOwners.add(owner);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closure = new Promise<void>((done, failed) => { resolve = done;reject = failed; });
    this.ownerClosures.set(owner, closure);
    if (this.pending?.owner === owner) {
      this.pending.reject(cancelled());
      this.pending = undefined;
    }
    const active = this.active;
    if (active?.intent.owner === owner) active.intent.controller.abort();
    void (async () => {
      if (active?.intent.owner === owner) await active.done;
      // Preserve failed retirement even after active.finally has released its handle.
      if (this.retirement) await this.retirement;
    })().then(resolve, reject);
    return closure;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed";
    this.pending?.reject(cancelled());
    this.pending = undefined;
    const active = this.active;
    active?.intent.controller.abort();
    // Close the owned transport before awaiting its pending handshake/parse.
    const retirement = this.retire();
    this.closing = Promise.allSettled([retirement, active?.done]).then(results => {
      for (const result of results) if (result.status === "rejected") throw result.reason;
    });
    return this.closing;
  }
}

const coordinators = new WeakMap<object, ImageParserCoordinator>();
export function imageParserCoordinatorFor(app: object, factory: () => OwnedImageParseTransport): ImageParserCoordinator {
  let coordinator = coordinators.get(app);
  if (!coordinator) { coordinator = new ImageParserCoordinator(factory); coordinators.set(app, coordinator); }
  return coordinator;
}
export async function closeImageParserCoordinator(app: object): Promise<void> {
  const coordinator = coordinators.get(app);
  if (!coordinator) return;
  await coordinator.close();
  if (coordinators.get(app) === coordinator) coordinators.delete(app);
}
