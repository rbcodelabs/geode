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
import {
  messageWithinCap,
  validateGuestSelect,
  validateHoverMessage,
  validateRectMessage,
} from "../artifacts/selection-validator";

/**
 * Shared guest <-> embedder inspector transport and bounded screenshot encoder
 * used by both `ArtifactInspectorBridge` (ADR 0006) and `WebViewerInspectorBridge`
 * (ADR 0056).
 *
 * Pure renderer module: zero Electron, Node, or `src/main/*` runtime imports.
 */

export interface InspectorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

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
  /** Electron exposes the sending frame on `ipc-message`; sub-frame messages are dropped when present. */
  isMainFrame?: boolean;
}

export interface InspectorWebview {
  send(channel: string, ...args: unknown[]): void;
  addEventListener(type: "ipc-message", listener: (event: InspectorIpcEvent) => void): void;
  removeEventListener(type: "ipc-message", listener: (event: InspectorIpcEvent) => void): void;
  capturePage(rect?: InspectorRect): Promise<InspectorNativeImage>;
}

export type InspectorHover = InspectHoverMessage;

export interface CapturedElementScreenshot {
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly cssRect: InspectorRect;
  readonly devicePixelRatio: number;
  readonly downscaled: boolean;
}

export type CaptureOmittedReason = "too-large" | "capture-failed" | "empty-rect";

export const COMMENT_MAX_UNITS = 4000;
const RATE_WINDOW_MS = 1000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const READY_PER_SECOND = 10;
const CANCEL_PER_SECOND = 10;
const GUEST_CHANNELS: ReadonlySet<string> = new Set(INSPECT_GUEST_TO_EMBEDDER_CHANNELS);

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

/** Trims and bounds-checks a user comment (`1..4000` UTF-16 units), or returns `null`. */
export function cleanComment(comment: unknown): string | null {
  const trimmed = typeof comment === "string" ? comment.trim() : "";
  if (trimmed.length === 0 || trimmed.length > COMMENT_MAX_UNITS) return null;
  return trimmed;
}

/** Generates a 128-bit random `sel_<32 hex chars>` identifier. */
export function generateSelectionId(randomBytes: (length: number) => Uint8Array): string {
  return `sel_${[...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function cropForSelection(guest: GuestSelectMessage): InspectorRect | null {
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

function encodeScreenshot(
  image: InspectorNativeImage,
): { bytes: Uint8Array; width: number; height: number; downscaled: boolean } | "too-large" | null {
  try {
    if (image.isEmpty()) return null;
    const bytes = new Uint8Array(image.toPNG());
    const size = image.getSize();
    if (!isPng(bytes) || size.width <= 0 || size.height <= 0) return null;
    if (bytes.length <= INSPECTOR_SCREENSHOT.maxBytes) {
      return { bytes, width: size.width, height: size.height, downscaled: false };
    }
    for (const width of INSPECTOR_SCREENSHOT.downscaleWidths) {
      if (size.width <= width) continue;
      const resized = image.resize({ width });
      const smaller = new Uint8Array(resized.toPNG());
      const smallerSize = resized.getSize();
      if (
        isPng(smaller) &&
        smallerSize.width > 0 &&
        smallerSize.height > 0 &&
        smaller.length <= INSPECTOR_SCREENSHOT.maxBytes
      ) {
        return { bytes: smaller, width: smallerSize.width, height: smallerSize.height, downscaled: true };
      }
    }
    return "too-large";
  } catch {
    return null;
  }
}

function withCaptureTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capture timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Captures a cropped, `<= 512 KB` PNG screenshot of the selected element on `webview`,
 * verifying the PNG signature and downscaling via `[1024, 640]` widths if needed.
 */
export async function captureElementScreenshot(
  webview: InspectorWebview,
  guest: GuestSelectMessage,
): Promise<{ screenshot: CapturedElementScreenshot | null; omitted: CaptureOmittedReason | null }> {
  const none = (omitted: CaptureOmittedReason) => ({ screenshot: null, omitted });
  const crop = cropForSelection(guest);
  if (!crop) return none("empty-rect");
  let image: InspectorNativeImage;
  try {
    image = await withCaptureTimeout(webview.capturePage(crop), INSPECTOR_SCREENSHOT.captureTimeoutMs);
  } catch {
    return none("capture-failed");
  }
  const encoded = encodeScreenshot(image);
  if (encoded === "too-large") return none("too-large");
  if (encoded === null) return none("capture-failed");
  return {
    screenshot: {
      mimeType: "image/png",
      ...encoded,
      cssRect: crop,
      devicePixelRatio: guest.viewport.devicePixelRatio,
    },
    omitted: null,
  };
}

export interface ElementInspectorSessionOptions {
  webview: InspectorWebview;
  redacted: boolean;
  now?: () => number;
  callbacks: {
    onReady?(): void;
    onHover(hover: InspectorHover): void;
    onAcceptedSelect(guest: GuestSelectMessage, context: { token: number; generation: number }): void;
    onCancel(): void;
    onRect?(rect: InspectRectMessage): void;
    onAnchorResults?(payload: unknown): void;
    onAnchorRects?(payload: unknown): void;
  };
}

type BudgetKind =
  | "hover"
  | "ready"
  | "cancel"
  | "select"
  | "rect"
  | "anchorResults"
  | "anchorRects";

export class ElementInspectorSession {
  private readonly webview: InspectorWebview;
  private readonly redacted: boolean;
  private readonly now: () => number;
  private modeValue: InspectMode = "off";
  private disposed = false;
  private token = 0;
  private generation = 0;
  private readonly budgets: Record<BudgetKind, number[]> = {
    hover: [],
    ready: [],
    cancel: [],
    select: [],
    rect: [],
    anchorResults: [],
    anchorRects: [],
  };
  private readonly listener = (event: InspectorIpcEvent): void => this.onIpc(event);

  constructor(private readonly options: ElementInspectorSessionOptions) {
    this.webview = options.webview;
    this.redacted = options.redacted;
    this.now = options.now ?? (() => Date.now());
    this.webview.addEventListener("ipc-message", this.listener);
  }

  get mode(): InspectMode {
    return this.modeValue;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get currentToken(): number {
    return this.token;
  }

  get documentGeneration(): number {
    return this.generation;
  }

  setMode(mode: InspectMode): void {
    if (this.disposed) return;
    this.modeValue = mode;
    this.token++;
    this.sendMode();
  }

  sendMode(): void {
    this.safeSend(INSPECT_CHANNEL.mode, { mode: this.modeValue, redactText: this.redacted });
  }

  sendKey(key: InspectKey): void {
    if (this.disposed || this.modeValue !== "pick" || (key !== "parent" && key !== "child")) return;
    this.safeSend(INSPECT_CHANNEL.key, { key });
  }

  safeSend(channel: string, payload: unknown): void {
    try {
      this.webview.send(channel, payload);
    } catch {
      /* guest not ready or already gone */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.webview.removeEventListener("ipc-message", this.listener);
  }

  private onIpc(event: InspectorIpcEvent): void {
    if (this.disposed || !GUEST_CHANNELS.has(event.channel)) return;
    // Only this view's own webview, only its main frame.
    if (event.target !== this.webview || event.isMainFrame === false) return;

    // A select dropped while picking re-sends mode so the guest leaves its local hold.
    if (event.channel === INSPECT_CHANNEL.select) {
      if (this.modeValue !== "pick") return;
      if (!this.acceptSelect(event)) this.sendMode();
      return;
    }

    if (!Array.isArray(event.args) || event.args.length !== 1) return;
    const kind: BudgetKind =
      event.channel === INSPECT_CHANNEL.hover
        ? "hover"
        : event.channel === INSPECT_CHANNEL.ready
          ? "ready"
          : event.channel === INSPECT_CHANNEL.rect
            ? "rect"
            : event.channel === INSPECT_CHANNEL.anchorResults
              ? "anchorResults"
              : event.channel === INSPECT_CHANNEL.anchorRects
                ? "anchorRects"
                : "cancel";
    const limit =
      kind === "hover"
        ? INSPECTOR_CAPS.messagesPerSecond
        : kind === "ready"
          ? READY_PER_SECOND
          : kind === "rect"
            ? INSPECTOR_CAPS.rectsPerSecond
            : kind === "anchorResults"
              ? INSPECTOR_CAPS.anchorResultsPerSecond
              : kind === "anchorRects"
                ? INSPECTOR_CAPS.anchorRectsPerSecond
                : CANCEL_PER_SECOND;
    if (!this.withinRate(this.budgets[kind], limit)) return;
    const payload = event.args[0];
    if (!messageWithinCap(payload)) return;

    switch (event.channel) {
      case INSPECT_CHANNEL.ready: {
        if (typeof payload !== "object" || payload === null) return;
        const keys = Object.keys(payload);
        if (
          keys.length !== 1 ||
          keys[0] !== "protocol" ||
          (payload as { protocol?: unknown }).protocol !== INSPECT_PROTOCOL_VERSION
        ) {
          return;
        }
        this.generation++;
        this.sendMode();
        this.options.callbacks.onReady?.();
        return;
      }
      case INSPECT_CHANNEL.anchorResults: {
        this.options.callbacks.onAnchorResults?.(payload);
        return;
      }
      case INSPECT_CHANNEL.anchorRects: {
        this.options.callbacks.onAnchorRects?.(payload);
        return;
      }
      case INSPECT_CHANNEL.hover: {
        if (this.modeValue !== "pick") return;
        const hover = validateHoverMessage(payload);
        if (hover) this.options.callbacks.onHover(hover);
        return;
      }
      case INSPECT_CHANNEL.rect: {
        const report = validateRectMessage(payload);
        if (!report) return;
        if (
          (report.target === "hover" && this.modeValue !== "pick") ||
          (report.target === "selected" && this.modeValue !== "hold")
        ) {
          return;
        }
        this.options.callbacks.onRect?.(report);
        return;
      }
      case INSPECT_CHANNEL.cancel: {
        if (this.modeValue !== "pick" && this.modeValue !== "hold") return;
        if (
          typeof payload === "object" &&
          payload !== null &&
          Object.keys(payload).length === 1 &&
          (payload as { reason?: unknown }).reason === "escape"
        ) {
          this.options.callbacks.onCancel();
        }
        return;
      }
    }
  }

  private acceptSelect(event: InspectorIpcEvent): boolean {
    if (!Array.isArray(event.args) || event.args.length !== 1) return false;
    if (!this.withinRate(this.budgets.select, INSPECTOR_CAPS.selectsPerSecond)) return false;
    const payload = event.args[0];
    if (!messageWithinCap(payload)) return false;
    const guest = validateGuestSelect(payload, { redacted: this.redacted });
    if (!guest) return false;
    this.modeValue = "hold";
    const token = ++this.token;
    const generation = this.generation;
    this.options.callbacks.onAcceptedSelect(guest, { token, generation });
    return true;
  }

  private withinRate(window: number[], limit: number): boolean {
    const t = this.now();
    while (window.length > 0 && t - window[0]! >= RATE_WINDOW_MS) window.shift();
    if (window.length >= limit) return false;
    window.push(t);
    return true;
  }
}
