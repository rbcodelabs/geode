import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { boot, type GuestHarness } from "../helpers/inspector-guest-harness";

vi.setConfig({ testTimeout: 60_000 });

/** QA (G2, independent): guest tracker cases found by mutation testing and by reading the tracker for gaps. */

const PAGE = `<body><main>
  <h2>Pricing</h2>
  <section class="plans" data-variation="B">
    <div class="card pro" id="pro"><button class="cta primary" data-testid="buy">Buy now</button></div>
    <div class="card" id="free"><span>Free plan</span></div>
  </section></main></body>`;
const ROUTE = "/page.html#frag";
const R = { x: 100, y: 200, width: 160, height: 48 };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let epochCounter = 0;
const q = (over: Partial<InspectAnchorQuery> = {}): InspectAnchorQuery => ({
  key: "a0", route: ROUTE, tag: "button", selector: "[data-testid=\"buy\"]", alternates: [], textAnchor: { tag: "button", text: "Buy now" }, landmark: null, ...over,
});
function setAnchors(h: GuestHarness, anchors: unknown[], over: { epoch?: number; redactText?: boolean } = {}): number {
  const epoch = over.epoch ?? ++epochCounter;
  epochCounter = Math.max(epochCounter, epoch);
  h.deliver(INSPECT_CHANNEL.anchors, { epoch, redactText: over.redactText ?? false, anchors });
  return epoch;
}
const results = (h: GuestHarness) => h.all(INSPECT_CHANNEL.anchorResults);
const lastResults = (h: GuestHarness) => h.last(INSPECT_CHANNEL.anchorResults)?.payload as { epoch: number; results: Array<Record<string, any>> } | undefined;
function fresh(options: Parameters<typeof boot>[1] = {}): GuestHarness {
  epochCounter = 0;
  const h = boot(PAGE, options);
  h.setRect(h.doc.querySelector("button")!, R);
  return h;
}

describe("QA G2 guest: focus uses the natives captured at document start", () => {
  it("a page that replaces Element.prototype.scrollIntoView after the guest started is never called by anchor-focus", () => {
    const h = boot(PAGE, { start: false });
    const real: unknown[] = [];
    h.win.Element.prototype.scrollIntoView = function (this: Element, options?: unknown) { real.push(options); };
    h.start();
    epochCounter = 0;
    h.setRect(h.doc.querySelector("button")!, R);
    const hostile: unknown[] = [];
    h.win.Element.prototype.scrollIntoView = function () { hostile.push("hostile"); };
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "scroll" });
    expect(hostile).toEqual([]);
    expect(real).toHaveLength(1);
  });
});

describe("QA G2 guest: the flash outline is the guest's own and does not feed back into the tracker", () => {
  function flashSetup() {
    const h = boot(PAGE, { start: false });
    h.win.Element.prototype.scrollIntoView = function () {};
    const calls: string[] = [];
    const realQsa = h.win.Document.prototype.querySelectorAll;
    h.win.Document.prototype.querySelectorAll = function (this: Document, s: string) { calls.push(s); return realQsa.call(this, s); } as typeof realQsa;
    h.start();
    epochCounter = 0;
    h.setRect(h.doc.querySelector("button")!, R);
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    return { h, calls, epoch };
  }

  it("inserting the flash host triggers no re-resolve", async () => {
    const { h, calls, epoch } = flashSetup();
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "flash" });
    await settle();
    calls.length = 0;
    h.advance(1100); h.flush(3); await settle(); // still inside the 1.2 s window
    expect(h.shadowRoots[0]!.host.isConnected).toBe(true);
    expect(calls).toEqual([]);
  });

  // DEFECT QA-G2-4 (Low): removeFlash() clears flashHost before the MutationObserver callback for the host's removal is
  // delivered, so isOwnNode() no longer recognizes it and the guest's own removal is treated as a page mutation: one extra
  // resolve pass (debounced) after EVERY flash. Results are unchanged so nothing is sent; the cost is one pass of DOM queries.
  // Remove .fails when the removal record is ignored.
  it("removing the flash host after 1.2 s triggers no re-resolve", async () => {
    const { h, calls, epoch } = flashSetup();
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "flash" });
    await settle();
    calls.length = 0;
    h.advance(1300); await settle(); h.advance(1000); h.flush(3); await settle();
    expect(h.shadowRoots[0]!.host.isConnected).toBe(false);
    expect(calls).toEqual([]);
  });

  it("the outline follows the element after a scroll and disappears when the element is removed", async () => {
    const h = boot(PAGE, { start: false });
    h.win.Element.prototype.scrollIntoView = function () {};
    h.start();
    epochCounter = 0;
    const button = h.doc.querySelector("button")!;
    h.setRect(button, R);
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "flash" });
    const host = h.shadowRoots[0]!.host;
    h.setRect(button, { x: 100, y: 120, width: 160, height: 48 });
    h.fire("scroll", {}, h.win as never);
    h.flush(3);
    expect(h.sheets.at(-1)).toContain("top:120px");
    button.remove();
    h.tick(); // the 1 s re-assertion re-measures
    h.flush(3);
    expect(host.isConnected).toBe(false);
    await settle();
  });

  it("a focus request that arrives while a pass is still running does nothing", () => {
    const h = boot(PAGE, { start: false });
    const scrolled: unknown[] = [];
    h.win.Element.prototype.scrollIntoView = function () { scrolled.push(1); };
    h.start();
    epochCounter = 0;
    const epoch = setAnchors(h, [q()]);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "scroll" }); // no frame has run yet
    expect(scrolled).toEqual([]);
  });
});

describe("QA G2 guest: what the guest sends is exactly the allowlist", () => {
  it("results and rects carry only the documented keys; no text, selector or id of the page comes back", () => {
    const h = fresh();
    setAnchors(h, [q(), q({ key: "a1", selector: "#gone", textAnchor: { tag: "button", text: "Vanished" } })]);
    h.flush(3);
    const msg = lastResults(h)!;
    expect(Object.keys(msg).sort()).toEqual(["epoch", "results", "viewport"]);
    expect(Object.keys(msg.viewport).sort()).toEqual(["height", "width"]); // two numbers, nothing of the page
    for (const r of msg.results) expect(Object.keys(r).sort()).toEqual(["agrees", "key", "match", "rect", "visible"]);
    expect(Object.keys(msg.results[0]!.rect).sort()).toEqual(["height", "width", "x", "y"]);
    h.fire("scroll", {}, h.win as never);
    h.setRect(h.doc.querySelector("button")!, { x: 1, y: 2, width: 3, height: 4 });
    h.fire("scroll", {}, h.win as never);
    h.flush(3);
    const rects = h.last(INSPECT_CHANNEL.anchorRects)!.payload;
    expect(Object.keys(rects).sort()).toEqual(["epoch", "rects", "viewport"]);
    for (const r of rects.rects) expect(Object.keys(r).sort()).toEqual(["key", "rect", "visible"]);
    expect(JSON.stringify(h.sent)).not.toContain("Buy now");
  });
});

describe("QA G2 guest: hostile anchors messages", () => {
  it.each(["__proto__", "constructor", "prototype"])("a hostile own key %s anywhere in the message drops it whole", (k) => {
    const h = fresh();
    const good = JSON.stringify(q());
    for (const raw of [
      `{"epoch":1,"redactText":false,"anchors":[${good}],"${k}":{}}`,
      `{"epoch":1,"redactText":false,"anchors":[${good.replace(/\}$/, `,"${k}":1}`)}]}`,
      `{"epoch":1,"redactText":false,"anchors":[${good.replace('"textAnchor":{', `"textAnchor":{"${k}":1,`)}]}`,
    ]) h.deliver(INSPECT_CHANNEL.anchors, JSON.parse(raw));
    h.flush(5);
    expect(results(h)).toHaveLength(0);
  });

  it("duplicate keys, 101 anchors, a non-increasing epoch and a float epoch are dropped whole", () => {
    const h = fresh();
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 1, redactText: false, anchors: [q(), q()] });
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 1, redactText: false, anchors: Array.from({ length: 101 }, (_, i) => q({ key: `a${i}` })) });
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 1.5, redactText: false, anchors: [q()] });
    h.flush(5);
    expect(results(h)).toHaveLength(0);
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 5, redactText: false, anchors: [q()] });
    h.flush(5);
    expect(lastResults(h)!.epoch).toBe(5);
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 5, redactText: false, anchors: [] });
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 4, redactText: false, anchors: [] });
    h.flush(5);
    expect(lastResults(h)!.epoch).toBe(5);
  });

  it("three sets in one tick: only the last one is resolved and reported", () => {
    const h = fresh();
    setAnchors(h, [q()]);
    setAnchors(h, [q({ key: "a5" })]);
    const last = setAnchors(h, [q({ key: "a7" })]);
    h.flush(5);
    expect(results(h)).toHaveLength(1);
    expect(lastResults(h)).toMatchObject({ epoch: last, results: [{ key: "a7", match: "selector" }] });
  });

  it("100 keys that point at the same element all resolve to it", () => {
    const h = fresh();
    setAnchors(h, Array.from({ length: 100 }, (_, i) => q({ key: `a${i}` })));
    for (let i = 0; i < 20; i++) h.flush(1);
    const res = lastResults(h)!.results;
    expect(res).toHaveLength(100);
    expect(res.every((r) => r.match === "selector" && r.rect.x === R.x)).toBe(true);
  });
});

describe("QA G2 guest: DOM churn that frameworks cause", () => {
  it("an element replaced by an identical clone (a re-render) is found again at its new place", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    const old = h.doc.querySelector("button")!;
    const clone = old.cloneNode(true) as Element;
    old.replaceWith(clone);
    h.setRect(clone, { x: 10, y: 20, width: 30, height: 40 });
    await settle();
    h.advance(300);
    h.flush(5);
    await settle();
    expect(lastResults(h)!.results[0]).toMatchObject({ match: "selector", agrees: true, rect: { x: 10, y: 20, width: 30, height: 40 } });
  });

  it("text edited to something unrelated keeps the pin (approximate: agrees false) and does not jump to a duplicate", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    h.doc.querySelector("button")!.textContent = "Purchase";
    await settle();
    h.advance(300);
    h.flush(5);
    expect(lastResults(h)!.results[0]).toMatchObject({ match: "selector", agrees: false });
  });

  it("a redacted artifact on a page with a hash matches by path only", () => {
    const h = fresh({ url: "https://artifact.test/page.html#/note/Secret%20Title" });
    h.setRect(h.doc.querySelector("button")!, R);
    setAnchors(h, [q({ route: "/page.html", textAnchor: { tag: "button", text: "" } })], { redactText: true });
    h.flush(3);
    expect(lastResults(h)!.results[0]).toMatchObject({ match: "selector", agrees: true });
  });
});
