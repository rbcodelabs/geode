import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSPECT_CHANNEL,
  INSPECTOR_CAPS,
  INSPECTOR_SCREENSHOT,
  type GuestSelectMessage,
} from "../../src/artifacts/inspector-protocol";
import {
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerFeedbackRequest,
  type WebViewerPageTarget,
  type WebViewerViewportPreset,
} from "../../src/web-viewer/feedback-contract";
import {
  WebViewerInspectorBridge,
  type InspectorIpcEvent,
  type InspectorNativeImage,
  type WebViewerSelectionSnapshot,
} from "../../src/renderer/views/web-viewer-inspector-bridge";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_SIG);
  return bytes;
};

class FakeImage implements InspectorNativeImage {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly bytes: Uint8Array,
    private readonly resized: Record<number, FakeImage> = {},
    private readonly empty = false,
  ) {}
  toPNG(): Uint8Array {
    return this.bytes;
  }
  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
  isEmpty(): boolean {
    return this.empty;
  }
  resize({ width }: { width: number }): InspectorNativeImage {
    const next = this.resized[width];
    if (!next) throw new Error(`unexpected resize width ${width}`);
    return next;
  }
}

class FakeWebview {
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];
  private readonly listeners = new Set<(event: InspectorIpcEvent) => void>();
  captures: Array<{ x: number; y: number; width: number; height: number } | undefined> = [];
  captureImpl: (rect?: { x: number; y: number; width: number; height: number }) => Promise<InspectorNativeImage> =
    async () => new FakeImage(96, 46, png(2048));

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }
  addEventListener(_type: "ipc-message", listener: (event: InspectorIpcEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "ipc-message", listener: (event: InspectorIpcEvent) => void): void {
    this.listeners.delete(listener);
  }
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<InspectorNativeImage> {
    this.captures.push(rect);
    return this.captureImpl(rect);
  }
  emit(channel: string, payload?: unknown, extra: Partial<InspectorIpcEvent> = {}): void {
    for (const listener of [...this.listeners]) {
      listener({ channel, args: payload === undefined ? [] : [payload], target: this, ...extra });
    }
  }
  modes(): unknown[] {
    return this.sent.filter((m) => m.channel === INSPECT_CHANNEL.mode).map((m) => m.args[0]);
  }
}

const makeGuestSelect = (over: Partial<GuestSelectMessage> = {}): GuestSelectMessage => ({
  route: "/pricing#pro",
  tag: "button",
  selector: "#upgrade",
  selectorAlternates: [".cta-btn"],
  textAnchor: { tag: "button", text: "Upgrade now" },
  landmark: "Pro plan",
  outerHTML: { html: '<button id="upgrade">Upgrade now</button>', truncated: false },
  ancestors: [{ tag: "section", id: "pricing", classes: ["tier"] }],
  computedStyles: { display: "inline-flex", color: "rgb(255, 255, 255)" },
  boundingBox: { viewport: { x: 100, y: 200, width: 120, height: 44 } },
  viewport: { width: 390, height: 844, devicePixelRatio: 2, scrollX: 0, scrollY: 150 },
  a11y: { role: "button", name: "Upgrade now", tabIndex: 0 },
  ...over,
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

let clock = 1_731_672_000_000;
let currentPage: WebViewerPageTarget | null;
let currentPreset: WebViewerViewportPreset;

function setup() {
  const webview = new FakeWebview();
  const submitted: Array<{ target: WebViewerPageTarget; request: WebViewerFeedbackRequest }> = [];
  const registry = {
    submit: vi.fn(async (target: WebViewerPageTarget, request: WebViewerFeedbackRequest) => {
      submitted.push({ target, request });
      return {
        status: "accepted" as const,
        delivery: "sent" as const,
        threadId: request.threadId === WEB_VIEWER_NEW_THREAD_ID ? "thread-created" : request.threadId,
        source: "handler" as const,
      };
    }),
  };
  const hovers: unknown[] = [];
  const rects: unknown[] = [];
  const selections: WebViewerSelectionSnapshot[] = [];
  let cancels = 0;
  let byteSeed = 0;

  const bridge = new WebViewerInspectorBridge({
    webview,
    viewSessionId: "wv-session-42",
    registry,
    getPageTarget: () => currentPage,
    getViewportPreset: () => currentPreset,
    callbacks: {
      onHover: (h) => hovers.push(h),
      onSelect: (s) => selections.push(s),
      onCancel: () => {
        cancels++;
      },
      onRect: (r) => rects.push(r),
    },
    now: () => clock,
    randomBytes: (len) => Uint8Array.from({ length: len }, () => (byteSeed++ * 17 + 5) & 0xff),
  });

  return { webview, bridge, registry, submitted, hovers, rects, selections, cancels: () => cancels };
}

beforeEach(() => {
  clock = 1_731_672_000_000;
  currentPage = {
    url: "http://127.0.0.1:5173/pricing#pro",
    origin: "http://127.0.0.1:5173",
    title: "Pricing",
  };
  currentPreset = "mobile";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WebViewerInspectorBridge select validation and Origin-E fields", () => {
  it("validates guest select, stamps Origin-E fields, crops PNG with 8px padding, and submits with threadId", async () => {
    const { webview, bridge, submitted, selections } = setup();
    bridge.setMode("pick");
    expect(webview.modes()).toEqual([{ mode: "pick", redactText: false }]);

    // Attempt to spoof Origin-E fields from guest payload; validator rebuilds strictly from allowlist
    webview.emit(INSPECT_CHANNEL.select, {
      ...makeGuestSelect(),
      selectionId: "sel_spoofed",
      viewSessionId: "evil-session",
      page: { url: "https://bank.example", origin: "https://bank.example" },
    });
    await settle();

    expect(selections).toHaveLength(1);
    const snap = selections[0]!;
    expect(snap.selection.schemaVersion).toBe(1);
    expect(snap.selection.selectionId).toMatch(/^sel_[0-9a-f]{32}$/);
    expect(snap.selection.viewSessionId).toBe("wv-session-42");
    expect(snap.selection.viewportPreset).toBe("mobile");
    expect(snap.selection.boundingBox.document).toEqual({ x: 100, y: 350, width: 120, height: 44 });
    expect((snap.selection as Record<string, unknown>).page).toBeUndefined();
    expect(snap.page).toEqual(currentPage);
    expect(webview.captures[0]).toEqual({ x: 92, y: 192, width: 136, height: 60 });
    expect(snap.screenshot?.width).toBe(96);
    expect(snap.screenshotOmitted).toBeNull();

    clock += 2_000;
    const outcome = await bridge.submit(snap, "  Make button full width on mobile  ", WEB_VIEWER_NEW_THREAD_ID);
    expect(outcome).toEqual({
      status: "accepted",
      delivery: "sent",
      threadId: "thread-created",
      source: "handler",
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.request).toMatchObject({
      contractVersion: 1,
      page: currentPage,
      threadId: WEB_VIEWER_NEW_THREAD_ID,
      comment: "Make button full width on mobile",
      stale: false,
    });
  });

  it("drops invalid guest selects and re-asserts pick mode so guest does not stay stuck in hold", async () => {
    const { webview, bridge, selections } = setup();
    bridge.setMode("pick");
    const modesBefore = webview.modes().length;

    // Hostile __proto__ own property rejected by selection-validator
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    webview.emit(INSPECT_CHANNEL.select, Object.assign(hostile, makeGuestSelect()));
    await settle();

    expect(selections).toHaveLength(0);
    expect(bridge.mode).toBe("pick");
    expect(webview.modes().length).toBe(modesBefore + 1);
  });
});

describe("navigation verification and staleness tracking", () => {
  it("rejects locally with unavailable when page navigates cross-origin or becomes null before submit", async () => {
    const { webview, bridge, registry, selections } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, makeGuestSelect());
    await settle();
    const snap = selections[0]!;

    currentPage = {
      url: "https://evil.example/phish",
      origin: "https://evil.example",
      title: "Evil",
    };
    const crossOriginOutcome = await bridge.submit(snap, "Looks off", "thread-1");
    expect(crossOriginOutcome).toEqual({
      status: "rejected",
      reason: "unavailable",
      message: "The page navigated before feedback was sent. Pick the element again.",
      source: "invalid-result",
    });
    expect(registry.submit).not.toHaveBeenCalled();

    currentPage = null;
    const nullPageOutcome = await bridge.submit(snap, "Looks off", "thread-1");
    expect(nullPageOutcome).toEqual({
      status: "rejected",
      reason: "unavailable",
      message: "The page navigated before feedback was sent. Pick the element again.",
      source: "invalid-result",
    });
    expect(registry.submit).not.toHaveBeenCalled();
  });

  it("marks stale: true on same-origin in-page route change, ready reload, or layout mutation, but not unchanged reassert rect", async () => {
    const { webview, bridge, submitted, selections } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, makeGuestSelect());
    await settle();
    const snap = selections[0]!;

    // 1s guest reassert sending identical rect must NOT mark stale
    webview.emit(INSPECT_CHANNEL.rect, {
      target: "selected",
      connected: true,
      rect: { x: 100, y: 200, width: 120, height: 44 },
      viewport: { width: 390, height: 844 },
    });
    await bridge.submit(snap, "First check", "thread-1");
    expect(submitted[0]!.request.stale).toBe(false);

    // Same-origin SPA route change marks stale: true and updates request.page.url
    currentPage = {
      url: "http://127.0.0.1:5173/checkout",
      origin: "http://127.0.0.1:5173",
      title: "Checkout",
    };
    await bridge.submit(snap, "After SPA route change", "thread-1");
    expect(submitted[1]!.request.stale).toBe(true);
    expect(submitted[1]!.request.page.url).toBe("http://127.0.0.1:5173/checkout");

    // Reset URL back to original, then trigger layout shift via selected rect change -> still stale
    currentPage = {
      url: "http://127.0.0.1:5173/pricing#pro",
      origin: "http://127.0.0.1:5173",
      title: "Pricing",
    };
    webview.emit(INSPECT_CHANNEL.rect, {
      target: "selected",
      connected: true,
      rect: { x: 100, y: 260, width: 120, height: 44 },
    });
    await bridge.submit(snap, "After layout shift", "thread-1");
    expect(submitted[2]!.request.stale).toBe(true);
  });
});

describe("IPC security gates, rate limits, and PNG downscaling", () => {
  it("drops subframe messages, wrong-target events, and messages exceeding sliding-window rate limits", async () => {
    const { webview, bridge, hovers } = setup();
    bridge.setMode("pick");

    const hoverPayload = { tag: "div", rect: { x: 0, y: 0, width: 50, height: 20 }, via: "pointer" };
    webview.emit(INSPECT_CHANNEL.hover, hoverPayload, { isMainFrame: false });
    webview.emit(INSPECT_CHANNEL.hover, hoverPayload, { target: {} });
    expect(hovers).toHaveLength(0);

    for (let i = 0; i < INSPECTOR_CAPS.messagesPerSecond + 10; i++) {
      webview.emit(INSPECT_CHANNEL.hover, hoverPayload);
    }
    expect(hovers).toHaveLength(INSPECTOR_CAPS.messagesPerSecond);

    clock += 1001;
    webview.emit(INSPECT_CHANNEL.hover, hoverPayload);
    expect(hovers).toHaveLength(INSPECTOR_CAPS.messagesPerSecond + 1);
  });

  it("downscales oversized PNG captures and reports empty-rect / too-large / capture-failed omissions", async () => {
    const { webview, bridge, selections } = setup();

    // Downscale from >512KB at 1400px wide to <=512KB at 1024px wide
    const downscaledImg = new FakeImage(1024, 512, png(120_000));
    webview.captureImpl = async () =>
      new FakeImage(1400, 700, png(INSPECTOR_SCREENSHOT.maxBytes + 4096), { 1024: downscaledImg });

    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, makeGuestSelect());
    await settle();
    expect(selections[0]!.screenshot).toMatchObject({
      width: 1024,
      height: 512,
      downscaled: true,
    });
    expect(selections[0]!.screenshotOmitted).toBeNull();

    // Still too large after downscaling
    const hugeSmall = new FakeImage(640, 320, png(INSPECTOR_SCREENSHOT.maxBytes + 100));
    webview.captureImpl = async () =>
      new FakeImage(1400, 700, png(INSPECTOR_SCREENSHOT.maxBytes + 4096), {
        1024: hugeSmall,
        640: hugeSmall,
      });
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, makeGuestSelect());
    await settle();
    expect(selections[1]!.screenshot).toBeNull();
    expect(selections[1]!.screenshotOmitted).toBe("too-large");

    // Offscreen / empty crop rect -> empty-rect without calling capturePage
    const capturesBefore = webview.captures.length;
    bridge.setMode("pick");
    webview.emit(
      INSPECT_CHANNEL.select,
      makeGuestSelect({ boundingBox: { viewport: { x: -500, y: -500, width: 20, height: 20 } } }),
    );
    await settle();
    expect(selections[2]!.screenshot).toBeNull();
    expect(selections[2]!.screenshotOmitted).toBe("empty-rect");
    expect(webview.captures.length).toBe(capturesBefore);
  });
});
