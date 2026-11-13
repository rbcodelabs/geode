import { describe, expect, it } from "vitest";
import { INSPECTOR_CAPS } from "../../src/artifacts/inspector-protocol";
import { sanitizeAnchorQuery, validateAnchorRects, validateAnchorResults } from "../../src/renderer/artifacts/anchor-validator";

/**
 * Phase 2b-i T1: the guest page is hostile, so anchor results and rects are checked against the current epoch and
 * the keys the embedder actually sent, then REBUILT from an allowlist. Any violation drops the whole message.
 */

const KEYS = new Set(["a0", "a1", "a2"]);
const ctx = { epoch: 4, keys: KEYS };
const rect = { x: 1, y: 2, width: 30, height: 40 };
const good = (key = "a0") => ({ key, match: "selector", agrees: true, rect, visible: true });

describe("validateAnchorResults", () => {
  it("accepts a well formed message and rebuilds it from the allowlist", () => {
    const out = validateAnchorResults({
      epoch: 4,
      results: [good("a0"), { key: "a1", match: "detached", agrees: false, rect: null, visible: false, extra: "dropped" }],
      smuggled: { x: 1 },
    }, ctx);
    expect(out).toEqual({
      epoch: 4,
      results: [good("a0"), { key: "a1", match: "detached", agrees: false, rect: null, visible: false }],
    });
    expect(Object.keys(out!)).toEqual(["epoch", "results"]);
    expect(Object.keys(out!.results[0]!).sort()).toEqual(["agrees", "key", "match", "rect", "visible"]);
  });

  it("accepts an empty result list", () => {
    expect(validateAnchorResults({ epoch: 4, results: [] }, ctx)).toEqual({ epoch: 4, results: [] });
  });

  it.each(["selector", "text", "landmark"] as const)("accepts match %s with a rect", (match) => {
    expect(validateAnchorResults({ epoch: 4, results: [{ ...good(), match }] }, ctx)?.results[0]?.match).toBe(match);
  });

  it.each(["detached", "other-route"] as const)("accepts match %s only with a null rect", (match) => {
    expect(validateAnchorResults({ epoch: 4, results: [{ key: "a0", match, agrees: false, rect: null, visible: false }] }, ctx)).not.toBeNull();
    expect(validateAnchorResults({ epoch: 4, results: [{ key: "a0", match, agrees: false, rect, visible: false }] }, ctx)).toBeNull();
  });

  const rejects: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "results"],
    ["an array", [{ epoch: 4, results: [] }]],
    ["no epoch", { results: [] }],
    ["stale epoch", { epoch: 3, results: [good()] }],
    ["future epoch", { epoch: 5, results: [good()] }],
    ["fractional epoch", { epoch: 4.5, results: [good()] }],
    ["string epoch", { epoch: "4", results: [good()] }],
    ["no results", { epoch: 4 }],
    ["results not an array", { epoch: 4, results: { 0: good() } }],
    ["a key that was never sent", { epoch: 4, results: [good("a9")] }],
    ["a key of the wrong shape", { epoch: 4, results: [good("__proto__")] }],
    ["a duplicate key", { epoch: 4, results: [good("a0"), good("a0")] }],
    ["a numeric key", { epoch: 4, results: [{ ...good(), key: 0 }] }],
    ["an unknown match", { epoch: 4, results: [{ ...good(), match: "guess" }] }],
    ["agrees not a boolean", { epoch: 4, results: [{ ...good(), agrees: "yes" }] }],
    ["visible not a boolean", { epoch: 4, results: [{ ...good(), visible: 1 }] }],
    ["visible with no rect", { epoch: 4, results: [{ key: "a0", match: "detached", agrees: false, rect: null, visible: true }] }],
    ["NaN rect", { epoch: 4, results: [{ ...good(), rect: { ...rect, x: Number.NaN } }] }],
    ["Infinity rect", { epoch: 4, results: [{ ...good(), rect: { ...rect, width: Number.POSITIVE_INFINITY } }] }],
    ["rect magnitude over 1e6", { epoch: 4, results: [{ ...good(), rect: { ...rect, y: 1_000_001 } }] }],
    ["negative size", { epoch: 4, results: [{ ...good(), rect: { ...rect, height: -1 } }] }],
    ["rect with a missing field", { epoch: 4, results: [{ ...good(), rect: { x: 1, y: 2, width: 3 } }] }],
    ["rect as a string", { epoch: 4, results: [{ ...good(), rect: "1,2,3,4" }] }],
    ["a result that is an array", { epoch: 4, results: [[good()]] }],
    ["a result that is null", { epoch: 4, results: [null] }],
  ];
  it.each(rejects)("drops the whole message for %s", (_name, raw) => {
    expect(validateAnchorResults(raw, ctx)).toBeNull();
  });

  it("drops the whole message when ONE entry in the list is bad (no partial acceptance)", () => {
    expect(validateAnchorResults({ epoch: 4, results: [good("a0"), good("a1"), { ...good("a2"), visible: "no" }] }, ctx)).toBeNull();
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects a hostile own key %s on the message and on a result", (hostile) => {
    const onMessage = JSON.parse(`{"epoch":4,"results":[],"${hostile}":{"x":1}}`);
    expect(validateAnchorResults(onMessage, ctx)).toBeNull();
    const onResult = JSON.parse(`{"epoch":4,"results":[{"key":"a0","match":"selector","agrees":true,"rect":null,"visible":false,"${hostile}":1}]}`);
    expect(validateAnchorResults(onResult, ctx)).toBeNull();
    const onRect = JSON.parse(`{"epoch":4,"results":[{"key":"a0","match":"selector","agrees":true,"rect":{"x":1,"y":1,"width":1,"height":1,"${hostile}":1},"visible":true}]}`);
    expect(validateAnchorResults(onRect, ctx)).toBeNull();
  });

  it("caps the list at 100 entries (101 is dropped, 100 accepted)", () => {
    const keys = new Set(Array.from({ length: 101 }, (_, i) => `a${i}`));
    const make = (n: number) => ({ epoch: 4, results: Array.from({ length: n }, (_, i) => good(`a${i}`)) });
    expect(validateAnchorResults(make(100), { epoch: 4, keys })?.results).toHaveLength(100);
    expect(validateAnchorResults(make(101), { epoch: 4, keys })).toBeNull();
  });

  it("drops a 10,000 entry flood without looking at the entries", () => {
    const keys = new Set(Array.from({ length: 100 }, (_, i) => `a${i}`));
    const flood = { epoch: 4, results: Array.from({ length: 10_000 }, (_, i) => good(`a${i % 100}`)) };
    expect(validateAnchorResults(flood, { epoch: 4, keys })).toBeNull();
  });

  it("returns nothing for an epoch with no keys outstanding", () => {
    expect(validateAnchorResults({ epoch: 0, results: [good()] }, { epoch: 0, keys: new Set() })).toBeNull();
  });

  it("does not trust prototype-inherited fields", () => {
    const inherited = Object.create({ epoch: 4, results: [] });
    expect(validateAnchorResults(inherited, ctx)).toBeNull();
  });
});

describe("validateAnchorRects", () => {
  it("accepts and rebuilds", () => {
    const out = validateAnchorRects({ epoch: 4, rects: [{ key: "a1", rect, visible: false, extra: 1 }, { key: "a2", rect: null, visible: false }], junk: 1 }, ctx);
    expect(out).toEqual({ epoch: 4, rects: [{ key: "a1", rect, visible: false }, { key: "a2", rect: null, visible: false }] });
  });

  const rejects: Array<[string, unknown]> = [
    ["stale epoch", { epoch: 2, rects: [] }],
    ["a key never sent", { epoch: 4, rects: [{ key: "a7", rect, visible: true }] }],
    ["a duplicate key", { epoch: 4, rects: [{ key: "a1", rect, visible: true }, { key: "a1", rect, visible: true }] }],
    ["a null rect that claims to be visible", { epoch: 4, rects: [{ key: "a1", rect: null, visible: true }] }],
    ["NaN", { epoch: 4, rects: [{ key: "a1", rect: { ...rect, y: Number.NaN }, visible: true }] }],
    ["a huge number", { epoch: 4, rects: [{ key: "a1", rect: { ...rect, x: 1e9 }, visible: true }] }],
    ["visible not a boolean", { epoch: 4, rects: [{ key: "a1", rect, visible: "true" }] }],
    ["rects not an array", { epoch: 4, rects: "x" }],
  ];
  it.each(rejects)("drops the whole message for %s", (_name, raw) => {
    expect(validateAnchorRects(raw, ctx)).toBeNull();
  });

  it("rejects 101 entries and a 10,000 entry flood", () => {
    const keys = new Set(Array.from({ length: 101 }, (_, i) => `a${i}`));
    const make = (n: number) => ({ epoch: 4, rects: Array.from({ length: n }, (_, i) => ({ key: `a${i % 101}`, rect, visible: true })) });
    expect(validateAnchorRects(make(101), { epoch: 4, keys })).toBeNull();
    expect(validateAnchorRects(make(10_000), { epoch: 4, keys })).toBeNull();
  });

  it("rejects hostile own keys", () => {
    expect(validateAnchorRects(JSON.parse(`{"epoch":4,"rects":[],"__proto__":{"a":1}}`), ctx)).toBeNull();
    expect(validateAnchorRects(JSON.parse(`{"epoch":4,"rects":[{"key":"a1","rect":null,"visible":false,"constructor":1}]}`), ctx)).toBeNull();
  });
});

describe("sanitizeAnchorQuery: what the embedder lets reach the guest", () => {
  const query = {
    key: "a3", route: "/index.html#x", tag: "button", selector: "#buy", alternates: ["button.cta"],
    textAnchor: { tag: "button", text: "Buy now" }, landmark: "Plans",
  };

  it("keeps exactly the allowlisted fields and drops everything else", () => {
    const out = sanitizeAnchorQuery({ ...query, id: "cmt_00000000000000000000000000000001", text: "secret comment", status: "open", ordinal: 3, textAnchor: { ...query.textAnchor, comment: "secret" } });
    expect(out).toEqual(query);
    expect(Object.keys(out!).sort()).toEqual(["alternates", "key", "landmark", "route", "selector", "tag", "textAnchor"]);
    expect(Object.keys(out!.textAnchor).sort()).toEqual(["tag", "text"]);
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ["a key of the wrong shape", { key: "cmt_1" }],
    ["a 4 digit key", { key: "a1000" }],
    ["a route over 512", { route: "x".repeat(513) }],
    ["a bad tag", { tag: "DIV" }],
    ["a selector over 512", { selector: "a".repeat(513) }],
    ["4 alternates", { alternates: ["a", "b", "c", "d"] }],
    ["an alternate over 512", { alternates: ["a".repeat(513)] }],
    ["non-string alternates", { alternates: [1] }],
    ["text anchor text over 80", { textAnchor: { tag: "button", text: "x".repeat(81) } }],
    ["a bad text anchor tag", { textAnchor: { tag: "1x", text: "" } }],
    ["a landmark over 120", { landmark: "x".repeat(121) }],
    ["a missing landmark", { landmark: undefined }],
  ];
  it.each(bad)("rejects %s", (_name, over) => {
    expect(sanitizeAnchorQuery({ ...query, ...over })).toBeNull();
  });

  it("rejects hostile own keys", () => {
    expect(sanitizeAnchorQuery(JSON.parse(`{"key":"a1","route":"/","tag":"p","selector":"p","alternates":[],"textAnchor":{"tag":"p","text":""},"landmark":null,"__proto__":{"x":1}}`))).toBeNull();
  });

  it("agrees with the shared caps", () => {
    expect(INSPECTOR_CAPS.anchors).toBe(100);
    expect(INSPECTOR_CAPS.anchorResultsPerSecond).toBe(8);
    expect(INSPECTOR_CAPS.anchorRectsPerSecond).toBe(120);
    expect(INSPECTOR_CAPS.anchorKeyPattern.test("a99")).toBe(true);
    expect(INSPECTOR_CAPS.anchorKeyPattern.test("a1000")).toBe(false);
    expect(INSPECTOR_CAPS.anchorKeyPattern.test("b1")).toBe(false);
  });
});

describe("guest viewport size (S2 scale)", () => {
  const viewport = { width: 1024, height: 768 };
  it("is rebuilt onto results and rects when present, and absent otherwise", () => {
    expect(validateAnchorResults({ epoch: 4, viewport: { ...viewport, extra: 1 }, results: [] }, ctx)).toEqual({ epoch: 4, viewport, results: [] });
    expect(validateAnchorRects({ epoch: 4, viewport, rects: [] }, ctx)).toEqual({ epoch: 4, viewport, rects: [] });
    expect(Object.keys(validateAnchorRects({ epoch: 4, rects: [] }, ctx)!)).toEqual(["epoch", "rects"]);
  });
  const bad: Array<[string, unknown]> = [
    ["zero width", { width: 0, height: 768 }], ["negative height", { width: 1024, height: -1 }], ["NaN", { width: Number.NaN, height: 768 }],
    ["a huge number", { width: 1e9, height: 768 }], ["strings", { width: "1024", height: "768" }], ["missing height", { width: 1024 }], ["not an object", 5],
  ];
  it.each(bad)("drops the whole message for a viewport with %s", (_n, v) => {
    expect(validateAnchorResults({ epoch: 4, viewport: v, results: [] }, ctx)).toBeNull();
    expect(validateAnchorRects({ epoch: 4, viewport: v, rects: [] }, ctx)).toBeNull();
  });
});
