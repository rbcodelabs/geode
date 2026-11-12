import {
  ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS,
  type ArtifactFeedbackOwner,
  type ArtifactFeedbackRegistration,
  type ArtifactFeedbackRegistry,
  type ArtifactFeedbackRejectReason,
  type ArtifactFeedbackRequest,
  type ArtifactFeedbackResult,
  type ArtifactFeedbackTarget,
} from "../../artifacts/feedback-contract";
import {
  ARTIFACT_COMMENTS_CALL_TIMEOUT_MS,
  ARTIFACT_COMMENTS_CAPS,
  ARTIFACT_COMMENTS_SEND_TIMEOUT_MS,
  ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS,
  type AnyArtifactFeedbackHandler,
  type ArtifactCommentsProvider,
} from "../../artifacts/feedback-contract-v2";
import { createCommentsClient, type ArtifactCommentsClient } from "./comments-client";
import { freezePlain } from "./freeze-plain";

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
  readonly handler: AnyArtifactFeedbackHandler;
  readonly inFlight: Set<InFlight>;
  /** Comments clients created by `commentsFor`; closed (in-flight calls settled as unavailable) when the handler is disposed. */
  readonly clients: Set<ReturnType<typeof createCommentsClient>>;
  live: boolean;
}

const PROVIDER_METHODS = ["list", "get", "save", "update", "remove", "adopt", "subscribe", "sendBatch"] as const;

/** A v2 handler must carry a complete provider; a half-built one is refused at registration instead of failing at first use. */
function isUsableProvider(value: unknown): value is ArtifactCommentsProvider {
  try {
    if (value === null || typeof value !== "object") return false;
    const provider = value as Record<string, unknown>;
    const capabilities = provider.capabilities as Record<string, unknown> | null | undefined;
    if (capabilities === null || typeof capabilities !== "object") return false;
    if (capabilities.pins !== true || capabilities.batchSend !== true || typeof capabilities.textEdit !== "boolean") return false;
    return PROVIDER_METHODS.every((method) => typeof provider[method] === "function");
  } catch {
    return false;
  }
}

/** Next animation frame in a window; a 16 ms timer elsewhere (unit tests, headless). */
function defaultScheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(callback, 16);
  return () => clearTimeout(handle);
}

/** Strips control characters (newlines and tabs become spaces) and caps the length. Untrusted text, render with textContent only. */
export function cleanFeedbackMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\t\n\r]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return cleaned.slice(0, MESSAGE_MAX_UNITS);
}

export { freezePlain };

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
  readonly contractVersions: readonly number[] = ARTIFACT_FEEDBACK_SUPPORTED_VERSIONS;
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private readonly commentsCallTimeoutMs: number;
  private readonly commentsSendTimeoutMs: number;
  private readonly scheduleFrame: (callback: () => void) => () => void;
  /** Live provider subscriptions per artifact root (ARTIFACT_COMMENTS_CAPS.maxSubscribersPerRoot). */
  private readonly subscriberCounts = new Map<string, number>();

  constructor(options: {
    timeoutMs?: number;
    enabled?: boolean;
    commentsCallTimeoutMs?: number;
    commentsSendTimeoutMs?: number;
    /** Test seam: runs the callback on the next frame and returns a cancel function. */
    scheduleFrame?: (callback: () => void) => () => void;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS;
    this.enabled = options.enabled ?? true;
    this.commentsCallTimeoutMs = options.commentsCallTimeoutMs ?? ARTIFACT_COMMENTS_CALL_TIMEOUT_MS;
    this.commentsSendTimeoutMs = options.commentsSendTimeoutMs ?? ARTIFACT_COMMENTS_SEND_TIMEOUT_MS;
    this.scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
  }

  register(owner: ArtifactFeedbackOwner, handler: AnyArtifactFeedbackHandler): ArtifactFeedbackRegistration {
    const failure = (status: "unsupported-version" | "conflict" | "invalid" | "unavailable", message: string): ArtifactFeedbackRegistration =>
      ({ status, message, dispose() {} });
    if (!this.enabled) return failure("unavailable", "Artifact feedback is not available on this host.");
    if (!handler || typeof handler !== "object" || typeof handler.submit !== "function") {
      return failure("invalid", "A feedback handler must be an object with a submit function.");
    }
    if (!this.contractVersions.includes(handler.contractVersion)) {
      return failure("unsupported-version", `Contract version ${String(handler.contractVersion)} is not supported (supported: ${this.contractVersions.join(", ")}).`);
    }
    if (handler.contractVersion === 2 && !isUsableProvider(handler.comments)) {
      return failure("invalid", "A contract v2 handler must provide a complete comments provider.");
    }
    if (this.entries.some((entry) => entry.owner.pluginId === owner.pluginId)) {
      return failure("conflict", `"${owner.pluginId}" already has a live feedback handler; dispose it first.`);
    }
    const entry: Entry = { owner: { pluginId: owner.pluginId, displayName: owner.displayName }, handler, inFlight: new Set(), clients: new Set(), live: true };
    this.entries.push(entry);
    this.notify();
    return {
      status: "registered",
      dispose: () => {
        if (!entry.live) return;
        entry.live = false;
        this.entries.splice(this.entries.indexOf(entry), 1);
        for (const client of [...entry.clients]) client.handlerGone();
        for (const flight of [...entry.inFlight]) {
          flight.settle({
            status: "rejected",
            reason: "unavailable",
            // Neutral and true: the plugin may already have issued the send. The handler is gone, so it cannot
            // supply its own message for this case.
            message: `${entry.owner.displayName} was unloaded before it answered. Check the thread to see whether your comment arrived.`,
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

  /**
   * Which plugin would receive a submission for this target and under which contract version (the rail and the Pin
   * button need the version; the popover copy keeps using `describeHandler`). Null when nothing handles the target.
   */
  describeRoute(target: ArtifactFeedbackTarget): { readonly displayName: string; readonly contractVersion: 1 | 2 } | null {
    const entry = this.resolve(target);
    return entry ? { displayName: entry.owner.displayName, contractVersion: entry.handler.contractVersion } : null;
  }

  /**
   * A comments client for the handler that would receive a submission for this target, or null when that handler is
   * not v2 (ADR 0006 Addendum 1, A2.2: Pin is offered only when the routed handler is v2; there is no fall-through to
   * a later v2 handler). One client per open view; the caller disposes it. The client belongs to the routed handler
   * and keeps working with it even if `canHandle` later changes; it ends when the handler is unregistered.
   */
  commentsFor(target: ArtifactFeedbackTarget): ArtifactCommentsClient | null {
    const entry = this.resolve(target);
    if (!entry || entry.handler.contractVersion !== 2) return null;
    const provider = entry.handler.comments;
    const root = target.root;
    const frozenTarget = freezePlain<ArtifactFeedbackTarget>({
      root: target.root, artifactId: target.artifactId, title: target.title, runtime: "static", vaultRead: target.vaultRead,
    });
    const client = createCommentsClient({
      owner: entry.owner,
      provider,
      target: frozenTarget,
      isLive: () => entry.live,
      callTimeoutMs: this.commentsCallTimeoutMs,
      sendTimeoutMs: this.commentsSendTimeoutMs,
      scheduleFrame: this.scheduleFrame,
      acquireSubscriberSlot: () => {
        const count = this.subscriberCounts.get(root) ?? 0;
        if (count >= ARTIFACT_COMMENTS_CAPS.maxSubscribersPerRoot) return false;
        this.subscriberCounts.set(root, count + 1);
        return true;
      },
      releaseSubscriberSlot: () => {
        const count = (this.subscriberCounts.get(root) ?? 1) - 1;
        if (count <= 0) this.subscriberCounts.delete(root); else this.subscriberCounts.set(root, count);
      },
      onClosed: () => { entry.clients.delete(client); },
    });
    entry.clients.add(client);
    return client;
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
      try {
        // The property read is inside the try: a throwing getter counts as "does not handle" too.
        const canHandle = entry.handler.canHandle;
        if (canHandle === undefined) return entry;
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

/**
 * What plugins see as `app.artifactFeedback`: presence, change notification and the supported versions, nothing
 * else. `register` and `submit` stay on the service, which Geode keeps on a separate internal reference, so a plugin
 * can only register through `Plugin.registerArtifactFeedbackHandler` (owner identity from its manifest).
 *
 * Routing note (ADR 0006 D1): the first registered handler whose `canHandle` passes receives the submission, with no
 * fall-through on a rejection, so an early plugin with no `canHandle` takes every static artifact. That is a
 * deliberate trade for exactly-one-recipient; plugins should set `canHandle`.
 */
export function createReadOnlyFeedbackView(service: ArtifactFeedbackService): ArtifactFeedbackRegistry {
  return Object.freeze({
    contractVersions: Object.freeze([...service.contractVersions]) as readonly number[],
    has: (target: ArtifactFeedbackTarget) => service.has(target),
    onDidChange: (listener: () => void) => service.onDidChange(listener),
  });
}
