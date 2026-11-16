import {
  WEB_VIEWER_FEEDBACK_CONTRACT_VERSIONS,
  WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS,
  WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS,
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerFeedbackDelivery,
  type WebViewerFeedbackHandler,
  type WebViewerFeedbackOwner,
  type WebViewerFeedbackRegistration,
  type WebViewerFeedbackRegistry,
  type WebViewerFeedbackRejectReason,
  type WebViewerFeedbackRequest,
  type WebViewerFeedbackResult,
  type WebViewerPageTarget,
  type WebViewerThreadList,
  type WebViewerThreadOption,
} from "../../web-viewer/feedback-contract";
import { freezePlain } from "../artifacts/freeze-plain";

/**
 * Geode host implementation of the Web Viewer element feedback contract (ADR 0056).
 *
 * Pure renderer module: zero Electron, Node, or `src/main/*` runtime imports so
 * the mobile renderer bundle passes `mobileBoundaryPlugin` cleanly.
 *
 * Fault isolation: `canHandle`, `listThreads`, and `submit` are wrapped in
 * `try/catch` + `Promise.resolve` + `AbortController` + `console.warn` and are
 * NEVER routed through `Plugin.guard()` / `errorHandler`, so a handler bug or
 * timeout never quarantines `agent-threads`.
 */

export type WebViewerFeedbackOutcomeSource =
  | "handler"
  | "timeout"
  | "disposed"
  | "no-handler"
  | "invalid-result";

export type WebViewerFeedbackOutcome = WebViewerFeedbackResult & {
  readonly source: WebViewerFeedbackOutcomeSource;
};

export type WebViewerThreadListOutcome =
  | {
      readonly status: "ok";
      readonly value: WebViewerThreadList;
      readonly source: "handler";
    }
  | {
      readonly status: "rejected";
      readonly reason: WebViewerFeedbackRejectReason;
      readonly message: string;
      readonly source: WebViewerFeedbackOutcomeSource;
    };

const MESSAGE_MAX_UNITS = 500;
const THREAD_ID_MAX_UNITS = 256;
const THREAD_TITLE_MAX_UNITS = 160;
const THREAD_SUBTITLE_MAX_UNITS = 120;
const MAX_THREADS_RETURNED = 50;
const MAX_RAW_THREADS_SCANNED = 200;

const HOSTILE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const REJECT_REASONS: ReadonlySet<string> = new Set<WebViewerFeedbackRejectReason>([
  "busy",
  "invalid",
  "unsupported",
  "unavailable",
  "failed",
]);
const DELIVERIES: ReadonlySet<string> = new Set<WebViewerFeedbackDelivery>(["sent", "queued"]);

// C0 controls (\u0000-\u001f), DEL (\u007f), C1 controls (\u0080-\u009f), and
// Unicode bidi override/isolate/mark controls (\u061c, \u200e, \u200f, \u202a-\u202e, \u2066-\u2069).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_ID_CONTROLS = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Rebuilds a null-prototype bag strictly from own data descriptors.
 * Rejects arrays, null, hostile own keys, and any accessor (getter/setter)
 * WITHOUT invoking the getter. Prototype properties are ignored.
 */
function ownDataBag(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (HOSTILE_KEYS.has(key)) return null;
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !("value" in desc)) return null;
    out[key] = desc.value;
  }
  return out;
}

/**
 * Reads up to `maxScan` elements from an Array strictly via own data descriptors
 * so an index getter or sparse prototype trap never executes.
 */
function ownDataArray(value: unknown, maxScan: number): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const lenDesc = Object.getOwnPropertyDescriptor(value, "length");
  if (!lenDesc || !("value" in lenDesc) || typeof lenDesc.value !== "number") return null;
  const count = Math.min(lenDesc.value, maxScan);
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return null;
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !("value" in desc)) return null;
    out.push(desc.value);
  }
  return out;
}

/** Strips control and Unicode bidi characters (collapsing whitespace runs) and caps length. */
export function cleanWebViewerMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .slice(0, MESSAGE_MAX_UNITS * 2)
    .replace(/[\t\n\r]+/g, " ")
    .replace(UNSAFE_TEXT_CONTROLS, "");
  return cleaned.slice(0, MESSAGE_MAX_UNITS);
}

/** Sanitizes a human-facing thread label (`title` or `subtitle`). */
export function cleanThreadLabel(raw: string, maxUnits: number): string {
  return raw
    .slice(0, maxUnits * 2)
    .replace(/[\t\n\r]+/g, " ")
    .replace(UNSAFE_TEXT_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxUnits);
}

/** Sanitizes a thread ID (`1..256` UTF-16 units; returns `""` if over cap or empty). */
function cleanThreadId(raw: string): string {
  const cleaned = raw.slice(0, THREAD_ID_MAX_UNITS * 2).replace(UNSAFE_ID_CONTROLS, "").trim();
  if (cleaned.length === 0 || cleaned.length > THREAD_ID_MAX_UNITS) return "";
  return cleaned;
}

function normalizeThreadList(raw: unknown): WebViewerThreadList | null {
  const root = ownDataBag(raw);
  if (!root || typeof root.allowNewThread !== "boolean") return null;
  const rawThreads = ownDataArray(root.threads, MAX_RAW_THREADS_SCANNED);
  if (!rawThreads) return null;

  const threads: WebViewerThreadOption[] = [];
  const seenIds = new Set<string>();

  for (const rawItem of rawThreads) {
    const item = ownDataBag(rawItem);
    if (!item) return null;
    if (
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.active !== "boolean" ||
      typeof item.busy !== "boolean" ||
      typeof item.planMode !== "boolean" ||
      (item.subtitle !== undefined && typeof item.subtitle !== "string")
    ) {
      return null;
    }
    const id = cleanThreadId(item.id);
    if (!id || id === WEB_VIEWER_NEW_THREAD_ID || seenIds.has(id)) continue;
    const title = cleanThreadLabel(item.title, THREAD_TITLE_MAX_UNITS);
    if (!title) continue;
    const subtitle =
      item.subtitle !== undefined
        ? cleanThreadLabel(item.subtitle, THREAD_SUBTITLE_MAX_UNITS)
        : "";

    seenIds.add(id);
    const rebuilt: WebViewerThreadOption = subtitle
      ? {
          id,
          title,
          subtitle,
          active: item.active,
          busy: item.busy,
          planMode: item.planMode,
        }
      : {
          id,
          title,
          active: item.active,
          busy: item.busy,
          planMode: item.planMode,
        };
    threads.push(rebuilt);
    if (threads.length >= MAX_THREADS_RETURNED) break;
  }

  return freezePlain<WebViewerThreadList>({
    threads,
    allowNewThread: root.allowNewThread,
  });
}

interface InFlightSubmit {
  settle(outcome: WebViewerFeedbackOutcome): void;
  controller: AbortController;
}

interface InFlightThreads {
  settle(outcome: WebViewerThreadListOutcome): void;
  controller: AbortController;
}

interface Entry {
  readonly owner: WebViewerFeedbackOwner;
  readonly handler: WebViewerFeedbackHandler;
  readonly contractVersion: 1;
  readonly inFlightSubmits: Set<InFlightSubmit>;
  readonly inFlightThreads: Set<InFlightThreads>;
  live: boolean;
}

export class WebViewerFeedbackService implements WebViewerFeedbackRegistry {
  readonly contractVersions: readonly number[] = WEB_VIEWER_FEEDBACK_CONTRACT_VERSIONS;
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly enabled: boolean;
  private readonly submitTimeoutMs: number;
  private readonly threadsTimeoutMs: number;

  constructor(
    options: {
      enabled?: boolean;
      submitTimeoutMs?: number;
      threadsTimeoutMs?: number;
    } = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.submitTimeoutMs = options.submitTimeoutMs ?? WEB_VIEWER_FEEDBACK_SUBMIT_TIMEOUT_MS;
    this.threadsTimeoutMs = options.threadsTimeoutMs ?? WEB_VIEWER_FEEDBACK_THREADS_TIMEOUT_MS;
  }

  register(
    owner: WebViewerFeedbackOwner,
    handler: WebViewerFeedbackHandler,
  ): WebViewerFeedbackRegistration {
    const failure = (
      status: "unsupported-version" | "conflict" | "invalid" | "unavailable",
      message: string,
    ): WebViewerFeedbackRegistration => ({ status, message, dispose() {} });

    if (!this.enabled) {
      return failure("unavailable", "Web Viewer feedback is not available on this host.");
    }

    let version: unknown;
    try {
      if (
        !handler ||
        typeof handler !== "object" ||
        Array.isArray(handler) ||
        typeof handler.submit !== "function" ||
        typeof handler.listThreads !== "function"
      ) {
        return failure(
          "invalid",
          "A Web Viewer feedback handler must be an object with listThreads and submit functions.",
        );
      }
      version = handler.contractVersion;
      if (typeof version !== "number" || !this.contractVersions.includes(version)) {
        return failure(
          "unsupported-version",
          `Contract version ${String(version)} is not supported (supported: ${this.contractVersions.join(", ")}).`,
        );
      }
    } catch {
      return failure("invalid", "The Web Viewer feedback handler could not be read.");
    }

    if (this.entries.some((entry) => entry.owner.pluginId === owner.pluginId)) {
      return failure(
        "conflict",
        `"${owner.pluginId}" already has a live Web Viewer feedback handler; dispose it first.`,
      );
    }

    const entry: Entry = {
      owner: { pluginId: owner.pluginId, displayName: owner.displayName },
      handler,
      contractVersion: version as 1,
      inFlightSubmits: new Set(),
      inFlightThreads: new Set(),
      live: true,
    };
    this.entries.push(entry);
    this.notify();

    return {
      status: "registered",
      dispose: () => {
        if (!entry.live) return;
        entry.live = false;
        const idx = this.entries.indexOf(entry);
        if (idx !== -1) this.entries.splice(idx, 1);

        for (const flight of [...entry.inFlightThreads]) {
          flight.settle({
            status: "rejected",
            reason: "unavailable",
            message: `${entry.owner.displayName} was unloaded before threads could be listed.`,
            source: "disposed",
          });
        }
        for (const flight of [...entry.inFlightSubmits]) {
          flight.settle({
            status: "rejected",
            reason: "unavailable",
            message: `${entry.owner.displayName} was unloaded before it answered. Check the thread to see whether your comment arrived.`,
            source: "disposed",
          });
        }
        this.notify();
      },
    };
  }

  has(target: WebViewerPageTarget): boolean {
    return this.resolve(target) !== null;
  }

  hasAnyHandler(): boolean {
    return this.entries.length > 0;
  }

  /** Display name of the plugin that would handle `target`, or `null`. */
  describeHandler(target: WebViewerPageTarget): string | null {
    return this.resolve(target)?.owner.displayName ?? null;
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listThreads(target: WebViewerPageTarget): Promise<WebViewerThreadListOutcome> {
    const entry = this.resolve(target);
    if (!entry) {
      return Promise.resolve({
        status: "rejected",
        reason: "unavailable",
        message: "Nothing can receive Web Viewer feedback right now.",
        source: "no-handler",
      });
    }
    const name = entry.owner.displayName;
    const frozenTarget = freezePlain<WebViewerPageTarget>({
      url: target.url,
      origin: target.origin,
      title: target.title,
    });

    return new Promise<WebViewerThreadListOutcome>((resolve) => {
      const controller = new AbortController();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flight: InFlightThreads = {
        controller,
        settle: (outcome) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          entry.inFlightThreads.delete(flight);
          if (outcome.status === "rejected" && outcome.source !== "handler" && outcome.source !== "invalid-result") {
            controller.abort();
          }
          resolve(outcome);
        },
      };
      entry.inFlightThreads.add(flight);
      timer = setTimeout(() => {
        console.warn(
          `[web-viewer-feedback] "${entry.owner.pluginId}" listThreads did not answer within ${this.threadsTimeoutMs} ms`,
        );
        flight.settle({
          status: "rejected",
          reason: "failed",
          message: `No thread list from ${name} in ${Math.round(this.threadsTimeoutMs / 1000)} s.`,
          source: "timeout",
        });
      }, this.threadsTimeoutMs);

      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(entry.handler.listThreads(frozenTarget, { signal: controller.signal }));
      } catch (error) {
        console.warn(`[web-viewer-feedback] "${entry.owner.pluginId}" listThreads threw`, error);
        flight.settle({
          status: "rejected",
          reason: "failed",
          message: `${name} could not list threads.`,
          source: "handler",
        });
        return;
      }

      promise.then(
        (raw) => {
          const normalized = normalizeThreadList(raw);
          if (!normalized) {
            console.warn(
              `[web-viewer-feedback] "${entry.owner.pluginId}" listThreads returned a malformed result`,
              raw,
            );
            flight.settle({
              status: "rejected",
              reason: "failed",
              message: `${name} returned an invalid thread list.`,
              source: "invalid-result",
            });
            return;
          }
          flight.settle({ status: "ok", value: normalized, source: "handler" });
        },
        (error) => {
          console.warn(`[web-viewer-feedback] "${entry.owner.pluginId}" listThreads rejected`, error);
          flight.settle({
            status: "rejected",
            reason: "failed",
            message: `${name} could not list threads.`,
            source: "handler",
          });
        },
      );
    });
  }

  submit(target: WebViewerPageTarget, request: WebViewerFeedbackRequest): Promise<WebViewerFeedbackOutcome> {
    const entry = this.resolve(target);
    if (!entry) {
      return Promise.resolve({
        status: "rejected",
        reason: "unavailable",
        message: "Nothing can receive this feedback right now.",
        source: "no-handler",
      });
    }
    const name = entry.owner.displayName;
    // Fresh screenshot bytes slice per attempt so handler mutation/transfer cannot corrupt retries.
    const clonedRequest: WebViewerFeedbackRequest = {
      contractVersion: 1,
      page: {
        url: request.page.url,
        origin: request.page.origin,
        title: request.page.title,
      },
      threadId: request.threadId,
      comment: request.comment,
      selection: request.selection,
      screenshot: request.screenshot
        ? {
            mimeType: "image/png",
            bytes: request.screenshot.bytes.slice(),
            width: request.screenshot.width,
            height: request.screenshot.height,
            cssRect: { ...request.screenshot.cssRect },
            devicePixelRatio: request.screenshot.devicePixelRatio,
            downscaled: request.screenshot.downscaled,
          }
        : null,
      screenshotOmitted: request.screenshotOmitted,
      stale: request.stale,
      submittedAt: request.submittedAt,
    };
    const frozen = freezePlain(clonedRequest);

    return new Promise<WebViewerFeedbackOutcome>((resolve) => {
      const controller = new AbortController();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flight: InFlightSubmit = {
        controller,
        settle: (outcome) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          entry.inFlightSubmits.delete(flight);
          if (outcome.source !== "handler" && outcome.source !== "invalid-result") {
            controller.abort();
          }
          resolve(outcome);
        },
      };
      entry.inFlightSubmits.add(flight);
      timer = setTimeout(() => {
        console.warn(
          `[web-viewer-feedback] "${entry.owner.pluginId}" submit did not answer within ${this.submitTimeoutMs} ms`,
        );
        flight.settle({
          status: "rejected",
          reason: "failed",
          message: `No response from ${name} in ${Math.round(this.submitTimeoutMs / 1000)} s. It may have been received; check the thread before retrying. Retry reuses the same selection id.`,
          source: "timeout",
        });
      }, this.submitTimeoutMs);

      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(entry.handler.submit(frozen, { signal: controller.signal }));
      } catch (error) {
        console.warn(`[web-viewer-feedback] "${entry.owner.pluginId}" submit threw`, error);
        flight.settle({
          status: "rejected",
          reason: "failed",
          message: `${name} could not take this feedback.`,
          source: "handler",
        });
        return;
      }

      promise.then(
        (result) => flight.settle(this.normalizeSubmitResult(entry, result)),
        (error) => {
          console.warn(`[web-viewer-feedback] "${entry.owner.pluginId}" submit rejected`, error);
          flight.settle({
            status: "rejected",
            reason: "failed",
            message: `${name} could not take this feedback.`,
            source: "handler",
          });
        },
      );
    });
  }

  private resolve(target: WebViewerPageTarget): Entry | null {
    if (!target || typeof target !== "object") return null;
    const frozenTarget = freezePlain<WebViewerPageTarget>({
      url: target.url,
      origin: target.origin,
      title: target.title,
    });
    for (const entry of this.entries) {
      try {
        const canHandle = entry.handler.canHandle;
        if (canHandle === undefined) return entry;
        if (canHandle.call(entry.handler, frozenTarget) === true) return entry;
      } catch {
        // Visibility checks run frequently; treat throws as false without spamming logs.
      }
    }
    return null;
  }

  private normalizeSubmitResult(entry: Entry, raw: unknown): WebViewerFeedbackOutcome {
    const bad = (): WebViewerFeedbackOutcome => {
      console.warn(`[web-viewer-feedback] "${entry.owner.pluginId}" returned a malformed result`, raw);
      return {
        status: "rejected",
        reason: "failed",
        message: `${entry.owner.displayName} returned an invalid response.`,
        source: "invalid-result",
      };
    };

    const bag = ownDataBag(raw);
    if (!bag) return bad();

    const status = bag.status;
    if (status === "accepted") {
      const delivery = bag.delivery;
      const rawThreadId = bag.threadId;
      if (typeof delivery !== "string" || !DELIVERIES.has(delivery) || typeof rawThreadId !== "string") {
        return bad();
      }
      const threadId = cleanThreadId(rawThreadId);
      if (!threadId) return bad();
      if (bag.message !== undefined && typeof bag.message !== "string") return bad();
      const cleanedMessage = cleanWebViewerMessage(bag.message);
      return freezePlain<WebViewerFeedbackOutcome>(
        cleanedMessage
          ? {
              status: "accepted",
              delivery: delivery as WebViewerFeedbackDelivery,
              threadId,
              message: cleanedMessage,
              source: "handler",
            }
          : {
              status: "accepted",
              delivery: delivery as WebViewerFeedbackDelivery,
              threadId,
              source: "handler",
            },
      );
    }

    if (status === "rejected") {
      const reason = bag.reason;
      const message = bag.message;
      if (typeof reason !== "string" || !REJECT_REASONS.has(reason) || typeof message !== "string") {
        return bad();
      }
      return freezePlain<WebViewerFeedbackOutcome>({
        status: "rejected",
        reason: reason as WebViewerFeedbackRejectReason,
        message: cleanWebViewerMessage(message) ?? "",
        source: "handler",
      });
    }

    return bad();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("[web-viewer-feedback] onDidChange listener threw", error);
      }
    }
  }
}

/**
 * Frozen read-only view exposed at `app.webViewerFeedback`.
 * `register`, `listThreads`, and `submit` remain on `app.webViewerFeedbackService`
 * so plugins can only register via `Plugin.registerWebViewerFeedbackHandler`
 * with manifest-derived owner identity.
 */
export function createReadOnlyWebViewerFeedbackView(
  service: WebViewerFeedbackService,
): WebViewerFeedbackRegistry {
  return Object.freeze({
    contractVersions: Object.freeze([...service.contractVersions]) as readonly number[],
    has: (target: WebViewerPageTarget) => service.has(target),
    onDidChange: (listener: () => void) => service.onDidChange(listener),
  });
}
