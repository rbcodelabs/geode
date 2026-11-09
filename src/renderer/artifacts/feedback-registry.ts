import {
  ARTIFACT_FEEDBACK_CONTRACT_VERSIONS,
  ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS,
  type ArtifactFeedbackHandler,
  type ArtifactFeedbackOwner,
  type ArtifactFeedbackRegistration,
  type ArtifactFeedbackRegistry,
  type ArtifactFeedbackRejectReason,
  type ArtifactFeedbackRequest,
  type ArtifactFeedbackResult,
  type ArtifactFeedbackTarget,
} from "../../artifacts/feedback-contract";

/**
 * Where an outcome came from. `handler` means the plugin answered; every other
 * value is synthesized by Geode so the popover can word it ("no response in 15 s"
 * differs from "the plugin said no").
 */
export type ArtifactFeedbackOutcomeSource = "handler" | "timeout" | "disposed" | "no-handler" | "invalid-result";
export type ArtifactFeedbackOutcome = ArtifactFeedbackResult & { readonly source: ArtifactFeedbackOutcomeSource };

const MESSAGE_MAX_UNITS = 500;
const REJECT_REASONS: ReadonlySet<string> = new Set<ArtifactFeedbackRejectReason>([
  "busy", "invalid", "unsupported", "unavailable", "failed",
]);

interface InFlight { settle(outcome: ArtifactFeedbackOutcome): void; controller: AbortController }
interface Entry {
  readonly owner: ArtifactFeedbackOwner;
  readonly handler: ArtifactFeedbackHandler;
  readonly inFlight: Set<InFlight>;
  live: boolean;
}

/** Strips control characters (newlines and tabs become spaces) and caps the length. Untrusted text, render with textContent only. */
export function cleanFeedbackMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\t\n\r]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return cleaned.slice(0, MESSAGE_MAX_UNITS);
}

/** Freezes plain objects and arrays recursively; typed arrays (the screenshot bytes) cannot be frozen and are left alone. */
export function freezePlain<T>(value: T): T {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freezePlain((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

/**
 * Geode's side of the artifact feedback contract (ADR 0006 D1). One instance per
 * App, exposed as `app.artifactFeedback`. Plugins see only the
 * `ArtifactFeedbackRegistry` members; `register` and `submit` are internal (used
 * by `Plugin.registerArtifactFeedbackHandler`, the inspector bridge and tests).
 *
 * Fault isolation mirrors the quick-switcher precedent: nothing a handler does
 * (throw, reject, hang, return junk) surfaces as anything but a rejected outcome
 * and a console.warn, so it can never reach a plugin error boundary.
 */
export class ArtifactFeedbackService implements ArtifactFeedbackRegistry {
  readonly contractVersions: readonly number[] = ARTIFACT_FEEDBACK_CONTRACT_VERSIONS;
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  constructor(options: { timeoutMs?: number; enabled?: boolean } = {}) {
    this.timeoutMs = options.timeoutMs ?? ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS;
    this.enabled = options.enabled ?? true;
  }

  register(owner: ArtifactFeedbackOwner, handler: ArtifactFeedbackHandler): ArtifactFeedbackRegistration {
    const failure = (status: "unsupported-version" | "conflict" | "invalid" | "unavailable", message: string): ArtifactFeedbackRegistration =>
      ({ status, message, dispose() {} });
    if (!this.enabled) return failure("unavailable", "Artifact feedback is not available on this host.");
    if (!handler || typeof handler !== "object" || typeof handler.submit !== "function") {
      return failure("invalid", "A feedback handler must be an object with a submit function.");
    }
    if (!this.contractVersions.includes(handler.contractVersion)) {
      return failure("unsupported-version", `Contract version ${String(handler.contractVersion)} is not supported (supported: ${this.contractVersions.join(", ")}).`);
    }
    if (this.entries.some((entry) => entry.owner.pluginId === owner.pluginId)) {
      return failure("conflict", `"${owner.pluginId}" already has a live feedback handler; dispose it first.`);
    }
    const entry: Entry = { owner: { pluginId: owner.pluginId, displayName: owner.displayName }, handler, inFlight: new Set(), live: true };
    this.entries.push(entry);
    this.notify();
    return {
      status: "registered",
      dispose: () => {
        if (!entry.live) return;
        entry.live = false;
        this.entries.splice(this.entries.indexOf(entry), 1);
        for (const flight of [...entry.inFlight]) {
          flight.settle({
            status: "rejected",
            reason: "unavailable",
            message: `${entry.owner.displayName} is no longer available.`,
            source: "disposed",
          });
        }
        this.notify();
      },
    };
  }

  has(target: ArtifactFeedbackTarget): boolean {
    return this.resolve(target) !== null;
  }

  /** Display name of the plugin that would receive a submission for this target (popover copy), or null. */
  describeHandler(target: ArtifactFeedbackTarget): string | null {
    return this.resolve(target)?.owner.displayName ?? null;
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Routes one submission to exactly one handler: the first, in registration
   * order, whose `canHandle` passes. Never rejects; every failure is an outcome.
   */
  submit(target: ArtifactFeedbackTarget, request: ArtifactFeedbackRequest): Promise<ArtifactFeedbackOutcome> {
    const entry = this.resolve(target);
    if (!entry) {
      return Promise.resolve({ status: "rejected", reason: "unavailable", message: "Nothing can receive this feedback right now.", source: "no-handler" });
    }
    const name = entry.owner.displayName;
    const frozen = freezePlain(request);
    return new Promise<ArtifactFeedbackOutcome>((resolve) => {
      const controller = new AbortController();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flight: InFlight = { controller, settle: (outcome) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        entry.inFlight.delete(flight);
        // Abort on every synthetic outcome so a hung handler stops working; a normal result needs no abort.
        if (outcome.source !== "handler" && outcome.source !== "invalid-result") controller.abort();
        resolve(outcome);
      } };
      entry.inFlight.add(flight);
      timer = setTimeout(() => {
        console.warn(`[artifact-feedback] "${entry.owner.pluginId}" did not answer within ${this.timeoutMs} ms`);
        flight.settle({
          status: "rejected",
          reason: "failed",
          message: `No response from ${name} in ${Math.round(this.timeoutMs / 1000)} s. It may have been received; check the thread before retrying. Retry reuses the same selection id.`,
          source: "timeout",
        });
      }, this.timeoutMs);
      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(entry.handler.submit(frozen, { signal: controller.signal }));
      } catch (error) {
        console.warn(`[artifact-feedback] "${entry.owner.pluginId}" submit threw`, error);
        flight.settle({ status: "rejected", reason: "failed", message: `${name} could not take this feedback.`, source: "handler" });
        return;
      }
      promise.then(
        (result) => flight.settle(this.normalize(entry, result)),
        (error) => {
          console.warn(`[artifact-feedback] "${entry.owner.pluginId}" submit rejected`, error);
          flight.settle({ status: "rejected", reason: "failed", message: `${name} could not take this feedback.`, source: "handler" });
        },
      );
    });
  }

  private resolve(target: ArtifactFeedbackTarget): Entry | null {
    for (const entry of this.entries) {
      const canHandle = entry.handler.canHandle;
      if (canHandle === undefined) return entry;
      try {
        if (canHandle.call(entry.handler, target) === true) return entry;
      } catch {
        // Counts as false; a visibility check runs often, so it must not log.
      }
    }
    return null;
  }

  private normalize(entry: Entry, result: unknown): ArtifactFeedbackOutcome {
    const bad = (): ArtifactFeedbackOutcome => {
      console.warn(`[artifact-feedback] "${entry.owner.pluginId}" returned a malformed result`, result);
      return { status: "rejected", reason: "failed", message: `${entry.owner.displayName} returned an invalid response.`, source: "invalid-result" };
    };
    if (result === null || typeof result !== "object") return bad();
    const { status, reason, message } = result as { status?: unknown; reason?: unknown; message?: unknown };
    if (status === "accepted") {
      const cleaned = cleanFeedbackMessage(message);
      return cleaned ? { status: "accepted", message: cleaned, source: "handler" } : { status: "accepted", source: "handler" };
    }
    if (status === "rejected" && typeof reason === "string" && REJECT_REASONS.has(reason) && typeof message === "string") {
      return { status: "rejected", reason: reason as ArtifactFeedbackRejectReason, message: cleanFeedbackMessage(message) ?? "", source: "handler" };
    }
    return bad();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { console.warn("[artifact-feedback] onDidChange listener threw", error); }
    }
  }
}
