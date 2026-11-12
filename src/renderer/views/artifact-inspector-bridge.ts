import type {
  ArtifactFeedbackRequest,
  ArtifactFeedbackTarget,
  ArtifactViewportPreset,
  ElementScreenshot,
  ElementSelection,
  Rect,
  ScreenshotOmittedReason,
} from "../../artifacts/feedback-contract";
import {
  INSPECT_CHANNEL,
  INSPECT_GUEST_TO_EMBEDDER_CHANNELS,
  INSPECT_PROTOCOL_VERSION,
  INSPECTOR_CAPS,
  INSPECTOR_SCREENSHOT,
  type GuestSelectMessage,
  type InspectHoverMessage,
  type InspectKey,
  type InspectMode,
  type InspectRectMessage,
} from "../../artifacts/inspector-protocol";
import type { ArtifactRegistration } from "../../main/artifact-runtime";
import { freezePlain, type ArtifactFeedbackOutcome } from "../artifacts/feedback-registry";
import { messageWithinCap, validateGuestSelect, validateHoverMessage, validateRectMessage } from "../artifacts/selection-validator";

/**
 * Renderer-side bridge between one artifact `<webview>` and the plugin feedback
 * registry (ADR 0006 D3/D6/D8). UI-free: the view owns the toolbar, overlay and
 * popover, and drives this class through a small typed surface:
 *
 *   setMode("pick" | "hold" | "off")   tell the guest what to do (re-sent on every document start)
 *   callbacks.onHover(hover)           pointer or keyboard hover: tag + rect (+ label for keyboard)
 *   callbacks.onSelect(snapshot)       a validated selection with its screenshot; the bridge is now in "hold"
 *   callbacks.onCancel()               the guest saw Escape
 *   sendKey("parent" | "child")        forward [ and ] when focus is in the embedder chrome
 *   submit(snapshot, comment)          route the comment + selection to the plugin; returns the outcome
 *   dispose()
 *
 * Everything from the guest is untrusted data: accepted only from this webview,
 * only in the matching mode, size/rate capped, validated and REBUILT from an
 * allowlist; this class generates the selection id and every origin-E field.
 */

export interface InspectorNativeImage {
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  resize(options: { width: number }): InspectorNativeImage;
}
export interface InspectorIpcEvent {
  channel: string;
  args: unknown[];
  target?: unknown;
  /** Electron exposes the sending frame on `ipc-message`; a sub-frame message is dropped when present. */
  isMainFrame?: boolean;
}
export interface InspectorWebview {
  send(channel: string, ...args: unknown[]): void;
  addEventListener(type: "ipc-message", listener: (event: InspectorIpcEvent) => void): void;
  removeEventListener(type: "ipc-message", listener: (event: InspectorIpcEvent) => void): void;
  capturePage(rect?: Rect): Promise<InspectorNativeImage>;
}
export interface SelectionSnapshot {
  readonly selection: ElementSelection;
  readonly screenshot: ElementScreenshot | null;
  /** Non-null iff `screenshot` is null. */
  readonly screenshotOmitted: ScreenshotOmittedReason | null;
}
export type InspectorHover = InspectHoverMessage;

export interface ArtifactInspectorBridgeOptions {
  webview: InspectorWebview;
  registration: Pick<ArtifactRegistration, "registrationId" | "artifactId" | "vault">;
  target: ArtifactFeedbackTarget;
  registry: { submit(target: ArtifactFeedbackTarget, request: ArtifactFeedbackRequest): Promise<ArtifactFeedbackOutcome> };
  /** The view's last observed runtime revision. */
  getRevision(): number;
  getViewportPreset(): ArtifactViewportPreset;
  callbacks: {
    onHover(hover: InspectorHover): void;
    onSelect(snapshot: SelectionSnapshot): void;
    onCancel(): void;
    /** Phase 2a: the live rect of the hovered element (pick) or the selected one (hold); `connected: false` means it left the page. */
    onRect?(rect: InspectRectMessage): void;
  };
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

const COMMENT_MAX_UNITS = 4000;
const RATE_WINDOW_MS = 1000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const READY_PER_SECOND = 10;
const CANCEL_PER_SECOND = 10;
const GUEST_CHANNELS: ReadonlySet<string> = new Set(INSPECT_GUEST_TO_EMBEDDER_CHANNELS);

/** The data-only description of an artifact that routing and the visibility check use. */
export function artifactFeedbackTarget(
  registration: Pick<ArtifactRegistration, "artifactId" | "title" | "vault">,
  root: string,
): ArtifactFeedbackTarget {
  // Frozen: the same object is handed to every handler's canHandle and spread into each request.
  return Object.freeze({ root, artifactId: registration.artifactId, title: registration.title, runtime: "static" as const, vaultRead: registration.vault !== undefined });
}

/** Pick button visibility, minus view-local conditions (attached webview, no load error). */
export function isPickAvailable(
  registration: Pick<ArtifactRegistration, "runtime" | "inspector"> | null,
  registry: { has(target: ArtifactFeedbackTarget): boolean },
  target: ArtifactFeedbackTarget,
): boolean {
  return registration !== null && registration.runtime === "static" && registration.inspector !== undefined && registry.has(target);
}

const isPng = (bytes: Uint8Array): boolean => bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

export class ArtifactInspectorBridge {
  private readonly webview: InspectorWebview;
  private readonly redacted: boolean;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private currentMode: InspectMode = "off";
  private disposed = false;
  private token = 0;
  /** Bumped on every guest `ready`, i.e. every document start; a selection from an older document is stale. */
  private documentGeneration = 0;
  // Separate sliding-window budgets (ADR: hover 30/s, select 4/s) so a pointer sweep can never starve the click.
  private readonly budgets: Record<"hover" | "ready" | "cancel" | "select" | "rect", number[]> = { hover: [], ready: [], cancel: [], select: [], rect: [] };
  private readonly generationOf = new WeakMap<SelectionSnapshot, number>();
  private readonly listener = (event: InspectorIpcEvent): void => this.onIpc(event);

  constructor(private readonly options: ArtifactInspectorBridgeOptions) {
    this.webview = options.webview;
    this.redacted = options.registration.vault !== undefined;
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
    // Always attached: the inspector must work for artifacts without a vault grant too.
    this.webview.addEventListener("ipc-message", this.listener);
  }

  get mode(): InspectMode { return this.currentMode; }

  setMode(mode: InspectMode): void {
    if (this.disposed) return;
    this.currentMode = mode;
    this.token++; // anything still in flight for an earlier mode is dropped
    this.sendMode();
  }

  sendKey(key: InspectKey): void {
    if (this.disposed || this.currentMode !== "pick" || (key !== "parent" && key !== "child")) return;
    this.safeSend(INSPECT_CHANNEL.key, { key });
  }

  /**
   * Routes the user's comment plus the selection (and its screenshot) to the plugin that handles this artifact.
   * Retrying with the same snapshot re-uses the same selectionId. Never rejects.
   */
  async submit(snapshot: SelectionSnapshot, comment: string): Promise<ArtifactFeedbackOutcome> {
    const trimmed = typeof comment === "string" ? comment.trim() : "";
    if (trimmed.length === 0 || trimmed.length > COMMENT_MAX_UNITS) {
      return { status: "rejected", reason: "invalid", message: `Enter a comment of 1 to ${COMMENT_MAX_UNITS} characters.`, source: "invalid-result" };
    }
    if (snapshot.selection.viewSessionId !== this.options.registration.registrationId) {
      return { status: "rejected", reason: "invalid", message: "This selection belongs to a different preview.", source: "invalid-result" };
    }
    const generation = this.generationOf.get(snapshot);
    const stale = this.options.getRevision() !== snapshot.selection.artifactRevision
      || (generation !== undefined && generation !== this.documentGeneration);
    const request: ArtifactFeedbackRequest = {
      contractVersion: 1,
      artifact: { ...this.options.target },
      comment: trimmed,
      selection: snapshot.selection,
      // A copy per attempt: a handler that transfers or zero-fills the bytes cannot corrupt a retry.
      screenshot: snapshot.screenshot ? { ...snapshot.screenshot, bytes: snapshot.screenshot.bytes.slice() } : null,
      screenshotOmitted: snapshot.screenshotOmitted,
      stale,
      submittedAt: new Date(this.now()).toISOString(),
    };
    try {
      return await this.options.registry.submit(this.options.target, request);
    } catch (error) {
      console.warn("[artifact-feedback] submit failed", error);
      return { status: "rejected", reason: "failed", message: "The feedback could not be sent.", source: "handler" };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.webview.removeEventListener("ipc-message", this.listener);
  }

  // ---- guest messages ----

  private onIpc(event: InspectorIpcEvent): void {
    if (this.disposed || !GUEST_CHANNELS.has(event.channel)) return;
    // Only this view's own webview, only its top frame.
    if (event.target !== this.webview || event.isMainFrame === false) return;

    // A select this bridge cannot use must never leave the guest in its local hold (it entered hold when it sent
    // the select). While the user is in pick mode, any dropped select re-sends the mode so clicking works again.
    if (event.channel === INSPECT_CHANNEL.select) {
      if (this.currentMode !== "pick") return;
      if (!this.acceptSelect(event)) this.sendMode();
      return;
    }

    if (!Array.isArray(event.args) || event.args.length !== 1) return;
    const kind = event.channel === INSPECT_CHANNEL.hover ? "hover"
      : event.channel === INSPECT_CHANNEL.ready ? "ready"
      : event.channel === INSPECT_CHANNEL.rect ? "rect"
      : "cancel";
    const limit = kind === "hover" ? INSPECTOR_CAPS.messagesPerSecond
      : kind === "ready" ? READY_PER_SECOND
      : kind === "rect" ? INSPECTOR_CAPS.rectsPerSecond
      : CANCEL_PER_SECOND;
    if (!this.withinRate(this.budgets[kind], limit)) return;
    const payload = event.args[0];
    if (!messageWithinCap(payload)) return;

    switch (event.channel) {
      case INSPECT_CHANNEL.ready: {
        if (typeof payload !== "object" || payload === null) return;
        const keys = Object.keys(payload);
        if (keys.length !== 1 || keys[0] !== "protocol" || (payload as { protocol?: unknown }).protocol !== INSPECT_PROTOCOL_VERSION) return;
        this.documentGeneration++;
        this.sendMode(); // the guest starts every document in "off"; tell it what the user wants
        return;
      }
      case INSPECT_CHANNEL.hover: {
        if (this.currentMode !== "pick") return;
        const hover = validateHoverMessage(payload);
        if (hover) this.options.callbacks.onHover(hover);
        return;
      }
      case INSPECT_CHANNEL.rect: {
        // A hover rect only matters while picking, a selected rect only while the popover holds a selection.
        const report = validateRectMessage(payload);
        if (!report) return;
        if ((report.target === "hover" && this.currentMode !== "pick") || (report.target === "selected" && this.currentMode !== "hold")) return;
        this.options.callbacks.onRect?.(report);
        return;
      }
      case INSPECT_CHANNEL.cancel: {
        if (this.currentMode !== "pick" && this.currentMode !== "hold") return;
        if (typeof payload === "object" && payload !== null && Object.keys(payload).length === 1 && (payload as { reason?: unknown }).reason === "escape") {
          this.options.callbacks.onCancel();
        }
        return;
      }
    }
  }

  /** Validates and starts handling a select. Returns false when it was dropped for any reason. */
  private acceptSelect(event: InspectorIpcEvent): boolean {
    if (!Array.isArray(event.args) || event.args.length !== 1) return false;
    if (!this.withinRate(this.budgets.select, INSPECTOR_CAPS.selectsPerSecond)) return false;
    const payload = event.args[0];
    if (!messageWithinCap(payload)) return false;
    const guest = validateGuestSelect(payload, { redacted: this.redacted });
    if (!guest) return false;
    void this.onSelect(guest);
    return true;
  }

  private async onSelect(guest: GuestSelectMessage): Promise<void> {
    // One selection at a time: from here the guest and the embedder are in hold until the UI says otherwise.
    this.currentMode = "hold";
    const token = ++this.token;
    const selection = this.buildSelection(guest);
    const generation = this.documentGeneration;
    const shot = await this.screenshot(guest);
    if (this.disposed || token !== this.token) return;
    const snapshot: SelectionSnapshot = Object.freeze({ selection, screenshot: shot.screenshot, screenshotOmitted: shot.omitted });
    this.generationOf.set(snapshot, generation);
    this.options.callbacks.onSelect(snapshot);
  }

  private buildSelection(guest: GuestSelectMessage): ElementSelection {
    const { viewport: box } = guest.boundingBox;
    const selection: ElementSelection = {
      schemaVersion: 1,
      selectionId: `sel_${[...this.randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      artifactId: this.options.registration.artifactId,
      artifactRevision: this.options.getRevision(),
      viewSessionId: this.options.registration.registrationId,
      viewportPreset: this.options.getViewportPreset(),
      capturedAt: new Date(this.now()).toISOString(),
      redacted: this.redacted,
      route: guest.route,
      tag: guest.tag,
      selector: guest.selector,
      selectorAlternates: guest.selectorAlternates,
      textAnchor: guest.textAnchor,
      landmark: guest.landmark,
      outerHTML: guest.outerHTML,
      ancestors: guest.ancestors,
      computedStyles: guest.computedStyles,
      boundingBox: {
        viewport: box,
        document: { x: box.x + guest.viewport.scrollX, y: box.y + guest.viewport.scrollY, width: box.width, height: box.height },
      },
      viewport: guest.viewport,
      a11y: guest.a11y,
    };
    return freezePlain(selection);
  }

  // ---- screenshot (ADR D6) ----

  private async screenshot(guest: GuestSelectMessage): Promise<{ screenshot: ElementScreenshot | null; omitted: ScreenshotOmittedReason | null }> {
    const none = (omitted: ScreenshotOmittedReason) => ({ screenshot: null, omitted });
    if (this.redacted) return none("vault-read"); // never capture pixels of a vault-reading artifact
    const crop = this.cropFor(guest);
    if (!crop) return none("empty-rect");
    let image: InspectorNativeImage;
    try {
      image = await this.withTimeout(this.webview.capturePage(crop), INSPECTOR_SCREENSHOT.captureTimeoutMs);
    } catch {
      return none("capture-failed");
    }
    const encoded = this.encode(image);
    if (encoded === "too-large") return none("too-large");
    if (encoded === null) return none("capture-failed");
    return {
      screenshot: { mimeType: "image/png", ...encoded, cssRect: crop, devicePixelRatio: guest.viewport.devicePixelRatio },
      omitted: null,
    };
  }

  private cropFor(guest: GuestSelectMessage): Rect | null {
    const { viewport: box } = guest.boundingBox;
    const pad = INSPECTOR_SCREENSHOT.paddingPx;
    const x0 = Math.max(0, box.x - pad);
    const y0 = Math.max(0, box.y - pad);
    const x1 = Math.min(guest.viewport.width, box.x + box.width + pad);
    const y1 = Math.min(guest.viewport.height, box.y + box.height + pad);
    if (x1 <= x0 || y1 <= y0) return null;
    const x = Math.floor(x0);
    const y = Math.floor(y0);
    return { x, y, width: Math.ceil(x1) - x, height: Math.ceil(y1) - y };
  }

  private encode(image: InspectorNativeImage): { bytes: Uint8Array; width: number; height: number; downscaled: boolean } | "too-large" | null {
    try {
      if (image.isEmpty()) return null;
      const bytes = new Uint8Array(image.toPNG()); // a plain copy, never a pooled Buffer
      const size = image.getSize();
      if (!isPng(bytes)) return null;
      if (bytes.length <= INSPECTOR_SCREENSHOT.maxBytes) return { bytes, width: size.width, height: size.height, downscaled: false };
      for (const width of INSPECTOR_SCREENSHOT.downscaleWidths) {
        if (size.width <= width) continue;
        const resized = image.resize({ width });
        const smaller = new Uint8Array(resized.toPNG());
        const smallerSize = resized.getSize();
        if (isPng(smaller) && smaller.length <= INSPECTOR_SCREENSHOT.maxBytes) {
          return { bytes: smaller, width: smallerSize.width, height: smallerSize.height, downscaled: true };
        }
      }
      return "too-large";
    } catch {
      return null;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("capture timed out")), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  // ---- plumbing ----

  private withinRate(window: number[], limit: number): boolean {
    const t = this.now();
    while (window.length > 0 && t - window[0]! >= RATE_WINDOW_MS) window.shift();
    if (window.length >= limit) return false;
    window.push(t);
    return true;
  }

  private sendMode(): void {
    this.safeSend(INSPECT_CHANNEL.mode, { mode: this.currentMode, redactText: this.redacted });
  }

  private safeSend(channel: string, payload: unknown): void {
    try { this.webview.send(channel, payload); } catch { /* guest not ready or already gone */ }
  }
}
