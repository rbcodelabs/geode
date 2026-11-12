import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import { INSPECT_CHANNEL, INSPECTOR_SCREENSHOT, type GuestSelectMessage } from "../../src/artifacts/inspector-protocol";
import {
  ArtifactInspectorBridge,
  artifactFeedbackTarget,
  isPickAvailable,
  type InspectorIpcEvent,
  type InspectorNativeImage,
  type SelectionSnapshot,
} from "../../src/renderer/views/artifact-inspector-bridge";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (size: number): Uint8Array => { const b = new Uint8Array(size); b.set(PNG_SIG); return b; };

class FakeImage implements InspectorNativeImage {
  constructor(private readonly width: number, private readonly height: number, private readonly bytes: Uint8Array, private readonly resized: Record<number, FakeImage> = {}, private readonly empty = false) {}
  toPNG() { return this.bytes; }
  getSize() { return { width: this.width, height: this.height }; }
  isEmpty() { return this.empty; }
  resize({ width }: { width: number }) {
    const next = this.resized[width];
    if (!next) throw new Error(`no fake for ${width}`);
    return next;
  }
}

class FakeWebview {
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];
  private listeners = new Set<(event: InspectorIpcEvent) => void>();
  captures: Array<{ x: number; y: number; width: number; height: number } | undefined> = [];
  captureImpl: (rect?: unknown) => Promise<InspectorNativeImage> = async () => new FakeImage(100, 60, png(2000));
  send(channel: string, ...args: unknown[]) { this.sent.push({ channel, args }); }
  addEventListener(_t: "ipc-message", l: (event: InspectorIpcEvent) => void) { this.listeners.add(l); }
  removeEventListener(_t: "ipc-message", l: (event: InspectorIpcEvent) => void) { this.listeners.delete(l); }
  capturePage(rect?: { x: number; y: number; width: number; height: number }) { this.captures.push(rect); return this.captureImpl(rect); }
  get listenerCount() { return this.listeners.size; }
  emit(channel: string, payload?: unknown, extra: Partial<InspectorIpcEvent> = {}) {
    for (const l of [...this.listeners]) l({ channel, args: payload === undefined ? [] : [payload], target: this, ...extra });
  }
  modes() { return this.sent.filter((m) => m.channel === INSPECT_CHANNEL.mode).map((m) => m.args[0]); }
}

const guestSelect = (over: Partial<GuestSelectMessage> = {}): GuestSelectMessage => ({
  route: "/index.html", tag: "button", selector: "#b", selectorAlternates: [],
  textAnchor: { tag: "button", text: "Buy" }, landmark: null,
  outerHTML: { html: "<button>Buy</button>", truncated: false }, ancestors: [], computedStyles: { display: "block" },
  boundingBox: { viewport: { x: 100, y: 50, width: 80, height: 30 } },
  viewport: { width: 1000, height: 800, devicePixelRatio: 2, scrollX: 10, scrollY: 300 },
  a11y: { role: "button", name: "Buy", tabIndex: 0 }, ...over,
});

const target: ArtifactFeedbackTarget = { root: "/art", artifactId: "demo", title: "Demo", runtime: "static", vaultRead: false };
let clock = 1_700_000_000_000;
let revision = 3;
let preset: "fill" | "desktop" = "desktop";

function setup(opts: { vault?: boolean } = {}) {
  const webview = new FakeWebview();
  const submitted: ArtifactFeedbackRequest[] = [];
  const registry = { submit: vi.fn(async (_t: ArtifactFeedbackTarget, request: ArtifactFeedbackRequest) => { submitted.push(request); return { status: "accepted" as const, source: "handler" as const }; }) };
  const hovers: unknown[] = [];
  const rects: unknown[] = [];
  const selections: SelectionSnapshot[] = [];
  let cancels = 0;
  let counter = 0;
  const bridge = new ArtifactInspectorBridge({
    webview,
    registration: { registrationId: "reg-1", artifactId: "demo", ...(opts.vault ? { vault: { access: "read", allowlist: ["x.base"] } } : {}) },
    target: { ...target, vaultRead: !!opts.vault },
    registry,
    getRevision: () => revision,
    getViewportPreset: () => preset,
    callbacks: { onHover: (h) => hovers.push(h), onSelect: (s) => selections.push(s), onCancel: () => { cancels++; }, onRect: (r) => rects.push(r) },
    now: () => clock,
    randomBytes: (n) => Uint8Array.from({ length: n }, () => (counter++ * 37 + 11) & 0xff),
  });
  return { webview, bridge, registry, submitted, hovers, rects, selections, cancels: () => cancels };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => { clock = 1_700_000_000_000; revision = 3; preset = "desktop"; });
afterEach(() => { vi.useRealTimers(); });

describe("attach and mode", () => {
  it("attaches the ipc-message listener always (also without a vault grant) and removes it on dispose", () => {
    const { webview, bridge } = setup();
    expect(webview.listenerCount).toBe(1);
    bridge.dispose();
    expect(webview.listenerCount).toBe(0);
  });

  it("sends the mode with redactText set from the vault grant", () => {
    const plain = setup();
    plain.bridge.setMode("pick");
    expect(plain.webview.modes()).toEqual([{ mode: "pick", redactText: false }]);
    const vault = setup({ vault: true });
    vault.bridge.setMode("pick");
    expect(vault.webview.modes()).toEqual([{ mode: "pick", redactText: true }]);
    expect(vault.bridge.mode).toBe("pick");
  });

  it("forwards [ and ] as key messages and never anything else", () => {
    const { bridge, webview } = setup();
    bridge.setMode("pick");
    bridge.sendKey("parent");
    bridge.sendKey("child");
    bridge.sendKey("bogus" as never);
    expect(webview.sent.filter((m) => m.channel === INSPECT_CHANNEL.key).map((m) => m.args[0])).toEqual([{ key: "parent" }, { key: "child" }]);
  });

  it("answers ready with the current mode, so pick survives the view's own reloads", () => {
    const { bridge, webview } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(webview.modes()).toEqual([{ mode: "pick", redactText: false }, { mode: "pick", redactText: false }]);
  });

  it("answers ready with off by default and ignores a malformed ready", () => {
    const { bridge, webview } = setup();
    webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(webview.modes()).toEqual([{ mode: "off", redactText: false }]);
    for (const bad of [undefined, null, { protocol: 2 }, "x", { protocol: 1, extra: __proto__guard() }]) webview.emit(INSPECT_CHANNEL.ready, bad as never);
    expect(webview.modes()).toHaveLength(1);
    void bridge;
  });
});
function __proto__guard() { return JSON.parse('{"__proto__":{"a":1}}'); }

describe("sender and mode checks", () => {
  it("ignores messages from any sender other than the registered webview, other channels, and wrong arity", () => {
    const { bridge, webview, hovers } = setup();
    bridge.setMode("pick");
    const hover = { tag: "div", rect: { x: 1, y: 1, width: 1, height: 1 }, via: "pointer" };
    webview.emit(INSPECT_CHANNEL.hover, hover, { target: { other: true } });
    webview.emit(INSPECT_CHANNEL.hover, hover, { target: undefined });
    webview.emit("geode-artifact:query", hover);
    webview.emit("geode-artifact:inspect:v1:rects", hover);
    webview.emit(INSPECT_CHANNEL.hover, hover, { isMainFrame: false });
    for (const l of [(webview as never as { listeners: Set<(e: InspectorIpcEvent) => void> }).listeners]) for (const f of l) f({ channel: INSPECT_CHANNEL.hover, args: [hover, hover], target: webview });
    expect(hovers).toEqual([]);
    webview.emit(INSPECT_CHANNEL.hover, hover);
    expect(hovers).toHaveLength(1);
  });

  it("accepts hover and select only in pick; cancel in pick and hold; nothing but ready while off", () => {
    const { bridge, webview, hovers, cancels } = setup();
    const hover = { tag: "div", rect: { x: 1, y: 1, width: 1, height: 1 }, via: "pointer" };
    for (const mode of ["off", "hold"] as const) {
      bridge.setMode(mode);
      webview.emit(INSPECT_CHANNEL.hover, hover);
      webview.emit(INSPECT_CHANNEL.select, guestSelect());
    }
    expect(hovers).toEqual([]);
    bridge.setMode("off");
    webview.emit(INSPECT_CHANNEL.cancel, { reason: "escape" });
    expect(cancels()).toBe(0);
    bridge.setMode("hold");
    webview.emit(INSPECT_CHANNEL.cancel, { reason: "escape" });
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.cancel, { reason: "escape" });
    webview.emit(INSPECT_CHANNEL.cancel, { reason: "nope" });
    expect(cancels()).toBe(2);
  });

  it("passes validated hover data (tag, rect, via, label) to the callback", () => {
    const { bridge, webview, hovers } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.hover, { tag: "a", rect: { x: 1, y: 2, width: 3, height: 4 }, via: "keyboard", label: "Go", extra: 1 });
    expect(hovers).toEqual([{ tag: "a", rect: { x: 1, y: 2, width: 3, height: 4 }, via: "keyboard", label: "Go" }]);
  });
});

describe("limits", () => {
  it("drops oversized, schema-violating and prototype-polluting messages", async () => {
    const { bridge, webview, selections } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect({ outerHTML: { html: "x".repeat(70_000), truncated: false } }));
    webview.emit(INSPECT_CHANNEL.select, { ...guestSelect(), tag: "BAD" });
    webview.emit(INSPECT_CHANNEL.select, { ...guestSelect(), ...JSON.parse('{"__proto__":{"polluted":true}}') });
    await settle();
    expect(selections).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(bridge.mode).toBe("pick"); // a bad message does not change state
  });

  it("rate limits hover to 30 per second over a sliding window", () => {
    const { bridge, webview, hovers } = setup();
    bridge.setMode("pick");
    const hover = { tag: "div", rect: { x: 1, y: 1, width: 1, height: 1 }, via: "pointer" };
    for (let i = 0; i < 50; i++) webview.emit(INSPECT_CHANNEL.hover, hover);
    expect(hovers).toHaveLength(30);
    clock += 1001;
    webview.emit(INSPECT_CHANNEL.hover, hover);
    expect(hovers).toHaveLength(31);
  });

  it("a hover sweep never starves the click: 100 hovers, then a select in the same second is still accepted", async () => {
    const { bridge, webview, hovers, selections } = setup();
    bridge.setMode("pick");
    const hover = { tag: "div", rect: { x: 1, y: 1, width: 1, height: 1 }, via: "pointer" };
    for (let i = 0; i < 100; i++) webview.emit(INSPECT_CHANNEL.hover, hover);
    expect(hovers).toHaveLength(30);
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(selections).toHaveLength(1);
  });

  it("ready and cancel have their own budgets: a hover flood does not swallow them", () => {
    const { bridge, webview, cancels } = setup();
    bridge.setMode("pick");
    const hover = { tag: "div", rect: { x: 1, y: 1, width: 1, height: 1 }, via: "pointer" };
    for (let i = 0; i < 100; i++) webview.emit(INSPECT_CHANNEL.hover, hover);
    const before = webview.modes().length;
    webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(webview.modes().length).toBe(before + 1);
    webview.emit(INSPECT_CHANNEL.cancel, { reason: "escape" });
    expect(cancels()).toBe(1);
  });

  describe("a select that is dropped never strands the guest in hold", () => {
    const lastMode = (webview: { modes(): unknown[] }) => webview.modes().at(-1);

    it("re-sends pick when the select fails validation, is oversized, has the wrong arity, or is rate limited", async () => {
      const { bridge, webview, selections } = setup();
      bridge.setMode("pick");
      const resent = () => webview.modes().length;
      let n = resent();
      webview.emit(INSPECT_CHANNEL.select, { ...guestSelect(), tag: "BAD" });
      expect(resent()).toBe(n + 1);
      n = resent();
      webview.emit(INSPECT_CHANNEL.select, guestSelect({ outerHTML: { html: "x".repeat(70_000), truncated: false } }));
      expect(resent()).toBe(n + 1);
      n = resent();
      for (const f of (webview as never as { listeners: Set<(e: InspectorIpcEvent) => void> }).listeners) f({ channel: INSPECT_CHANNEL.select, args: [guestSelect(), guestSelect()], target: webview });
      expect(resent()).toBe(n + 1);
      expect(lastMode(webview)).toEqual({ mode: "pick", redactText: false });
      expect(selections).toEqual([]);
      // rate limit: four accepted per second, the fifth is dropped and re-arms the guest
      clock += 1001; // the invalid attempts above already used part of this second's budget
      for (let i = 0; i < 4; i++) { bridge.setMode("pick"); webview.emit(INSPECT_CHANNEL.select, guestSelect()); await settle(); }
      expect(selections).toHaveLength(4);
      bridge.setMode("pick");
      n = resent();
      webview.emit(INSPECT_CHANNEL.select, guestSelect());
      await settle();
      expect(selections).toHaveLength(4);
      expect(resent()).toBe(n + 1);
      expect(bridge.mode).toBe("pick");
    });

    it("does not re-send anything for a select that arrives in hold or off (nothing is stranded)", () => {
      const { bridge, webview } = setup();
      for (const mode of ["hold", "off"] as const) {
        bridge.setMode(mode);
        const n = webview.modes().length;
        webview.emit(INSPECT_CHANNEL.select, { ...guestSelect(), tag: "BAD" });
        expect(webview.modes().length).toBe(n);
      }
    });
  });

  it("accepts at most 4 selects per second", async () => {
    const { bridge, webview, selections } = setup({ vault: true });
    for (let i = 0; i < 6; i++) {
      bridge.setMode("pick");
      webview.emit(INSPECT_CHANNEL.select, guestSelect());
      await settle();
    }
    expect(selections).toHaveLength(4);
  });

  it("handles one select at a time: it moves to hold on acceptance, so a second one is ignored until pick returns", async () => {
    const { bridge, webview, selections } = setup({ vault: true });
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(selections).toHaveLength(1);
    expect(bridge.mode).toBe("hold");
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(selections).toHaveLength(2);
  });
});

describe("selection building", () => {
  it("rebuilds the selection: embedder-made id, stamps, document rect and untrusted ids ignored", async () => {
    const { bridge, webview, selections } = setup({ vault: true });
    preset = "fill";
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, { ...guestSelect(), selectionId: "sel_" + "f".repeat(32), artifactId: "evil", redacted: false, capturedAt: "x" });
    await settle();
    const sel = selections[0]!.selection;
    expect(sel.selectionId).toMatch(/^sel_[0-9a-f]{32}$/);
    expect(sel.selectionId).not.toContain("ffffffff");
    expect(sel).toMatchObject({
      schemaVersion: 1, artifactId: "demo", artifactRevision: 3, viewSessionId: "reg-1", viewportPreset: "fill",
      capturedAt: new Date(clock).toISOString(), redacted: true, tag: "button", selector: "#b",
    });
    expect(sel.boundingBox).toEqual({ viewport: { x: 100, y: 50, width: 80, height: 30 }, document: { x: 110, y: 350, width: 80, height: 30 } });
    expect(sel.viewport).toEqual({ width: 1000, height: 800, devicePixelRatio: 2, scrollX: 10, scrollY: 300 });
    expect(Object.keys(sel)).not.toContain("evil");
    expect(Object.isFrozen(sel)).toBe(true);
  });

  it("generates a different id per selection", async () => {
    const { bridge, webview, selections } = setup({ vault: true });
    for (let i = 0; i < 2; i++) { bridge.setMode("pick"); webview.emit(INSPECT_CHANNEL.select, guestSelect()); await settle(); }
    expect(selections[0]!.selection.selectionId).not.toBe(selections[1]!.selection.selectionId);
  });

  it("re-enforces redaction on a vault artifact even if the guest forgot", async () => {
    const { bridge, webview, selections } = setup({ vault: true });
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect({ outerHTML: { html: '<p title="secret">Salary</p>', truncated: false } }));
    await settle();
    const sel = selections[0]!.selection;
    expect(sel.textAnchor.text).toBe("");
    expect(sel.a11y.name).toBeNull();
    expect(sel.outerHTML.html).toBe('<p title="..."></p>');
  });
});

describe("screenshot policy", () => {
  it("never captures for a vault: read artifact", async () => {
    const { bridge, webview, selections } = setup({ vault: true });
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(webview.captures).toEqual([]);
    expect(selections[0]).toMatchObject({ screenshot: null, screenshotOmitted: "vault-read" });
  });

  it("captures the element padded by 8 px and clipped to the viewport, as plain bytes", async () => {
    const { bridge, webview, selections } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect({ boundingBox: { viewport: { x: 2, y: 3, width: 995, height: 30 } } }));
    await settle();
    expect(webview.captures).toEqual([{ x: 0, y: 0, width: 1000, height: 41 }]);
    const shot = selections[0]!.screenshot!;
    expect(shot).toMatchObject({ mimeType: "image/png", width: 100, height: 60, devicePixelRatio: 2, downscaled: false, cssRect: { x: 0, y: 0, width: 1000, height: 41 } });
    expect(shot.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(shot.bytes)).toBe(false);
    expect(shot.bytes.length).toBe(2000);
    expect(selections[0]!.screenshotOmitted).toBeNull();
  });

  it("pads an interior element by exactly 8 px on each side", async () => {
    const { bridge, webview } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(webview.captures).toEqual([{ x: 92, y: 42, width: 96, height: 46 }]);
  });

  it("omits as empty-rect, without capturing, when the element is outside the viewport", async () => {
    const { bridge, webview, selections } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect({ boundingBox: { viewport: { x: 0, y: 2000, width: 10, height: 10 } } }));
    await settle();
    expect(webview.captures).toEqual([]);
    expect(selections[0]).toMatchObject({ screenshot: null, screenshotOmitted: "empty-rect" });
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect({ boundingBox: { viewport: { x: 5, y: 5, width: 0, height: 0 } } }));
    await settle();
    expect(webview.captures).toHaveLength(1); // zero-size element still has an 8 px padded crop
  });

  it("downscales to 1024 then 640 when the PNG exceeds 512 KiB, else omits as too-large", async () => {
    const big = png(INSPECTOR_SCREENSHOT.maxBytes + 1);
    const w640 = new FakeImage(640, 400, png(100_000));
    const w1024 = new FakeImage(1024, 640, png(INSPECTOR_SCREENSHOT.maxBytes + 5));
    const a = setup();
    a.webview.captureImpl = async () => new FakeImage(2000, 1250, big, { 1024: w1024, 640: w640 });
    a.bridge.setMode("pick");
    a.webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(a.selections[0]!.screenshot).toMatchObject({ width: 640, height: 400, downscaled: true });

    const ok1024 = new FakeImage(1024, 640, png(300_000));
    const b = setup();
    b.webview.captureImpl = async () => new FakeImage(2000, 1250, big, { 1024: ok1024, 640: w640 });
    b.bridge.setMode("pick");
    b.webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(b.selections[0]!.screenshot).toMatchObject({ width: 1024, downscaled: true });

    const huge640 = new FakeImage(640, 400, png(INSPECTOR_SCREENSHOT.maxBytes + 9));
    const c = setup();
    c.webview.captureImpl = async () => new FakeImage(2000, 1250, big, { 1024: w1024, 640: huge640 });
    c.bridge.setMode("pick");
    c.webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(c.selections[0]).toMatchObject({ screenshot: null, screenshotOmitted: "too-large" });
  });

  it("does not try a downscale width that is not smaller than the image", async () => {
    const small = new FakeImage(800, 500, png(INSPECTOR_SCREENSHOT.maxBytes + 1), { 640: new FakeImage(640, 400, png(1000)) });
    const { bridge, webview, selections } = setup();
    webview.captureImpl = async () => small;
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(selections[0]!.screenshot).toMatchObject({ width: 640, downscaled: true });
  });

  it.each([
    ["a rejected capture", () => Promise.reject(new Error("gone"))],
    ["an empty image", async () => new FakeImage(0, 0, png(10), {}, true)],
    ["a non-PNG payload", async () => new FakeImage(10, 10, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))],
    ["zero bytes", async () => new FakeImage(10, 10, new Uint8Array(0))],
    ["a throwing toPNG", async () => ({ toPNG() { throw new Error("x"); }, getSize: () => ({ width: 1, height: 1 }), isEmpty: () => false, resize: () => { throw new Error("x"); } }) as never],
  ])("reports capture-failed for %s and still delivers the selection", async (_name, impl) => {
    const { bridge, webview, selections } = setup();
    webview.captureImpl = impl as never;
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(selections[0]).toMatchObject({ screenshot: null, screenshotOmitted: "capture-failed" });
  });

  it("times out a capture after 2 s as capture-failed", async () => {
    vi.useFakeTimers();
    const { bridge, webview, selections } = setup();
    webview.captureImpl = () => new Promise(() => {});
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await vi.advanceTimersByTimeAsync(1999);
    expect(selections).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(selections[0]).toMatchObject({ screenshot: null, screenshotOmitted: "capture-failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the result if the bridge was disposed or switched off while capturing", async () => {
    const a = setup();
    let release!: (i: InspectorNativeImage) => void;
    a.webview.captureImpl = () => new Promise((r) => { release = r; });
    a.bridge.setMode("pick");
    a.webview.emit(INSPECT_CHANNEL.select, guestSelect());
    a.bridge.dispose();
    release(new FakeImage(10, 10, png(100)));
    await settle();
    expect(a.selections).toEqual([]);

    const b = setup();
    b.webview.captureImpl = () => new Promise((r) => { release = r; });
    b.bridge.setMode("pick");
    b.webview.emit(INSPECT_CHANNEL.select, guestSelect());
    b.bridge.setMode("off");
    release(new FakeImage(10, 10, png(100)));
    await settle();
    expect(b.selections).toEqual([]);
  });
});

describe("submit", () => {
  async function selected(opts: { vault?: boolean } = {}) {
    const ctx = setup(opts);
    ctx.bridge.setMode("pick");
    ctx.webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    return { ...ctx, snapshot: ctx.selections[0]! };
  }

  it("builds a fresh frozen request and returns the registry outcome", async () => {
    const { bridge, snapshot, registry, submitted } = await selected();
    clock += 5000;
    const outcome = await bridge.submit(snapshot, "  make it blue  ");
    expect(outcome).toEqual({ status: "accepted", source: "handler" });
    expect(registry.submit).toHaveBeenCalledTimes(1);
    expect(registry.submit.mock.calls[0]![0]).toEqual({ ...target });
    const req = submitted[0]!;
    expect(req).toMatchObject({
      contractVersion: 1, artifact: target, comment: "make it blue", stale: false,
      submittedAt: new Date(clock).toISOString(), screenshotOmitted: null,
    });
    expect(req.selection).toBe(snapshot.selection);
    expect(req.screenshot).toEqual(snapshot.screenshot); // equal content, but a copy per attempt (see the retry test)
    expect(Object.keys(req).sort()).toEqual(["artifact", "comment", "contractVersion", "screenshot", "screenshotOmitted", "selection", "stale", "submittedAt"]);
  });

  it("hands every attempt its own copy of the screenshot bytes, so a handler that zero-fills them cannot corrupt a retry", async () => {
    const { bridge, webview, registry, submitted, selections } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    const snap = selections[0]!;
    expect(snap.screenshot).not.toBeNull();
    const original = Array.from(snap.screenshot!.bytes.slice(0, 8));
    registry.submit.mockImplementationOnce(async (_t, request) => { submitted.push(request); request.screenshot!.bytes.fill(0); return { status: "rejected" as const, reason: "failed" as const, message: "x", source: "handler" as const }; });
    await bridge.submit(snap, "first");
    await bridge.submit(snap, "second");
    expect(Array.from(submitted[1]!.screenshot!.bytes.slice(0, 8))).toEqual(original);
    expect(submitted[1]!.screenshot!.bytes).not.toBe(snap.screenshot!.bytes);
    expect(Array.from(snap.screenshot!.bytes.slice(0, 8))).toEqual(original);
  });

  it("retry reuses the same selectionId (same snapshot, new request object)", async () => {
    const { bridge, snapshot, submitted } = await selected();
    await bridge.submit(snapshot, "a");
    await bridge.submit(snapshot, "a");
    expect(submitted[0]).not.toBe(submitted[1]);
    expect(submitted[0]!.selection.selectionId).toBe(submitted[1]!.selection.selectionId);
  });

  it("marks the request stale when the runtime revision advanced or the document reloaded since the selection", async () => {
    const a = await selected();
    revision = 4;
    await a.bridge.submit(a.snapshot, "c");
    expect(a.submitted[0]!.stale).toBe(true);
    revision = 3;
    const b = await selected();
    b.webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 }); // page reloaded under the popover
    await b.bridge.submit(b.snapshot, "c");
    expect(b.submitted[0]!.stale).toBe(true);
    revision = 3;
    const c = await selected();
    await c.bridge.submit(c.snapshot, "c");
    expect(c.submitted[0]!.stale).toBe(false);
  });

  it.each([["empty", ""], ["blank", "   \n\t"], ["too long", "x".repeat(4001)]])("rejects a %s comment as invalid without calling the registry", async (_n, comment) => {
    const { bridge, snapshot, registry } = await selected();
    expect(await bridge.submit(snapshot, comment)).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(registry.submit).not.toHaveBeenCalled();
  });

  it("accepts a 4000-unit comment and trims before measuring", async () => {
    const { bridge, snapshot, registry } = await selected();
    await bridge.submit(snapshot, ` ${"x".repeat(4000)} `);
    expect(registry.submit).toHaveBeenCalledTimes(1);
  });

  it("turns a throwing registry into a rejected outcome", async () => {
    const { bridge, snapshot, registry } = await selected();
    registry.submit.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await bridge.submit(snapshot, "c")).toMatchObject({ status: "rejected", reason: "failed" });
    warn.mockRestore();
  });

  it("a vault artifact request carries no screenshot and the vault-read reason", async () => {
    const { bridge, snapshot, submitted } = await selected({ vault: true });
    await bridge.submit(snapshot, "c");
    expect(submitted[0]).toMatchObject({ screenshot: null, screenshotOmitted: "vault-read", selection: { redacted: true }, artifact: { vaultRead: true } });
  });
});

describe("helpers", () => {
  it("artifactFeedbackTarget returns a frozen object a handler cannot mutate", () => {
    const t = artifactFeedbackTarget({ artifactId: "a", title: "T", vault: undefined }, "/r");
    expect(Object.isFrozen(t)).toBe(true);
    expect(() => { (t as { vaultRead: boolean }).vaultRead = true; }).toThrow();
  });

  it("artifactFeedbackTarget maps a registration and root to data only", () => {
    expect(artifactFeedbackTarget({ artifactId: "a", title: "T", runtime: "static", vault: { access: "read", allowlist: ["x"] } } as never, "/r"))
      .toEqual({ root: "/r", artifactId: "a", title: "T", runtime: "static", vaultRead: true });
    expect(artifactFeedbackTarget({ artifactId: "a", title: "T", runtime: "static" } as never, "/r").vaultRead).toBe(false);
  });

  it("isPickAvailable needs a static runtime, the inspector flag and a handler", () => {
    const registry = { has: vi.fn(() => true) };
    const reg = { runtime: "static", inspector: { protocol: 1 } } as never;
    expect(isPickAvailable(reg, registry, target)).toBe(true);
    expect(isPickAvailable({ runtime: "static" } as never, registry, target)).toBe(false);
    expect(isPickAvailable({ runtime: "nextjs", inspector: { protocol: 1 } } as never, registry, target)).toBe(false);
    expect(isPickAvailable(reg, { has: () => false }, target)).toBe(false);
    expect(isPickAvailable(null, registry, target)).toBe(false);
  });
});

describe("rect reports (Phase 2a)", () => {
  const rectMsg = (over: Record<string, unknown> = {}) => ({ target: "hover", connected: true, rect: { x: 1, y: 2, width: 3, height: 4 }, ...over });

  it("passes a validated hover rect while picking and a selected rect while holding, nothing otherwise", () => {
    const { bridge, webview, rects } = setup();
    webview.emit(INSPECT_CHANNEL.rect, rectMsg()); // off
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.rect, rectMsg());
    webview.emit(INSPECT_CHANNEL.rect, rectMsg({ target: "selected" })); // nothing is selected while picking
    bridge.setMode("hold");
    webview.emit(INSPECT_CHANNEL.rect, rectMsg({ target: "selected", rect: { x: 5, y: 6, width: 7, height: 8 } }));
    webview.emit(INSPECT_CHANNEL.rect, rectMsg()); // a hover rect while holding is stale
    expect(rects).toEqual([rectMsg(), rectMsg({ target: "selected", rect: { x: 5, y: 6, width: 7, height: 8 } })]);
  });

  it("drops invalid, oversized, polluted or wrong-sender reports", () => {
    const { bridge, webview, rects } = setup();
    bridge.setMode("pick");
    webview.emit(INSPECT_CHANNEL.rect, rectMsg({ rect: { x: 1, y: 2, width: -3, height: 4 } }));
    webview.emit(INSPECT_CHANNEL.rect, { ...rectMsg(), pad: "x".repeat(70_000) });
    webview.emit(INSPECT_CHANNEL.rect, JSON.parse('{"__proto__":{"polluted":true},"target":"hover","connected":true,"rect":{"x":1,"y":2,"width":3,"height":4}}'));
    webview.emit(INSPECT_CHANNEL.rect, rectMsg(), { target: { other: true } });
    webview.emit(INSPECT_CHANNEL.rect, rectMsg(), { isMainFrame: false });
    expect(rects).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("has its own 120 per second budget: a scroll flood never starves a select, and a hover/select flood never starves rects", async () => {
    const { bridge, webview, rects, hovers, selections } = setup();
    bridge.setMode("pick");
    for (let i = 0; i < 500; i++) webview.emit(INSPECT_CHANNEL.rect, rectMsg());
    expect(rects).toHaveLength(120);
    webview.emit(INSPECT_CHANNEL.select, guestSelect());
    await settle();
    expect(selections).toHaveLength(1); // the select budget is untouched
    const hover = { tag: "div", rect: { x: 1, y: 1, width: 1, height: 1 }, via: "pointer" };
    bridge.setMode("pick");
    for (let i = 0; i < 100; i++) webview.emit(INSPECT_CHANNEL.hover, hover);
    expect(hovers).toHaveLength(30);
    clock += 1001;
    webview.emit(INSPECT_CHANNEL.rect, rectMsg());
    expect(rects).toHaveLength(121);
  });

  it("a dropped rect report never re-sends the mode (it cannot strand the guest)", () => {
    const { bridge, webview } = setup();
    bridge.setMode("pick");
    const before = webview.modes().length;
    for (let i = 0; i < 200; i++) webview.emit(INSPECT_CHANNEL.rect, rectMsg());
    expect(webview.modes().length).toBe(before);
  });
});
