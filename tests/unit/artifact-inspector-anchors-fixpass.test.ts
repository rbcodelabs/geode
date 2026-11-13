import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { boot, type GuestHarness } from "../helpers/inspector-guest-harness";

vi.setConfig({ testTimeout: 60_000 });

/**
 * G2 fix pass: B1 (the guest must never exceed the embedder's anchor-results budget, and a dropped final state must
 * self-heal), A1 truncated scans, A2 rect clamp, A4 partial text index.
 */

const PAGE = `<body><main><section id="list"><button data-testid="buy" class="cta">Buy now</button></section><p id="note">Annual billing</p></main></body>`;
const ROUTE = "/page.html#frag";
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let epochCounter = 0;
const q = (over: Partial<InspectAnchorQuery> = {}): InspectAnchorQuery => ({
  key: "a0", route: ROUTE, tag: "button", selector: "[data-testid=\"buy\"]", alternates: [],
  textAnchor: { tag: "button", text: "Buy now" }, landmark: null, ...over,
});
const results = (h: GuestHarness) => h.all(INSPECT_CHANNEL.anchorResults);
const lastResults = (h: GuestHarness) => h.last(INSPECT_CHANNEL.anchorResults)?.payload as { epoch: number; results: Array<Record<string, any>> } | undefined;

function spyBoot(html = PAGE): { h: GuestHarness; qsa: string[] } {
  epochCounter = 0;
  const h = boot(html, { start: false });
  const qsa: string[] = [];
  const real = h.win.Document.prototype.querySelectorAll;
  h.win.Document.prototype.querySelectorAll = function (this: Document, selector: string) { qsa.push(selector); return real.call(this, selector); } as typeof real;
  h.start();
  return { h, qsa };
}
function setAnchors(h: GuestHarness, anchors: InspectAnchorQuery[]): number {
  const epoch = ++epochCounter;
  h.deliver(INSPECT_CHANNEL.anchors, { epoch, redactText: false, anchors });
  return epoch;
}
/** Largest number of results messages inside any sliding window of 1000 ms (the embedder's own window rule). */
function maxPerSecond(stamps: number[]): number {
  let max = 0;
  for (let i = 0; i < stamps.length; i++) {
    let n = 0;
    for (let j = i; j < stamps.length && stamps[j]! - stamps[i]! < 1000; j++) n++;
    max = Math.max(max, n);
  }
  return max;
}

describe("B1: results never exceed the embedder budget, and the final state is delivered", () => {
  it("a virtualized list that re-creates the anchored node every frame (with a scroll each frame)", async () => {
    const { h, qsa } = spyBoot();
    const rect = { x: 10, y: 20, width: 100, height: 30 };
    h.setRect(h.doc.querySelector("button")!, rect);
    setAnchors(h, [q()]);
    h.flush(3);
    const stamps: number[] = [];
    let seen = results(h).length;
    stamps.push(...Array.from({ length: seen }, () => h.now()));
    const list = h.doc.getElementById("list")!;
    for (let frame = 0; frame < 600; frame++) {
      const fresh = h.doc.createElement("button");
      fresh.setAttribute("data-testid", "buy");
      fresh.textContent = frame % 2 === 0 ? "Buy now" : "Buy now!"; // results differ every other frame
      h.setRect(fresh, { ...rect, y: 20 + (frame % 7) });
      list.replaceChildren(fresh);
      h.win.dispatchEvent(new h.win.Event("scroll"));
      await settle();
      h.flush(2);
      h.advance(16);
      for (let n = results(h).length; seen < n; seen++) stamps.push(h.now());
    }
    expect(maxPerSecond(stamps)).toBeLessThanOrEqual(INSPECTOR_CAPS.anchorResultsPerSecond);
    expect(qsa.length).toBeLessThanOrEqual(Math.ceil(600 * 16 / INSPECTOR_CAPS.anchorDebounceMillis) + 3); // bounded passes
    // the churn stops: the final state arrives
    const final = h.doc.createElement("button");
    final.setAttribute("data-testid", "buy");
    final.textContent = "Buy now";
    h.setRect(final, { x: 7, y: 8, width: 9, height: 10 });
    list.replaceChildren(final);
    await settle();
    h.advance(3000); h.flush(3); h.advance(1000); h.flush(3);
    expect(lastResults(h)!.results[0]).toMatchObject({ match: "selector", agrees: true, rect: { x: 7, y: 8, width: 9, height: 10 } });
  });

  it("a synthetic popstate/hashchange loop cannot make passes or results run away", async () => {
    const { h, qsa } = spyBoot();
    h.setRect(h.doc.querySelector("button")!, { x: 1, y: 2, width: 3, height: 4 });
    setAnchors(h, [q()]);
    h.flush(3);
    qsa.length = 0;
    const stamps: number[] = [];
    let seen = results(h).length;
    for (let frame = 0; frame < 400; frame++) {
      // the route flips every frame so every pass has a different outcome
      h.win.history.replaceState({}, "", frame % 2 === 0 ? "/page.html#a" : "/page.html#frag");
      h.win.dispatchEvent(new h.win.Event("popstate"));
      h.win.dispatchEvent(new h.win.Event("hashchange"));
      h.flush(2);
      h.advance(16);
      for (let n = results(h).length; seen < n; seen++) stamps.push(h.now());
    }
    expect(maxPerSecond(stamps)).toBeLessThanOrEqual(INSPECTOR_CAPS.anchorResultsPerSecond);
    expect(qsa.length).toBeLessThanOrEqual(Math.ceil(400 * 16 / INSPECTOR_CAPS.anchorMinPassGapMillis) + 3);
    // settle on the matching route: the final state is delivered
    h.win.history.replaceState({}, "", "/page.html#frag");
    h.win.dispatchEvent(new h.win.Event("popstate"));
    h.advance(1500); h.flush(3); h.advance(1500); h.flush(3);
    expect(lastResults(h)!.results[0].match).toBe("selector");
  });

  it("results are spaced: a burst of different outcomes yields a trailing send of the LATEST state", async () => {
    const { h } = spyBoot();
    const button = h.doc.querySelector("button")!;
    h.setRect(button, { x: 1, y: 1, width: 1, height: 1 });
    setAnchors(h, [q()]);
    h.flush(3);
    const first = results(h).length;
    for (const y of [10, 20, 30]) {
      h.setRect(button, { x: 1, y, width: 1, height: 1 });
      h.win.dispatchEvent(new h.win.Event("hashchange")); // forces a pass whose result changes
      h.flush(3);
    }
    expect(results(h).length - first).toBeLessThanOrEqual(1); // not one send per pass inside the spacing window
    h.advance(INSPECTOR_CAPS.anchorMinPassGapMillis + INSPECTOR_CAPS.anchorResultsSpacingMillis + 50);
    h.flush(3);
    h.advance(INSPECTOR_CAPS.anchorResultsSpacingMillis + 5);
    h.flush(2);
    expect(lastResults(h)!.results[0].rect.y).toBe(30);
  });

  it("the 1 s re-assertion re-sends the cached results (a dropped message self-heals), spaced like any other", () => {
    const { h } = spyBoot();
    h.setRect(h.doc.querySelector("button")!, { x: 1, y: 2, width: 3, height: 4 });
    setAnchors(h, [q()]);
    h.flush(3);
    expect(results(h)).toHaveLength(1);
    const before = lastResults(h);
    h.advance(1000);
    h.tick();
    h.advance(INSPECTOR_CAPS.anchorResultsSpacingMillis + 5);
    h.flush(3);
    expect(results(h)).toHaveLength(2);
    expect(lastResults(h)).toEqual(before);
    // an empty set has nothing to resend
    setAnchors(h, []);
    h.flush(3);
    const n = results(h).length;
    h.tick(); h.advance(1000); h.flush(3);
    expect(results(h)).toHaveLength(n);
  });
});

describe("A1: a truncated text scan never claims an agreeing unique match", () => {
  it("a unique hit inside a truncated window reports agrees false", () => {
    const n = INSPECTOR_CAPS.anchorTextScan + 10;
    const spans = Array.from({ length: n }, (_, i) => `<span>row ${i}</span>`).join("");
    epochCounter = 0;
    const h = boot(`<body>${spans}</body>`);
    h.setRect(h.doc.querySelectorAll("span")[3]!, { x: 1, y: 1, width: 5, height: 5 });
    setAnchors(h, [q({ tag: "span", selector: "#gone", textAnchor: { tag: "span", text: "row 3" } })]);
    h.flush(50);
    expect(lastResults(h)!.results[0]).toMatchObject({ match: "text", agrees: false });
  });

  it("a complete scan still agrees", () => {
    epochCounter = 0;
    const h = boot(`<body>${Array.from({ length: 30 }, (_, i) => `<span>row ${i}</span>`).join("")}</body>`);
    h.setRect(h.doc.querySelectorAll("span")[3]!, { x: 1, y: 1, width: 5, height: 5 });
    setAnchors(h, [q({ tag: "span", selector: "#gone", textAnchor: { tag: "span", text: "row 3" } })]);
    h.flush(5);
    expect(lastResults(h)!.results[0]).toMatchObject({ match: "text", agrees: true });
  });
});

describe("A2: rects are clamped so one element cannot make the embedder drop a message", () => {
  it("a huge rect is clamped to the protocol magnitude in results and in rect reports", () => {
    epochCounter = 0;
    const h = boot(PAGE);
    const button = h.doc.querySelector("button")!;
    h.setRect(button, { x: -5e9, y: 2e9, width: 9e9, height: 3 });
    setAnchors(h, [q()]);
    h.flush(3);
    const r = lastResults(h)!.results[0]!.rect;
    for (const v of [r.x, r.y, r.width, r.height]) expect(Math.abs(v)).toBeLessThanOrEqual(INSPECTOR_CAPS.numberMagnitude);
    h.setRect(button, { x: 1e12, y: 0, width: 1, height: 1 });
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.flush(3);
    const rects = h.last(INSPECT_CHANNEL.anchorRects)!.payload.rects[0].rect;
    expect(Math.abs(rects.x)).toBeLessThanOrEqual(INSPECTOR_CAPS.numberMagnitude);
  });
});

describe("A4: a text read that throws still leaves a (partial) index for the rest of the pass", () => {
  it("does not rescan from the start for every later anchor of the same tag", () => {
    epochCounter = 0;
    const h = boot(`<body>${Array.from({ length: 40 }, (_, i) => `<span>item ${i}</span>`).join("")}</body>`, { start: false });
    let reads = 0;
    const desc = Object.getOwnPropertyDescriptor(h.win.CharacterData.prototype, "data")!;
    Object.defineProperty(h.win.CharacterData.prototype, "data", {
      ...desc,
      get(this: CharacterData) { reads++; if (this.nodeValue === "item 20") throw new Error("boom"); return desc.get!.call(this); },
    });
    h.start();
    h.setRect(h.doc.querySelectorAll("span")[2]!, { x: 1, y: 1, width: 1, height: 1 });
    setAnchors(h, [
      q({ key: "a0", tag: "span", selector: "#gone", textAnchor: { tag: "span", text: "item 30" } }), // hits the throw
      q({ key: "a1", tag: "span", selector: "#gone", textAnchor: { tag: "span", text: "item 2" } }),  // before the throw
      q({ key: "a2", tag: "span", selector: "#gone", textAnchor: { tag: "span", text: "item 3" } }),
    ]);
    h.flush(10);
    const res = lastResults(h)!.results;
    expect(res[0]!.match).toBe("detached");
    expect(res[1]).toMatchObject({ match: "text", agrees: false }); // partial index: uniqueness is not proven
    expect(reads).toBeLessThan(40 + 10); // one scan up to the throw (+ the reads of the few non-scan steps), not three
  });
});
