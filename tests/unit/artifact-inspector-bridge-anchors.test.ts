import { describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { ArtifactInspectorBridge, type InspectorIpcEvent } from "../../src/renderer/views/artifact-inspector-bridge";

/** Phase 2b-i G2: the embedder side of the anchor channels (sender, epoch and key gates, budgets, payload allowlist). */

class FakeWebview {
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];
  private listeners = new Set<(event: InspectorIpcEvent) => void>();
  send(channel: string, ...args: unknown[]) { this.sent.push({ channel, args }); }
  addEventListener(_t: "ipc-message", l: (event: InspectorIpcEvent) => void) { this.listeners.add(l); }
  removeEventListener(_t: "ipc-message", l: (event: InspectorIpcEvent) => void) { this.listeners.delete(l); }
  capturePage() { return Promise.reject(new Error("unused")); }
  emit(channel: string, payload?: unknown, extra: Partial<InspectorIpcEvent> = {}) {
    for (const l of [...this.listeners]) l({ channel, args: payload === undefined ? [] : [payload], target: this, ...extra });
  }
  on(channel: string) { return this.sent.filter((m) => m.channel === channel).map((m) => m.args[0] as any); }
}

const target: ArtifactFeedbackTarget = { root: "/art", artifactId: "demo", title: "Demo", runtime: "static", vaultRead: false };
let clock = 1_700_000_000_000;

function setup(opts: { vault?: boolean } = {}) {
  const webview = new FakeWebview();
  const results: any[] = [];
  const rects: any[] = [];
  const hovers: unknown[] = [];
  const bridge = new ArtifactInspectorBridge({
    webview,
    registration: { registrationId: "reg-1", artifactId: "demo", ...(opts.vault ? { vault: { access: "read", allowlist: ["x.base"] } } : {}) },
    target: { ...target, vaultRead: !!opts.vault },
    registry: { submit: vi.fn(async () => ({ status: "accepted" as const, source: "handler" as const })) },
    getRevision: () => 1,
    getViewportPreset: () => "desktop",
    callbacks: {
      onHover: (h) => hovers.push(h), onSelect: () => {}, onCancel: () => {},
      onAnchorResults: (m) => results.push(m), onAnchorRects: (m) => rects.push(m),
    },
    now: () => clock,
  });
  return { webview, bridge, results, rects, hovers };
}

const query = (n: number, over: Partial<InspectAnchorQuery> = {}): InspectAnchorQuery => ({
  key: `a${n}`, route: "/index.html", tag: "button", selector: `#b${n}`, alternates: [],
  textAnchor: { tag: "button", text: `Button ${n}` }, landmark: null, ...over,
});
const rect = { x: 1, y: 2, width: 3, height: 4 };
const resultMsg = (epoch: number, keys: string[]) => ({ epoch, results: keys.map((key) => ({ key, match: "selector", agrees: true, rect, visible: true })) });
const rectMsg = (epoch: number, keys: string[]) => ({ epoch, rects: keys.map((key) => ({ key, rect, visible: true })) });

describe("setAnchors", () => {
  it("sends one anchors message per call with a strictly increasing epoch, in every mode", () => {
    const { bridge, webview } = setup();
    for (const mode of ["off", "pick", "hold"] as const) bridge.setMode(mode);
    expect(bridge.setAnchors([query(0)])).toEqual({ epoch: 1, sent: 1, rejected: [] });
    expect(bridge.setAnchors([query(0), query(1)])).toEqual({ epoch: 2, sent: 2, rejected: [] });
    const messages = webview.on(INSPECT_CHANNEL.anchors);
    expect(messages.map((m: any) => m.epoch)).toEqual([1, 2]);
    expect(messages[1].anchors.map((a: any) => a.key)).toEqual(["a0", "a1"]);
    expect(bridge.anchorEpoch).toBe(2);
  });

  it("tells the guest whether to redact text from the vault grant", () => {
    const plain = setup();
    plain.bridge.setAnchors([query(0)]);
    expect(plain.webview.on(INSPECT_CHANNEL.anchors)[0].redactText).toBe(false);
    const vault = setup({ vault: true });
    vault.bridge.setAnchors([query(0)]);
    expect(vault.webview.on(INSPECT_CHANNEL.anchors)[0].redactText).toBe(true);
  });

  it("T9: the payload keys equal the allowlist exactly; comment text, ids, ordinals and status never reach the guest", () => {
    const { bridge, webview } = setup();
    const polluted = { ...query(0), id: "cmt_00000000000000000000000000000001", text: "SECRET COMMENT", status: "open", ordinal: 7, label: "x", textAnchor: { tag: "button", text: "Buy", comment: "SECRET" } };
    bridge.setAnchors([polluted as never]);
    const payload = webview.on(INSPECT_CHANNEL.anchors)[0];
    expect(Object.keys(payload).sort()).toEqual(["anchors", "epoch", "redactText"]);
    expect(Object.keys(payload.anchors[0]).sort()).toEqual(["alternates", "key", "landmark", "route", "selector", "tag", "textAnchor"]);
    expect(Object.keys(payload.anchors[0].textAnchor).sort()).toEqual(["tag", "text"]);
    const wire = JSON.stringify(webview.sent);
    expect(wire).not.toContain("SECRET");
    expect(wire).not.toContain("cmt_");
  });

  it("rejects invalid queries by key, caps at 100, and still sends the valid ones", () => {
    const { bridge, webview } = setup();
    const many = Array.from({ length: 103 }, (_, i) => query(i));
    const out = bridge.setAnchors([...many, query(5, { key: "a5" }), { ...query(9), selector: "x".repeat(600), key: "a999" }]);
    expect(out.sent).toBe(100);
    expect(out.rejected).toEqual(expect.arrayContaining(["a100", "a101", "a102"]));
    expect(webview.on(INSPECT_CHANNEL.anchors)[0].anchors).toHaveLength(100);
    expect(new Set(webview.on(INSPECT_CHANNEL.anchors)[0].anchors.map((a: any) => a.key)).size).toBe(100);
  });

  it("an empty set is sent too (it clears the guest), and does nothing after dispose", () => {
    const { bridge, webview } = setup();
    bridge.setAnchors([]);
    expect(webview.on(INSPECT_CHANNEL.anchors)).toEqual([{ epoch: 1, redactText: false, anchors: [] }]);
    bridge.dispose();
    expect(bridge.setAnchors([query(0)])).toEqual({ epoch: 1, sent: 0, rejected: [] });
    expect(webview.on(INSPECT_CHANNEL.anchors)).toHaveLength(1);
  });

  it("re-sends the current set with epoch + 1 after the guest's ready (a new document), right after the mode", () => {
    const { bridge, webview } = setup();
    bridge.setMode("pick");
    bridge.setAnchors([query(0)]);
    webview.sent.length = 0;
    webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(webview.sent.map((m) => m.channel)).toEqual([INSPECT_CHANNEL.mode, INSPECT_CHANNEL.anchors]);
    expect(webview.on(INSPECT_CHANNEL.anchors)[0]).toMatchObject({ epoch: 2, anchors: [{ key: "a0" }] });
  });

  it("does not send anchors on ready when none were ever set", () => {
    const { webview } = setup();
    webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(webview.on(INSPECT_CHANNEL.anchors)).toEqual([]);
  });
});

describe("focusAnchor", () => {
  it("sends the current epoch with a known key and a valid behavior only", () => {
    const { bridge, webview } = setup();
    bridge.setAnchors([query(0), query(1)]);
    expect(bridge.focusAnchor("a1", "scroll")).toBe(true);
    expect(bridge.focusAnchor("a0", "flash")).toBe(true);
    expect(bridge.focusAnchor("a7", "scroll")).toBe(false);
    expect(bridge.focusAnchor("a1", "explode" as never)).toBe(false);
    expect(webview.on(INSPECT_CHANNEL.anchorFocus)).toEqual([
      { epoch: 1, key: "a1", behavior: "scroll" },
      { epoch: 1, key: "a0", behavior: "flash" },
    ]);
  });
});

describe("anchor-results (T1)", () => {
  it("delivers a valid message for the current epoch in every mode", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors([query(0), query(1)]);
    for (const mode of ["off", "pick", "hold"] as const) {
      bridge.setMode(mode);
      clock += 1000;
      webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0", "a1"]));
    }
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(resultMsg(1, ["a0", "a1"]));
  });

  it("drops results from another webview, a sub-frame, with two args, or after dispose", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors([query(0)]);
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]), { target: {} });
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]), { target: undefined });
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]), { isMainFrame: false });
    for (const l of (webview as any).listeners) l({ channel: INSPECT_CHANNEL.anchorResults, args: [resultMsg(1, ["a0"]), 1], target: webview });
    for (const l of (webview as any).listeners) l({ channel: INSPECT_CHANNEL.anchorResults, args: [], target: webview });
    expect(results).toEqual([]);
    bridge.dispose();
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]));
    expect(results).toEqual([]);
  });

  it("drops a stale epoch and a key that was not sent in this epoch", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors([query(0)]);
    bridge.setAnchors([query(1)]); // epoch 2, only a1
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]));
    clock += 200;
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(2, ["a0"]));
    clock += 200;
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(2, ["a1", "a0"]));
    expect(results).toEqual([]);
    clock += 200;
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(2, ["a1"]));
    expect(results).toHaveLength(1);
  });

  it("drops everything before any anchors were set", () => {
    const { webview, results, rects } = setup();
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(0, []));
    webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(0, []));
    expect(results).toEqual([]);
    expect(rects).toEqual([]);
  });

  it("drops a message over 64 KB, 101 entries, and hostile keys", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors(Array.from({ length: 100 }, (_, i) => query(i)));
    const big = { epoch: 1, results: [{ key: "a0", match: "selector", agrees: true, rect, visible: true, pad: "x".repeat(70_000) }] };
    webview.emit(INSPECT_CHANNEL.anchorResults, big);
    clock += 200;
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, Array.from({ length: 101 }, (_, i) => `a${i}`)));
    clock += 200;
    webview.emit(INSPECT_CHANNEL.anchorResults, JSON.parse(`{"epoch":1,"results":[],"__proto__":{"x":1}}`));
    expect(results).toEqual([]);
  });

  it("has its own budget of 8 per second, which a flood of rects cannot touch and which does not touch select/cancel/hover budgets", () => {
    const { bridge, webview, results, rects, hovers } = setup();
    bridge.setMode("pick");
    bridge.setAnchors([query(0)]);
    for (let i = 0; i < 300; i++) webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(1, ["a0"]));
    expect(rects).toHaveLength(INSPECTOR_CAPS.anchorRectsPerSecond);
    for (let i = 0; i < 20; i++) webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]));
    expect(results).toHaveLength(INSPECTOR_CAPS.anchorResultsPerSecond);
    // hover still has its whole budget
    for (let i = 0; i < 40; i++) webview.emit(INSPECT_CHANNEL.hover, { tag: "div", rect, via: "pointer" });
    expect(hovers).toHaveLength(INSPECTOR_CAPS.messagesPerSecond);
    // a second later the anchor budgets are back
    clock += 1001;
    webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]));
    webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(1, ["a0"]));
    expect(results).toHaveLength(INSPECTOR_CAPS.anchorResultsPerSecond + 1);
    expect(rects).toHaveLength(INSPECTOR_CAPS.anchorRectsPerSecond + 1);
  });

  it("a flood of anchor traffic cannot starve cancel or ready", () => {
    const { bridge, webview } = setup();
    let cancels = 0;
    (bridge as any).options.callbacks.onCancel = () => { cancels++; };
    bridge.setMode("pick");
    bridge.setAnchors([query(0)]);
    for (let i = 0; i < 500; i++) {
      webview.emit(INSPECT_CHANNEL.anchorResults, resultMsg(1, ["a0"]));
      webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(1, ["a0"]));
    }
    webview.emit(INSPECT_CHANNEL.cancel, { reason: "escape" });
    expect(cancels).toBe(1);
  });
});

describe("anchor-rects (T1)", () => {
  it("delivers rects for the current epoch and drops stale, unknown and malformed ones", () => {
    const { bridge, webview, rects } = setup();
    bridge.setAnchors([query(0)]);
    webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(1, ["a0"]));
    webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(9, ["a0"]));
    webview.emit(INSPECT_CHANNEL.anchorRects, rectMsg(1, ["a3"]));
    webview.emit(INSPECT_CHANNEL.anchorRects, { epoch: 1, rects: [{ key: "a0", rect: { x: Number.NaN, y: 0, width: 1, height: 1 }, visible: true }] });
    expect(rects).toEqual([rectMsg(1, ["a0"])]);
  });
});
