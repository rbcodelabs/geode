import { describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { validateAnchorRects, validateAnchorResults } from "../../src/renderer/artifacts/anchor-validator";
import { ArtifactInspectorBridge, type InspectorIpcEvent } from "../../src/renderer/views/artifact-inspector-bridge";

/** QA (G2, independent): gaps found by mutation testing the embedder side, plus extra hostile shapes for T1. */

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
function setup() {
  const webview = new FakeWebview();
  const results: any[] = [];
  const rects: any[] = [];
  const bridge = new ArtifactInspectorBridge({
    webview, registration: { registrationId: "reg-1", artifactId: "demo" }, target,
    registry: { submit: vi.fn(async () => ({ status: "accepted" as const, source: "handler" as const })) },
    getRevision: () => 1, getViewportPreset: () => "desktop",
    callbacks: { onHover: () => {}, onSelect: () => {}, onCancel: () => {}, onAnchorResults: (m) => results.push(m), onAnchorRects: (m) => rects.push(m) },
    now: () => clock,
  });
  return { webview, bridge, results, rects };
}
const q = (n: number, over: Partial<InspectAnchorQuery> = {}): InspectAnchorQuery => ({
  key: `a${n}`, route: "/i", tag: "button", selector: `#b${n}`, alternates: [], textAnchor: { tag: "button", text: "t" }, landmark: null, ...over,
});
const rect = { x: 1, y: 2, width: 3, height: 4 };
const ctx = (keys: string[], epoch = 1) => ({ epoch, keys: new Set(keys) });
const okResult = (key: string, over: Record<string, unknown> = {}) => ({ key, match: "selector", agrees: true, rect, visible: true, ...over });

describe("QA G2 embedder: setAnchors sends each key once (a duplicate key would make the guest drop the whole set)", () => {
  it("duplicate keys in one call are rejected and only the first is sent", () => {
    const { bridge, webview } = setup();
    const out = bridge.setAnchors([q(1), q(1, { selector: "#other" }), q(2)]);
    expect(out.sent).toBe(2);
    expect(out.rejected).toEqual(["a1"]);
    const sent = webview.on(INSPECT_CHANNEL.anchors)[0].anchors;
    expect(sent.map((a: any) => a.key)).toEqual(["a1", "a2"]);
    expect(sent[0].selector).toBe("#b1");
  });
});

describe("QA G2 embedder: results in flight across a new document are dropped by the epoch gate", () => {
  it("ready bumps the epoch; a result for the old epoch is dropped, one for the new epoch is delivered", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors([q(1)]);
    webview.emit(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(bridge.anchorEpoch).toBe(2);
    webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 1, results: [okResult("a1")] });
    expect(results).toEqual([]);
    webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 2, results: [okResult("a1")] });
    expect(results).toHaveLength(1);
  });

  it("keys from an older set are unknown after a smaller set replaces it", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors([q(1), q(2)]);
    bridge.setAnchors([q(1)]);
    webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 2, results: [okResult("a1"), okResult("a2")] });
    expect(results).toEqual([]);
  });
});

describe("QA G2 validator: extra hostile shapes", () => {
  const c = ctx(["a1", "a2"]);
  it.each([
    ["epoch as a float", { epoch: 1.5, results: [] }],
    ["epoch as a numeric string", { epoch: "1", results: [] }],
    ["epoch NaN", { epoch: Number.NaN, results: [] }],
    ["epoch Infinity", { epoch: Infinity, results: [] }],
    ["epoch negative zero is not the current epoch", { epoch: -0, results: [] }],
    ["epoch 2^53", { epoch: 2 ** 53, results: [] }],
    ["results as an object with length", { epoch: 1, results: { length: 1, 0: okResult("a1") } }],
    ["results as a string", { epoch: 1, results: "a1" }],
    ["results null", { epoch: 1, results: null }],
    ["a sparse array", { epoch: 1, results: new Array(2) }],
    ["key with a trailing newline", { epoch: 1, results: [okResult("a1\n")] }],
    ["key with a leading space", { epoch: 1, results: [okResult(" a1")] }],
    ["key upper case", { epoch: 1, results: [okResult("A1")] }],
    ["key with a fullwidth digit", { epoch: 1, results: [okResult("a１")] }],
    ["key as a number", { epoch: 1, results: [okResult(1 as never)] }],
    ["key as an array", { epoch: 1, results: [okResult(["a1"] as never)] }],
    ["match as an array", { epoch: 1, results: [okResult("a1", { match: ["selector"] })] }],
    ["match with different case", { epoch: 1, results: [okResult("a1", { match: "Selector" })] }],
    ["match with a trailing space", { epoch: 1, results: [okResult("a1", { match: "selector " })] }],
    ["agrees as 1", { epoch: 1, results: [okResult("a1", { agrees: 1 })] }],
    ["visible as the string true", { epoch: 1, results: [okResult("a1", { visible: "true" })] }],
    ["rect as an array", { epoch: 1, results: [okResult("a1", { rect: [1, 2, 3, 4] })] }],
    ["rect missing a field", { epoch: 1, results: [okResult("a1", { rect: { x: 1, y: 2, width: 3 } })] }],
    ["rect with a string number", { epoch: 1, results: [okResult("a1", { rect: { x: "1", y: 2, width: 3, height: 4 } })] }],
    ["rect Infinity", { epoch: 1, results: [okResult("a1", { rect: { x: 1, y: 2, width: Infinity, height: 4 } })] }],
    ["rect -Infinity", { epoch: 1, results: [okResult("a1", { rect: { x: -Infinity, y: 2, width: 3, height: 4 } })] }],
    ["rect NaN", { epoch: 1, results: [okResult("a1", { rect: { x: Number.NaN, y: 2, width: 3, height: 4 } })] }],
    ["rect just over magnitude", { epoch: 1, results: [okResult("a1", { rect: { x: 1_000_001, y: 2, width: 3, height: 4 } })] }],
    ["rect undefined (absent)", { epoch: 1, results: [{ key: "a1", match: "selector", agrees: true, visible: true }] }],
    ["entry is null", { epoch: 1, results: [null] }],
    ["entry is a number", { epoch: 1, results: [5] }],
    ["entry is an array", { epoch: 1, results: [[]] }],
    ["a valid entry followed by junk (no partial acceptance)", { epoch: 1, results: [okResult("a1"), "junk"] }],
  ])("drops %s", (_n, raw) => {
    expect(validateAnchorResults(raw, c)).toBeNull();
  });

  it("accepts the exact magnitude boundary and a negative origin", () => {
    const m = validateAnchorResults({ epoch: 1, results: [okResult("a1", { rect: { x: -1e6, y: 1e6, width: 1e6, height: 0 } })] }, c);
    expect(m?.results[0]?.rect).toEqual({ x: -1e6, y: 1e6, width: 1e6, height: 0 });
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects %s planted (via JSON.parse, so it is an OWN key) at every nesting level", (hostile) => {
    const nestedRect = JSON.parse(`{"epoch":1,"results":[{"key":"a1","match":"selector","agrees":true,"visible":true,"rect":{"x":1,"y":2,"width":3,"height":4,"${hostile}":{"x":1}}}]}`);
    const nestedEntry = JSON.parse(`{"epoch":1,"results":[{"key":"a1","match":"selector","agrees":true,"visible":true,"rect":{"x":1,"y":2,"width":3,"height":4},"${hostile}":1}]}`);
    const top = JSON.parse(`{"epoch":1,"results":[],"${hostile}":1}`);
    for (const raw of [nestedRect, nestedEntry, top]) {
      expect(validateAnchorResults(raw, c)).toBeNull();
    }
    const rectsEntry = JSON.parse(`{"epoch":1,"rects":[{"key":"a1","visible":true,"rect":{"x":1,"y":2,"width":3,"height":4},"${hostile}":1}]}`);
    expect(validateAnchorRects(rectsEntry, c)).toBeNull();
  });

  it("a planted __proto__ pollution attempt does not pollute Object.prototype or the output", () => {
    const raw = JSON.parse(`{"epoch":1,"results":[{"key":"a1","match":"selector","agrees":true,"visible":true,"rect":{"x":1,"y":2,"width":3,"height":4}}]}`);
    const out = validateAnchorResults(raw, c);
    expect(out).not.toBeNull();
    expect(Object.keys(out!.results[0]!).sort()).toEqual(["agrees", "key", "match", "rect", "visible"]);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("extra unknown keys on an entry are dropped from the output, not rejected", () => {
    const out = validateAnchorResults({ epoch: 1, results: [{ ...okResult("a1"), evil: "<img onerror=1>", note: "x" }], extra: 1 }, c);
    expect(JSON.stringify(out)).not.toContain("evil");
    expect(Object.keys(out!)).toEqual(["epoch", "results"]);
  });

  it("an object with a null prototype is a valid bag", () => {
    const entry = Object.assign(Object.create(null), okResult("a1"));
    expect(validateAnchorResults({ epoch: 1, results: [entry] }, c)).not.toBeNull();
  });

  it("10,000 entries and an oversized payload are rejected quickly", () => {
    const flood = { epoch: 1, results: Array.from({ length: 10_000 }, (_, i) => okResult(`a${i % 1000}`)) };
    const t = performance.now();
    for (let i = 0; i < 100; i++) expect(validateAnchorResults(flood, c)).toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("QA G2 bridge: budgets are independent and exact", () => {
  it("results: 8 pass, the 9th in the same second is dropped; rects still pass; after the window results pass again", () => {
    const { bridge, webview, results, rects } = setup();
    bridge.setAnchors([q(1)]);
    for (let i = 0; i < 12; i++) webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 1, results: [okResult("a1")] });
    expect(results).toHaveLength(INSPECTOR_CAPS.anchorResultsPerSecond);
    for (let i = 0; i < 3; i++) webview.emit(INSPECT_CHANNEL.anchorRects, { epoch: 1, rects: [{ key: "a1", rect, visible: true }] });
    expect(rects).toHaveLength(3);
    clock += 1100;
    webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 1, results: [okResult("a1")] });
    expect(results).toHaveLength(INSPECTOR_CAPS.anchorResultsPerSecond + 1);
  });

  it("rects: exactly 120 pass per second and the flood leaves results, cancel and hover budgets untouched", () => {
    const { bridge, webview, results, rects } = setup();
    bridge.setAnchors([q(1)]);
    for (let i = 0; i < 300; i++) webview.emit(INSPECT_CHANNEL.anchorRects, { epoch: 1, rects: [{ key: "a1", rect, visible: true }] });
    expect(rects).toHaveLength(INSPECTOR_CAPS.anchorRectsPerSecond);
    webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 1, results: [okResult("a1")] });
    expect(results).toHaveLength(1);
  });

  it("junk messages spend budget but never reach the callbacks", () => {
    const { bridge, webview, results } = setup();
    bridge.setAnchors([q(1)]);
    for (let i = 0; i < 8; i++) webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 99, results: [] });
    webview.emit(INSPECT_CHANNEL.anchorResults, { epoch: 1, results: [okResult("a1")] });
    expect(results).toEqual([]); // documented trade-off: junk from the guest process can exhaust its own results budget for a second
  });
});
