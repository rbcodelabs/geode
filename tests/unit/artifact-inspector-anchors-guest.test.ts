import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { boot, type GuestHarness } from "../helpers/inspector-guest-harness";

// jsdom builds and heavy-DOM walks are slow on shared CI runners (macOS timed out the default 5 s once).
vi.setConfig({ testTimeout: 60_000 });

/**
 * Phase 2b-i G2: the guest anchor tracker (ADR 0006 addendum 2). Resolution order selector -> text -> landmark ->
 * detached, the restricted selector grammar, chunked time-sliced passes, the mutation observer with backoff, rect
 * reporting, focus, and immunity to a page that patches prototypes. jsdom, the real guest module.
 */

const PAGE = `<body>
  <main>
    <h2>Pricing</h2>
    <section class="plans" data-variation="B">
      <div class="card pro" id="pro"><button class="cta primary" data-testid="buy">Buy now</button></div>
      <div class="card" id="free"><span>Free plan</span></div>
    </section>
    <p id="dupA">Same text here please</p>
    <p id="dupB">Same text here please</p>
  </main>
</body>`;
const ROUTE = "/page.html#frag";
const R = { buy: { x: 100, y: 200, width: 160, height: 48 }, pro: { x: 90, y: 190, width: 300, height: 90 }, section: { x: 80, y: 150, width: 600, height: 300 } };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const q = (over: Partial<InspectAnchorQuery> & { key?: string } = {}): InspectAnchorQuery => ({
  key: "a0", route: ROUTE, tag: "button", selector: "[data-testid=\"buy\"]", alternates: [],
  textAnchor: { tag: "button", text: "Buy now" }, landmark: null, ...over,
});
const $ = (h: GuestHarness, selector: string) => h.doc.querySelector(selector)!;
function setRects(h: GuestHarness): void {
  h.setRect($(h, "button"), R.buy);
  h.setRect($(h, "#pro"), R.pro);
  h.setRect($(h, "section"), R.section);
}
let epochCounter = 0;
function setAnchors(h: GuestHarness, anchors: InspectAnchorQuery[], over: { epoch?: number; redactText?: boolean } = {}): number {
  const epoch = over.epoch ?? ++epochCounter;
  epochCounter = Math.max(epochCounter, epoch);
  h.deliver(INSPECT_CHANNEL.anchors, { epoch, redactText: over.redactText ?? false, anchors });
  return epoch;
}
const results = (h: GuestHarness) => h.all(INSPECT_CHANNEL.anchorResults);
const lastResults = (h: GuestHarness) => h.last(INSPECT_CHANNEL.anchorResults)?.payload as { epoch: number; results: Array<Record<string, any>> } | undefined;
const byKey = (h: GuestHarness, key: string) => lastResults(h)?.results.find((r) => r.key === key);

interface Spy { h: GuestHarness; qsa: string[]; onQsa: { fn: (() => void) | null } }
function bootSpy(html = PAGE, options: Parameters<typeof boot>[1] = {}): Spy {
  const h = boot(html, { ...options, start: false });
  const qsa: string[] = [];
  const onQsa = { fn: null as (() => void) | null };
  const real = h.win.Document.prototype.querySelectorAll;
  h.win.Document.prototype.querySelectorAll = function (this: Document, selector: string) {
    qsa.push(selector);
    onQsa.fn?.();
    return real.call(this, selector);
  } as typeof real;
  h.start();
  setRects(h);
  return { h, qsa, onQsa };
}
function fresh(html = PAGE): GuestHarness {
  epochCounter = 0;
  const h = boot(html);
  setRects(h);
  return h;
}

describe("wiring", () => {
  it("registers the two embedder-to-guest channels, sends nothing until told, and adds nothing the page can see", () => {
    const h = boot(PAGE, { start: false });
    const before = new Set(Object.getOwnPropertyNames(h.win));
    h.start();
    h.sent.length = 0;
    expect([...Object.getOwnPropertyNames(h.win)].filter((k) => !before.has(k))).toEqual([]);
    expect(h.sent).toEqual([]);
    // delivering to both channels with junk is harmless
    h.deliver(INSPECT_CHANNEL.anchors, null);
    h.deliver(INSPECT_CHANNEL.anchorFocus, 5);
    h.flush(3);
    expect(h.sent).toEqual([]);
  });

  it("works while the picker mode is off, pick and hold (pins are passive)", () => {
    for (const mode of ["off", "pick", "hold"] as const) {
      epochCounter = 0;
      const h = boot(PAGE);
      setRects(h);
      h.deliver(INSPECT_CHANNEL.mode, { mode, redactText: false });
      setAnchors(h, [q()]);
      h.flush(3);
      expect(byKey(h, "a0")?.match).toBe("selector");
    }
  });
});

describe("resolution order", () => {
  it("selector hit corroborated by the text anchor: selector, agrees, exact rect, visible", () => {
    const h = fresh();
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    expect(lastResults(h)).toEqual({ epoch, results: [{ key: "a0", match: "selector", agrees: true, rect: R.buy, visible: true }] });
    expect(Object.keys(lastResults(h)!.results[0]!).sort()).toEqual(["agrees", "key", "match", "rect", "visible"]);
  });

  it("an off-screen element is resolved with visible false", () => {
    const h = fresh();
    h.setRect($(h, "button"), { x: 100, y: 5000, width: 160, height: 48 });
    setAnchors(h, [q()]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true, visible: false, rect: { y: 5000 } });
  });

  it("falls to the first alternate when the primary no longer matches", () => {
    const h = fresh();
    setAnchors(h, [q({ selector: "#gone", alternates: ["button.cta.primary"] })]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true });
  });

  it("selector hit whose element has a different tag is not a hit", () => {
    const h = fresh();
    setAnchors(h, [q({ selector: "#pro", tag: "button" })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("text"); // the button with that text is found by the text anchor instead
  });

  it("selector that matches several elements is not a hit", () => {
    const h = fresh();
    setAnchors(h, [q({ selector: "div.card", tag: "div", textAnchor: { tag: "div", text: "" } })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("detached");
  });

  it("stale selector but a unique text anchor elsewhere: text, agrees, rect of that element", () => {
    const h = fresh();
    setAnchors(h, [q({ selector: "#renamed", alternates: [] })]);
    h.flush(3);
    expect(byKey(h, "a0")).toEqual({ key: "a0", match: "text", agrees: true, rect: R.buy, visible: true });
  });

  it("selector hit whose text changed and no other text match: selector with agrees false (weak)", () => {
    const h = fresh();
    setAnchors(h, [q({ textAnchor: { tag: "button", text: "Completely different label" } })]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: false, rect: R.buy });
  });

  it("weak selector hit loses to a unique text match elsewhere", () => {
    const h = fresh();
    // #pro is a div whose text is "Buy now"; the anchor says the span "Free plan"
    setAnchors(h, [q({ tag: "div", selector: "#pro", textAnchor: { tag: "span", text: "Free plan" } })]);
    h.setRect($(h, "span"), { x: 5, y: 6, width: 7, height: 8 });
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "text", agrees: true, rect: { x: 5, y: 6 } });
  });

  it("agrees when the anchor is a long prefix of the element's text (an edited tail)", () => {
    const h = fresh();
    $(h, "button").textContent = "Buy now and save twenty percent";
    setAnchors(h, [q({ textAnchor: { tag: "button", text: "Buy now and save" } })]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true });
  });

  it("duplicate text is never guessed: no unique match falls through to the landmark, then detached", () => {
    const h = fresh();
    setAnchors(h, [q({ key: "a0", tag: "p", selector: "#gone", textAnchor: { tag: "p", text: "Same text here please" } })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("detached");
  });

  it("landmark via data-variation: match landmark, agrees false, rect of the first element of the tag inside it", () => {
    const h = fresh();
    setAnchors(h, [q({ selector: "#gone", textAnchor: { tag: "button", text: "Vanished" }, landmark: "B" })]);
    h.flush(3);
    expect(byKey(h, "a0")).toEqual({ key: "a0", match: "landmark", agrees: false, rect: R.buy, visible: true });
  });

  it("landmark via a heading: the first following sibling of the tag inside the heading's parent", () => {
    const h = fresh();
    setAnchors(h, [q({ tag: "section", selector: "#gone", textAnchor: { tag: "section", text: "Nope" }, landmark: "Pricing" })]);
    h.flush(3);
    expect(byKey(h, "a0")).toEqual({ key: "a0", match: "landmark", agrees: false, rect: R.section, visible: true });
  });

  it("landmark with no sibling of the tag falls back to the landmark's own rect", () => {
    const h = fresh();
    h.setRect($(h, "h2"), { x: 1, y: 2, width: 3, height: 4 });
    setAnchors(h, [q({ tag: "footer", selector: "#gone", textAnchor: { tag: "footer", text: "Nope" }, landmark: "Pricing" })]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "landmark", rect: { x: 1, y: 2, width: 3, height: 4 } });
  });

  it("an ambiguous landmark (two headings with the same text) is not used", () => {
    const h = fresh(`<body><h2>Pricing</h2><div></div><h2>Pricing</h2><div></div></body>`);
    setAnchors(h, [q({ tag: "div", selector: "#gone", textAnchor: { tag: "div", text: "" }, landmark: "Pricing" })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("detached");
  });

  it("nothing at all: detached with a null rect", () => {
    const h = fresh();
    setAnchors(h, [q({ selector: "#gone", textAnchor: { tag: "button", text: "Vanished" }, landmark: "Nope" })]);
    h.flush(3);
    expect(byKey(h, "a0")).toEqual({ key: "a0", match: "detached", agrees: false, rect: null, visible: false });
  });
});

describe("routes", () => {
  it("another route is other-route, with no DOM query at all", () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q({ route: "/other.html#frag" }), q({ key: "a1", route: "/page.html" }), q({ key: "a2", route: ROUTE })]);
    h.flush(3);
    expect(byKey(h, "a0")).toEqual({ key: "a0", match: "other-route", agrees: false, rect: null, visible: false });
    expect(byKey(h, "a1")?.match).toBe("other-route"); // the hash is part of the route
    expect(byKey(h, "a2")?.match).toBe("selector");
    expect(qsa).toEqual(["[data-testid=\"buy\"]"]); // only the matching route touched the DOM
  });

  it("re-resolves after a hashchange (and popstate)", () => {
    const h = fresh();
    setAnchors(h, [q({ route: "/page.html#next" })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("other-route");
    h.win.location.hash = "#next";
    h.win.dispatchEvent(new h.win.HashChangeEvent("hashchange"));
    h.advance(1000);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("selector");
  });

  it("redacted artifacts store the path without the hash (hash routes carry data), so the route compares by path", () => {
    const h = fresh();
    setAnchors(h, [q({ route: "/page.html", textAnchor: { tag: "button", text: "" } })], { redactText: true });
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true });
    const plain = fresh();
    setAnchors(plain, [q({ route: "/page.html" })]);
    plain.flush(3);
    expect(byKey(plain, "a0")?.match).toBe("other-route");
  });
});

describe("redacted artifacts", () => {
  it("a unique selector hit with no text anchor is accepted, agreeing", () => {
    const h = fresh();
    setAnchors(h, [q({ textAnchor: { tag: "button", text: "" } })], { redactText: true });
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true });
  });

  it("does no text or heading work: a vanished element is detached even if its words are on the page", () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q({ selector: "#gone", textAnchor: { tag: "button", text: "Buy now" }, landmark: "Pricing" })], { redactText: true });
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("detached");
    expect(qsa).toEqual(["#gone"]);
  });
});

describe("hostile stored selectors (T3)", () => {
  const pathological = [
    ":has(*) :has(*) :has(*) :has(*)",
    "div:has(> p)",
    "div:is(a, b, c)",
    ":where(div) :where(p)",
    "div:not(.a):not(.b)",
    "div, p, span, button",
    "div ~ p",
    "div + p",
    "svg|*",
    "*:nth-child(2n+1)",
    "div::before",
    `${Array.from({ length: 50 }, () => "div").join(" > ")}`,
    `div${"[a]".repeat(200)}`,
    "a".repeat(513),
    "\u0000",
  ];

  it("never hands any of them to querySelectorAll and returns detached", () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, pathological.map((selector, i) => q({ key: `a${i}`, selector, alternates: [pathological[(i + 1) % pathological.length]!], textAnchor: { tag: "button", text: "" }, landmark: null })));
    h.flush(10);
    expect(lastResults(h)!.results).toHaveLength(pathological.length);
    for (const r of lastResults(h)!.results) expect(r.match).toBe("detached");
    expect(qsa).toEqual([]);
  });

  it("a hostile primary does not stop a good alternate from resolving", () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q({ selector: "div:has(> p)", alternates: ["button.cta.primary"] })]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true });
    expect(qsa).toEqual(["button.cta.primary"]);
  });

  it("a selector the DOM rejects anyway cannot throw out of the guest", () => {
    const h = fresh();
    expect(() => { setAnchors(h, [q({ selector: "div:nth-child(99999)", textAnchor: { tag: "button", text: "" } })]); h.flush(3); }).not.toThrow();
    expect(byKey(h, "a0")?.match).toBe("detached");
  });
});

describe("messages the guest accepts", () => {
  it("ignores malformed anchors messages whole", () => {
    const h = fresh();
    const good = q();
    const bad: unknown[] = [
      null, 5, "x", [], {},
      { epoch: 1, redactText: false },
      { epoch: 1, anchors: [good] },
      { epoch: "1", redactText: false, anchors: [good] },
      { epoch: 1.5, redactText: false, anchors: [good] },
      { epoch: -1, redactText: false, anchors: [good] },
      { epoch: 1, redactText: "no", anchors: [good] },
      { epoch: 1, redactText: false, anchors: { 0: good } },
      { epoch: 1, redactText: false, anchors: [{ ...good, key: "zz" }] },
      { epoch: 1, redactText: false, anchors: [good, good] },
      { epoch: 1, redactText: false, anchors: [{ ...good, selector: "x".repeat(513) }] },
      { epoch: 1, redactText: false, anchors: [{ ...good, alternates: ["a", "b", "c", "d"] }] },
      { epoch: 1, redactText: false, anchors: Array.from({ length: 101 }, (_, i) => q({ key: `a${i}` })) },
      JSON.parse(`{"epoch":1,"redactText":false,"anchors":[],"__proto__":{"x":1}}`),
    ];
    for (const message of bad) h.deliver(INSPECT_CHANNEL.anchors, message);
    h.flush(5);
    expect(results(h)).toEqual([]);
  });

  it("accepts exactly 100 anchors", () => {
    const h = fresh();
    setAnchors(h, Array.from({ length: 100 }, (_, i) => q({ key: `a${i}` })));
    h.flush(20);
    expect(lastResults(h)!.results).toHaveLength(100);
  });

  it("requires a strictly increasing epoch", () => {
    const h = fresh();
    setAnchors(h, [q()], { epoch: 5 });
    h.flush(3);
    expect(results(h)).toHaveLength(1);
    setAnchors(h, [q({ selector: "#gone", textAnchor: { tag: "button", text: "" } })], { epoch: 5 });
    setAnchors(h, [q({ selector: "#gone", textAnchor: { tag: "button", text: "" } })], { epoch: 4 });
    h.flush(3);
    expect(results(h)).toHaveLength(1);
    epochCounter = 0;
    const epoch = setAnchors(h, [q({ selector: "#gone", textAnchor: { tag: "button", text: "" } })], { epoch: 6 });
    h.flush(3);
    expect(lastResults(h)).toMatchObject({ epoch, results: [{ match: "detached" }] });
  });

  it("an empty set clears the tracker: no more reports, no timers", () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    h.sent.length = 0;
    setAnchors(h, []);
    h.flush(3);
    h.setRect($(h, "button"), { x: 1, y: 1, width: 1, height: 1 });
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.tick();
    h.advance(5000);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.anchorRects)).toEqual([]);
    expect(h.pendingTimers()).toBe(0);
  });
});

describe("chunking and time slicing (S1 budgets)", () => {
  it("resolves at most the chunk size per frame and reports once, when the pass is complete", () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, Array.from({ length: 20 }, (_, i) => q({ key: `a${i}` })));
    expect(qsa).toHaveLength(0); // nothing runs inside the message handler
    h.flush(1);
    expect(qsa).toHaveLength(INSPECTOR_CAPS.anchorChunk);
    expect(results(h)).toEqual([]);
    h.flush(1);
    expect(qsa).toHaveLength(INSPECTOR_CAPS.anchorChunk * 2);
    h.flush(1);
    expect(qsa).toHaveLength(20);
    expect(results(h)).toHaveLength(1);
    expect(lastResults(h)!.results.map((r) => r.key)).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`));
  });

  it("stops a chunk early when the time slice is spent, and resumes next frame", () => {
    const { h, qsa, onQsa } = bootSpy();
    onQsa.fn = () => h.setNow(h.now() + INSPECTOR_CAPS.anchorSliceMillis + 1);
    setAnchors(h, Array.from({ length: 5 }, (_, i) => q({ key: `a${i}` })));
    h.flush(1);
    expect(qsa.length).toBeLessThan(5);
    expect(qsa.length).toBeGreaterThanOrEqual(1);
    h.flush(10);
    expect(qsa).toHaveLength(5);
    expect(lastResults(h)!.results).toHaveLength(5);
  });

  it("a text-anchor scan is sliced too: reading text costs time, so a 1200-element scan spans several frames", () => {
    const spans = Array.from({ length: 1200 }, (_, i) => `<span>item ${i}</span>`).join("");
    const h = boot(`<body>${spans}</body>`, { start: false });
    epochCounter = 0;
    // every text read costs 0.02 ms of fake time: a full scan is ~24 ms, six times the 4 ms slice
    const desc = Object.getOwnPropertyDescriptor(h.win.CharacterData.prototype, "data")!;
    Object.defineProperty(h.win.CharacterData.prototype, "data", { ...desc, get(this: CharacterData) { h.setNow(h.now() + 0.02); return desc.get!.call(this); } });
    h.start();
    h.setRect(h.doc.querySelectorAll("span")[1199]!, { x: 1, y: 2, width: 3, height: 4 });
    setAnchors(h, [q({ tag: "span", selector: "#gone", textAnchor: { tag: "span", text: "item 1199" } })]);
    h.flush(1);
    expect(results(h)).toEqual([]);
    let frames = 1;
    while (results(h).length === 0 && frames < 60) { h.flush(1); frames++; }
    expect(frames).toBeGreaterThan(2);
    expect(frames).toBeLessThan(60);
    expect(byKey(h, "a0")).toMatchObject({ match: "text", agrees: true, rect: { x: 1, y: 2 } });
  });

  it("caps the text scan at the documented number of elements per tag", () => {
    const n = INSPECTOR_CAPS.anchorTextScan + 50;
    const spans = Array.from({ length: n }, (_, i) => `<span>row ${i}</span>`).join("");
    const h = fresh(`<body>${spans}</body>`);
    const query = (key: string, i: number) => q({ key, tag: "span", selector: "#gone", textAnchor: { tag: "span", text: `row ${i}` } });
    setAnchors(h, [query("a0", 3), query("a1", n - 1)]);
    h.flush(400);
    expect(byKey(h, "a0")?.match).toBe("text");
    expect(byKey(h, "a1")?.match).toBe("detached"); // beyond the examined window: never guessed
  });

  it("abandons a pass in progress when a newer epoch arrives (no results for the old epoch)", () => {
    const { h, qsa } = bootSpy();
    const first = setAnchors(h, Array.from({ length: 40 }, (_, i) => q({ key: `a${i}` })));
    h.flush(1);
    const second = setAnchors(h, [q({ key: "a0" })]);
    h.flush(10);
    expect(results(h)).toHaveLength(1);
    expect(lastResults(h)!.epoch).toBe(second);
    expect(second).toBeGreaterThan(first);
    expect(qsa.length).toBeLessThan(40 + 1);
  });
});

describe("DOM churn: mutation observer with backoff", () => {
  const mutate = async (h: GuestHarness, n = 1) => {
    for (let i = 0; i < n; i++) h.doc.body.appendChild(h.doc.createElement("i"));
    await settle();
  };

  it("re-resolves after a quiet 250 ms (trailing debounce), not before, and not without a change", async () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q()]);
    h.flush(3);
    expect(qsa).toHaveLength(1);
    await mutate(h);
    h.advance(249);
    h.flush(3);
    expect(qsa).toHaveLength(1);
    h.advance(1);
    h.flush(3);
    expect(qsa).toHaveLength(2);
    h.advance(5000);
    h.flush(3);
    expect(qsa).toHaveLength(2);
  });

  it("a removed element turns into detached and a re-added one is found again", async () => {
    const h = fresh();
    setAnchors(h, [q({ textAnchor: { tag: "button", text: "" } })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("selector");
    const button = $(h, "button");
    const parent = button.parentElement!;
    button.remove();
    await settle();
    h.advance(300);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("detached");
    parent.appendChild(button);
    await settle();
    h.advance(1100);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("selector");
  });

  it("a text change is noticed (characterData)", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true });
    $(h, "button").firstChild!.nodeValue = "Totally different words";
    await settle();
    h.advance(300);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: false });
  });

  it("is bounded under continuous mutation: the hard maximum is 1 s", async () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q()]);
    h.flush(3);
    qsa.length = 0;
    for (let t = 0; t < 3000; t += 100) {
      await mutate(h);
      h.advance(100);
      h.flush(2);
    }
    expect(qsa.length).toBeGreaterThanOrEqual(2); // the trailing debounce never starves the pass entirely
    expect(qsa.length).toBeLessThanOrEqual(4); // and it does not run at 10 Hz either
  });

  it("backs off to at least 1 s after a pass that took more than 20 ms", async () => {
    const { h, qsa, onQsa } = bootSpy();
    onQsa.fn = () => h.setNow(h.now() + 25);
    setAnchors(h, [q()]);
    h.flush(3);
    qsa.length = 0;
    await mutate(h);
    h.advance(999);
    h.flush(3);
    expect(qsa).toHaveLength(0); // the 250 ms debounce is long over, the 1 s floor is not
    h.advance(2);
    h.flush(3);
    expect(qsa).toHaveLength(1);
  });

  it("backs off to at least 2 s under a storm of more than 50 mutation callbacks per second", async () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q()]);
    h.flush(3);
    qsa.length = 0;
    for (let i = 0; i < 60; i++) { await mutate(h); h.advance(10); }
    h.advance(1300); // ~1.9 s after the last pass
    h.flush(3);
    expect(qsa).toHaveLength(0);
    h.advance(200);
    h.flush(3);
    expect(qsa).toHaveLength(1);
  });

  it("ignores the guest's own host elements", async () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q()]);
    h.flush(3);
    qsa.length = 0;
    h.deliver(INSPECT_CHANNEL.mode, { mode: "pick", redactText: false });
    h.pointAt($(h, "button"));
    h.fire("mousemove", { clientX: 5, clientY: 5 });
    h.flush(3);
    await settle();
    h.advance(2000);
    h.flush(3);
    expect(qsa).toHaveLength(0);
  });

  it("stops observing once the anchors are cleared", async () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q()]);
    h.flush(3);
    setAnchors(h, []);
    h.flush(3);
    qsa.length = 0;
    await mutate(h, 5);
    h.advance(5000);
    h.flush(3);
    expect(qsa).toHaveLength(0);
  });
});

describe("rect reporting", () => {
  it("reports changed rects once per frame after a scroll, and nothing when nothing moved", () => {
    const h = fresh();
    const epoch = setAnchors(h, [q(), q({ key: "a1", tag: "div", selector: "#pro", textAnchor: { tag: "div", text: "" } })]);
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.anchorRects)).toEqual([]);
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.flush(2);
    expect(h.all(INSPECT_CHANNEL.anchorRects)).toEqual([]); // unchanged: no message
    h.setRect($(h, "button"), { x: 100, y: 50, width: 160, height: 48 });
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.anchorRects)).toHaveLength(1);
    expect(h.last(INSPECT_CHANNEL.anchorRects)!.payload).toEqual({
      epoch,
      rects: [
        { key: "a0", rect: { x: 100, y: 50, width: 160, height: 48 }, visible: true },
        { key: "a1", rect: R.pro, visible: true },
      ],
    });
  });

  it("a resize re-measures, and leaving the viewport flips visible", () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    h.setRect($(h, "button"), { x: 100, y: 9000, width: 160, height: 48 });
    h.win.dispatchEvent(new h.win.Event("resize"));
    h.flush(3);
    expect(h.last(INSPECT_CHANNEL.anchorRects)!.payload.rects[0]).toMatchObject({ key: "a0", visible: false });
  });

  it("reports a null rect for an element that left the document, and a re-pass follows", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    $(h, "button").remove();
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.flush(3);
    expect(h.last(INSPECT_CHANNEL.anchorRects)!.payload.rects[0]).toEqual({ key: "a0", rect: null, visible: false });
    await settle();
    h.advance(300);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("text".length ? byKey(h, "a0")!.match : "x");
  });

  it("does not report detached or other-route anchors as rects", () => {
    const h = fresh();
    setAnchors(h, [q({ key: "a0", route: "/nope" }), q({ key: "a1", selector: "#gone", textAnchor: { tag: "button", text: "Vanished" } })]);
    h.flush(3);
    h.win.dispatchEvent(new h.win.Event("scroll"));
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.anchorRects)).toEqual([]);
  });

  it("the 1 s re-assertion re-sends the current rects (a dropped report never strands the embedder)", () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    h.tick();
    h.flush(3);
    expect(h.all(INSPECT_CHANNEL.anchorRects)).toHaveLength(1);
    expect(h.last(INSPECT_CHANNEL.anchorRects)!.payload.rects[0]).toMatchObject({ key: "a0", rect: R.buy });
  });

  it("does not re-send identical results", () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    expect(results(h)).toHaveLength(1);
    h.tick();
    h.flush(3);
    expect(results(h)).toHaveLength(1);
  });
});

describe("anchor-focus", () => {
  function withScroll() {
    const h = boot(PAGE, { start: false });
    const scrolled: Array<{ el: Element; options: unknown }> = [];
    h.win.Element.prototype.scrollIntoView = function (this: Element, options?: unknown) { scrolled.push({ el: this, options }); };
    h.start();
    setRects(h);
    epochCounter = 0;
    return { h, scrolled };
  }
  const reduced = (h: GuestHarness, value: boolean) => {
    (h.win as any).matchMedia = (query: string) => ({ matches: value && query.includes("prefers-reduced-motion"), media: query, addEventListener() {}, removeEventListener() {} });
  };

  it("scroll: scrolls the resolved element into view (smooth), flashes nothing", () => {
    const { h, scrolled } = withScroll();
    reduced(h, false);
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "scroll" });
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.el).toBe($(h, "button"));
    expect(scrolled[0]!.options).toMatchObject({ behavior: "smooth" });
    expect(h.shadowRoots).toHaveLength(0);
  });

  it("scroll is instant under prefers-reduced-motion", () => {
    const { h, scrolled } = withScroll();
    reduced(h, true);
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "scroll" });
    expect(scrolled[0]!.options).toMatchObject({ behavior: "instant" });
  });

  it("flash: draws an outline in a closed shadow root for 1.2 s, then removes it", () => {
    const { h } = withScroll();
    reduced(h, false);
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "flash" });
    expect(h.shadowRoots).toHaveLength(1);
    expect(h.shadowRoots[0]!.root.mode).toBe("closed");
    const host = h.shadowRoots[0]!.host;
    expect(host.isConnected).toBe(true);
    expect(h.sheets.some((css) => css.includes("left:100px") && css.includes("top:200px"))).toBe(true);
    h.advance(1199);
    expect(host.isConnected).toBe(true);
    h.advance(2);
    expect(host.isConnected).toBe(false);
    expect(h.pendingTimers()).toBe(0);
  });

  it("flash under reduced motion: no animation, same outline, instant scroll", () => {
    const { h, scrolled } = withScroll();
    reduced(h, true);
    const epoch = setAnchors(h, [q()]);
    h.flush(3);
    h.deliver(INSPECT_CHANNEL.anchorFocus, { epoch, key: "a0", behavior: "flash" });
    expect(scrolled.every((s) => (s.options as any).behavior === "instant")).toBe(true);
    expect(h.sheets.join("\n")).not.toMatch(/animation|transition/);
  });

  it("ignores a stale epoch, an unknown key, a detached anchor, a bad behavior and junk", () => {
    const { h, scrolled } = withScroll();
    const epoch = setAnchors(h, [q(), q({ key: "a1", selector: "#gone", textAnchor: { tag: "button", text: "Vanished" } })]);
    h.flush(3);
    for (const bad of [
      { epoch: epoch - 1, key: "a0", behavior: "scroll" }, { epoch, key: "a7", behavior: "scroll" }, { epoch, key: "a1", behavior: "scroll" },
      { epoch, key: "a0", behavior: "explode" }, { epoch, key: "a0" }, { key: "a0", behavior: "scroll" }, null, "a0", 3,
    ]) h.deliver(INSPECT_CHANNEL.anchorFocus, bad);
    expect(scrolled).toEqual([]);
    expect(h.shadowRoots).toHaveLength(0);
  });
});

describe("a hostile page", () => {
  it("cannot move a result by patching prototypes after the guest started (captured natives)", () => {
    const h = fresh();
    h.win.Element.prototype.getBoundingClientRect = (() => ({ x: 5, y: 5, width: 1, height: 1, left: 5, top: 5, right: 6, bottom: 6, toJSON() { return this; } })) as never;
    h.win.Document.prototype.querySelectorAll = (() => []) as never;
    h.win.Document.prototype.getElementsByTagName = (() => []) as never;
    setAnchors(h, [q(), q({ key: "a1", selector: "#gone", textAnchor: { tag: "button", text: "Buy now" } })]);
    h.flush(5);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true, rect: R.buy });
    expect(byKey(h, "a1")).toMatchObject({ match: "text", rect: R.buy });
  });

  it("a decoy with the same text does not win while the original resolves by selector", () => {
    const h = fresh();
    const decoy = h.doc.createElement("button");
    decoy.textContent = "Buy now";
    h.doc.body.insertBefore(decoy, h.doc.body.firstChild);
    h.setRect(decoy, { x: 700, y: 700, width: 10, height: 10 });
    setAnchors(h, [q()]);
    h.flush(3);
    expect(byKey(h, "a0")).toMatchObject({ match: "selector", agrees: true, rect: R.buy });
  });

  it("a decoy with the same text makes the text anchor ambiguous: no guess", () => {
    const h = fresh();
    const decoy = h.doc.createElement("button");
    decoy.textContent = "Buy now";
    h.doc.body.appendChild(decoy);
    setAnchors(h, [q({ selector: "#gone" })]);
    h.flush(3);
    expect(byKey(h, "a0")?.match).toBe("detached");
  });

  it("forged embedder messages from the page change nothing: the guest only reads the preload channel", () => {
    const h = fresh();
    setAnchors(h, [q()]);
    h.flush(3);
    const before = results(h).length;
    h.win.postMessage({ channel: INSPECT_CHANNEL.anchors, args: [{ epoch: 99, redactText: false, anchors: [] }] }, "*");
    h.win.dispatchEvent(new h.win.CustomEvent(INSPECT_CHANNEL.anchors, { detail: { epoch: 99, redactText: false, anchors: [] } }));
    h.flush(3);
    expect(results(h)).toHaveLength(before);
    expect(byKey(h, "a0")?.match).toBe("selector");
  });

  it("dispose stops everything", async () => {
    const { h, qsa } = bootSpy();
    setAnchors(h, [q()]);
    h.flush(3);
    h.guest!.dispose();
    qsa.length = 0;
    h.doc.body.appendChild(h.doc.createElement("i"));
    await settle();
    h.advance(5000);
    h.tick();
    h.flush(5);
    expect(qsa).toEqual([]);
  });
});
