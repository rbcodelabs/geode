/** Private lifecycle only: injected adapters are not evidence of native decoder settlement. */
import type { SupportedRasterMime } from "../../main/image-ipc";
import type { ImageCleanupFailure } from "../../shared/image-cleanup";
export interface ImageIntent {
  ownerToken: object; file: object; vault: object; root: string; path: string; snapshot: string;
  current(captured: Readonly<ImageIntent>): boolean;
}
export interface ImageBytes { bytes: ArrayBuffer; mime: SupportedRasterMime }
export interface ImageDimensions { width: number; height: number }
export interface ImageSessionAdapter {
  read(intent: Readonly<ImageIntent>, id: string): Promise<ImageBytes | ImageCleanupFailure>;
  cancel(intent: Readonly<ImageIntent>, id: string): Promise<void | ImageCleanupFailure> | void | ImageCleanupFailure;
  createURL(bytes: ImageBytes): string;
  decode(url: string): Promise<ImageDimensions>;
  hide(): void; clear(): void; release(): void; revoke(url: string): void;
  publish(url: string, dimensions: ImageDimensions): void;
}
export function assertImageDimensions(value: ImageDimensions): void {
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width <= 0 || value.height <= 0
    || value.width > Math.floor(64_000_000 / value.height)) throw new Error("Invalid or oversized image dimensions.");
}
interface Entry {
  original: ImageIntent; captured: Readonly<ImageIntent>; id: string;
  resolve(): void; reject(error: unknown): void; done: Promise<void>; finish(): void;
  obsolete: boolean; presentationRetired: boolean; revoked: boolean; finished: boolean;
  uncertain: boolean;
  url?: string; cleanup: Promise<void>[]; cleanupErrors: unknown[];
  retirement?: Promise<void>;
}
const obsolete = () => Object.assign(new Error("Obsolete image intent."), { name: "AbortError" });
const object = (value: unknown): value is object => typeof value === "object" && value !== null;
export class ImageInspectionSession {
  private active?: Entry;
  private pending?: Entry;
  private closed = false;
  private failed = false;
  private failure: unknown;
  private closing?: Promise<void>;
  constructor(private readonly ownerToken: object, private readonly adapter?: ImageSessionAdapter) {}
  show(intent: ImageIntent): Promise<void> {
    if (this.failed) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("Image session is closed."));
    if (!this.adapter || !(["read", "cancel", "createURL", "decode", "hide", "clear", "release", "revoke", "publish"] as const)
      .every(key => typeof this.adapter![key] === "function")) return Promise.reject(new Error("Unsupported image host capability."));
    let captured: Readonly<ImageIntent>, id: string;
    try {
      if (!object(this.ownerToken) || !intent || intent.ownerToken !== this.ownerToken || !object(intent.file) || !object(intent.vault)
        || typeof intent.root !== "string" || !intent.root || typeof intent.path !== "string" || !intent.path
        || typeof intent.snapshot !== "string" || typeof intent.current !== "function") throw new Error("Invalid image intent authority.");
      captured = Object.freeze({ ...intent });
      if (captured.current(captured) !== true) throw obsolete();
      id = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    } catch (error) { return Promise.reject(error); }
    return new Promise<void>((resolve, reject) => {
      let finish!: () => void;
      const done = new Promise<void>(settled => { finish = settled; });
      const entry: Entry = { original: intent, captured, id, resolve, reject, done, finish,
        obsolete: false, presentationRetired: false, revoked: false, finished: false, uncertain: false, cleanup: [], cleanupErrors: [] };
      if (this.active) {
        this.pending?.reject(obsolete()); this.pending = entry;
        const previous = this.active;
        void this.retire(previous).then(() => this.advance(previous), () => this.advance(previous));
      } else this.start(entry);
    });
  }
  private current(entry: Entry): boolean {
    const a = entry.original, b = entry.captured;
    if (this.closed || this.failed || entry.obsolete) return false;
    // The authority callback may synchronously close/invalidate this session.
    // Test local ownership after it returns rather than trusting an earlier check.
    if (b.current(b) !== true) return false;
    return !this.closed && !this.failed && !entry.obsolete && a.ownerToken === b.ownerToken && a.file === b.file && a.vault === b.vault
      && a.root === b.root && a.path === b.path && a.snapshot === b.snapshot && a.current === b.current;
  }
  private check(entry: Entry): void { if (!this.current(entry)) throw obsolete(); }
  private cleanup(entry: Entry, operation: () => void): void {
    try { operation(); } catch (error) { entry.cleanupErrors.push(error); }
  }
  private revoke(entry: Entry): void {
    if (entry.url === undefined || entry.revoked) return;
    entry.revoked = true; this.cleanup(entry, () => this.adapter!.revoke(entry.url!));
  }
  private retirePresentation(entry: Entry): void {
    if (!entry.presentationRetired) {
      entry.presentationRetired = true;
      this.cleanup(entry, () => this.adapter!.hide());
      this.cleanup(entry, () => this.adapter!.clear());
      this.cleanup(entry, () => this.adapter!.release());
    }
    this.revoke(entry);
  }
  private retire(entry: Entry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    let resolve!: () => void, reject!: (error: unknown) => void;
    entry.retirement = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    entry.obsolete = true;
    this.retirePresentation(entry);
    if (!entry.finished) {
      try {
        entry.cleanup.push(Promise.resolve(this.adapter!.cancel(entry.captured, entry.id)).then(reply => {
          if (reply?.kind === "cleanup-uncertain") entry.cleanupErrors.push(reply.error);
        }, error => { entry.cleanupErrors.push(error); }));
      } catch (error) { entry.cleanupErrors.push(error); }
    }
    if (entry.finished && entry.cleanupErrors.length) this.seal(entry.cleanupErrors);
    void entry.done.then(() => {
      if (this.failed) reject(this.failure); else resolve();
    });
    return entry.retirement;
  }
  private seal(errors: unknown[]): unknown {
    if (!this.failed) {
      this.failed = true;
      this.failure = errors.length === 1 ? errors[0] : new AggregateError(errors, "Image work and cleanup failed.");
      this.pending?.reject(this.failure); this.pending = undefined;
    }
    return this.failure;
  }
  private start(entry: Entry): void {
    this.active = entry;
    void this.run(entry).then(entry.finish);
  }
  private async run(entry: Entry): Promise<void> {
    let failed = false, primary: unknown;
    try {
      this.check(entry);
      const bytes = await this.adapter!.read(entry.captured, entry.id);
      // Only a trusted host adapter supplies this discriminant; a future bridge
      // must validate its schema, never infer it from cloned Error prototypes.
      if ("kind" in bytes && bytes.kind === "cleanup-uncertain") { entry.uncertain = true; throw bytes.error; }
      this.check(entry);
      entry.url = this.adapter!.createURL(bytes as ImageBytes);
      this.check(entry);
      const dimensions = await this.adapter!.decode(entry.url);
      this.check(entry); assertImageDimensions(dimensions);
      this.adapter!.publish(entry.url, dimensions); this.check(entry);
    } catch (error) { failed = true; primary = error; }
    if (failed || entry.obsolete) this.retirePresentation(entry);
    // A cancellation acknowledgement is additional cleanup, never read/decode
    // settlement. Drain everything registered before allowing the next intent.
    let cleanupCount = 0;
    for (;;) {
      if (cleanupCount < entry.cleanup.length) {
        const batch = entry.cleanup.slice(cleanupCount); cleanupCount = entry.cleanup.length;
        await Promise.all(batch);
      }
      if (!failed) {
        try { this.check(entry); } catch (error) { failed = true; primary = error; this.retirePresentation(entry); }
      }
      // A reentrant authority callback can register cancellation even on this
      // final check. Stabilize that cleanup before committing settlement.
      if (cleanupCount === entry.cleanup.length) break;
    }
    entry.finished = true;
    if (entry.uncertain || entry.cleanupErrors.length) entry.reject(this.seal(failed ? [primary, ...entry.cleanupErrors] : entry.cleanupErrors));
    else if (failed) entry.reject(primary);
    else entry.resolve();
  }
  private advance(previous: Entry): void {
    if (this.active !== previous) return;
    this.active = undefined;
    const next = this.pending; this.pending = undefined;
    if (!next) return;
    if (this.failed) next.reject(this.failure);
    else if (this.closed) next.reject(obsolete());
    else this.start(next);
  }
  /** Future owner hooks must notify source/navigation invalidation synchronously. */
  invalidate(): Promise<void> {
    if (this.closing) return this.closing;
    const pending = this.pending; this.pending = undefined; pending?.reject(obsolete());
    const active = this.active;
    if (!active) return this.failed ? Promise.reject(this.failure) : Promise.resolve();
    const retiring = this.retire(active);
    void retiring.then(() => this.advance(active), () => this.advance(active));
    return retiring;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.closed = true;
    const pending = this.pending; this.pending = undefined; pending?.reject(obsolete());
    const active = this.active;
    const retiring = active ? this.retire(active) : undefined;
    void (async () => {
      if (retiring) await retiring;
      if (this.failed) throw this.failure;
    })().then(resolve, reject);
    return this.closing;
  }
}
