import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAnchorTracker } from "../../src/main/artifact-inspector-anchors";
import { boot, type GuestHarness } from "../helpers/inspector-guest-harness";

vi.setConfig({ testTimeout: 120_000 });

/**
 * QA (G2 fix pass, independent): edges of the fix pass. Resend churn against the embedder's 8/s and 120/s windows over long
 * simulated runs, dropped-message healing, route re-check, clamp boundary, truncated-index honesty, reassert interplay.
 * The window model is the bridge's own rule (a message is dropped when 8 (or 120) were accepted in the last 1000 ms).
 */

const PAGE = `<body><main><h2>Pricing</h2>
  <section class="plans" data-variation="B"><div class="card pro" id="pro"><button class="cta primary" data-testid="buy">Buy now</button></div></section></main></body>`;
const ROUTE = "/page.html#frag";
const R = { x: 100, y: 200, width: 160, height: 48 };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const q = (over: Partial<InspectAnchorQuery> = {}): InspectAnchorQuery => ({
  key: "a0", route: ROUTE, tag: "button", selector: "[data-testid=\"buy\"]", alternates: [], textAnchor: { tag: "button", text: "Buy now" }, landmark: null, ...over,
});
let epochCounter = 0;
function fresh(html = PAGE, options: Parameters<typeof boot>[1] = {}): GuestHarness {
  epochCounter = 0;
  const h = boot(html, options);
  const b = h.doc.querySelector("button");
  if (b) h.setRect(b, R);
  return h;
}
function setAnchors(h: GuestHarness, anchors: unknown[], redactText = false): number {
  const epoch = ++epochCounter;
  h.deliver(INSPECT_CHANNEL.anchors, { epoch, redactText, anchors });
  return epoch;
}
const resultsOf = (h: GuestHarness) => h.all(INSPECT_CHANNEL.anchorResults);
const lastResults = (h: GuestHarness) => h.last(INSPECT_CHANNEL.anchorResults)?.payload as { epoch: number; results: Array<Record<string, any>> } | undefined;

/** The embedder's sliding window (bridge.withinRate): returns how many of the arrival times it would drop. */
function dropped(times: number[], limit: number, jitter = (_i: number) => 0): number {
  const arrivals = times.map((t, i) => t + jitter(i)).sort((a, b) => a - b);
  const win: number[] = [];
  let drops = 0;
  for (const t of arrivals) {
    while (win.length > 0 && t - win[0]! >= 1000) win.shift();
    if (win.length >= limit) { drops++; continue; }
    win.push(t);
  }
  return drops;
}
const maxInAnyWindow = (times: number[]): number => {
  let best = 0;
  for (let i = 0; i < times.length; i++) { let n = 0; for (let j = i; j < times.length && times[j]! - times[i]! < 1000; j++) n++; best = Math.max(best, n); }
  return best;
};

/** Steps a harness by `ms` in 5 ms ticks, flushing frames and mutation records, recording the time of every new message of a channel. */
const tickPhase = new WeakMap<GuestHarness, number>();
async function run(h: GuestHarness, ms: number, channel: string, times: number[], each?: (t: number) => void, tickEveryMs = 1000): Promise<void> {
  let seen = h.all(channel).length;
  // The guest's re-assertion is ONE interval started with the tracker: its phase must survive across run() segments.
  let sinceTick = tickPhase.get(h) ?? 0;
  for (let t = 0; t < ms; t += 5) {
    each?.(t);
    h.advance(5);
    h.flush(1);
    await settle();
    sinceTick += 5;
    if (sinceTick >= tickEveryMs) { sinceTick = 0; h.tick(); h.flush(1); await settle(); }
    tickPhase.set(h, sinceTick);
    const now = h.all(channel).length;
    for (let i = seen; i < now; i++) times.push(h.now());
    seen = now;
  }
}

describe("QA G2 fix pass: result messages vs the embedder's 8/s window, long runs", () => {
  it("60 s of re-created nodes, text flips, hash flips and 1 s re-assertions: never more than 7 results in any 1 s window, spacing >= 150 ms, zero embedder drops", async () => {
    const h = fresh();
    setAnchors(h, [q(), q({ key: "a1", selector: "#nope", textAnchor: { tag: "button", text: "Buy now" } }), q({ key: "a2", route: "/page.html#other" })]);
    const times: number[] = [];
    let n = 0;
    await run(h, 60_000, INSPECT_CHANNEL.anchorResults, times, (t) => {
      n++;
      const b = h.doc.querySelector("button");
      if (t % 40 === 0 && b) { const c = b.cloneNode(true) as Element; c.textContent = n % 2 ? "Buy now" : "Zzzz"; b.replaceWith(c); h.setRect(c, R); }
      if (t % 60 === 0) { h.win.location.hash = n % 2 ? "#frag" : "#other"; h.fire("hashchange", {}, h.win as never); } // jsdom fires hashchange on a real timer: dispatch it ourselves
    });
    expect(times.length).toBeGreaterThan(40);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(150);
    expect(maxInAnyWindow(times)).toBeLessThanOrEqual(7);
    expect(dropped(times, INSPECTOR_CAPS.anchorResultsPerSecond)).toBe(0);
  });

  it("when the embedder's thread stalls and delivers 400 ms of messages at once, it drops at most 1 per burst and the final state still arrives", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    const times: number[] = [];
    await run(h, 30_000, INSPECT_CHANNEL.anchorResults, times, (t) => {
      const b = h.doc.querySelector("button");
      if (t % 100 === 0 && b) b.textContent = (t / 100) % 2 ? "Buy now" : "Zzzz";
    });
    await run(h, 2000, INSPECT_CHANNEL.anchorResults, times); // the page goes quiet: the pass after the last flip needs its 250 ms debounce
    const burst = (i: number) => -(times[i]! % 400);          // every 400 ms window of arrivals collapses to its start
    expect(dropped(times, INSPECTOR_CAPS.anchorResultsPerSecond, burst)).toBeLessThanOrEqual(Math.ceil(times.length / 8));
    expect(lastResults(h)!.results[0]!.agrees).toBe(h.doc.querySelector("button")!.textContent === "Buy now");
  });

  // Design: a dropped message self-heals "within about a second": the re-assertion interval is 1 s, plus the 150 ms result spacing.
  it("a dropped (lost) results message is repeated within ~1.2 s with the latest state", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    const times: number[] = [];
    await run(h, 400, INSPECT_CHANNEL.anchorResults, times);
    expect(times).toHaveLength(1);
    // pretend that message was lost; nothing changes on the page
    const lostAt = times[0]!;
    await run(h, 1600, INSPECT_CHANNEL.anchorResults, times);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times[1]! - lostAt).toBeLessThanOrEqual(1300);
    expect(JSON.stringify(h.all(INSPECT_CHANNEL.anchorResults)[1]!.payload)).toBe(JSON.stringify(h.all(INSPECT_CHANNEL.anchorResults)[0]!.payload));
  });

  it("steady state costs exactly one results message and one rects message per second (the re-assertion), nothing more", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    const results: number[] = [], rects: number[] = [];
    await Promise.all([run(h, 10_000, INSPECT_CHANNEL.anchorResults, results)]);
    const r = h.all(INSPECT_CHANNEL.anchorRects).length;
    expect(results.length).toBeGreaterThanOrEqual(9);
    expect(results.length).toBeLessThanOrEqual(12);
    expect(r).toBeLessThanOrEqual(12);
    void rects;
  });
});

describe("QA G2 fix pass: rect reports vs the 120/s window", () => {
  for (const hz of [60, 120]) {
    it(`scrolling at ${hz} Hz for 10 s with the 1 s re-assertion: embedder drops (report) and the final rect arrives`, async () => {
      const h = fresh();
      setAnchors(h, [q()]);
      await run(h, 600, INSPECT_CHANNEL.anchorRects, []);
      const times: number[] = [];
      const frame = 1000 / hz;
      let y = 0;
      let seen = h.all(INSPECT_CHANNEL.anchorRects).length;
      for (let f = 0; f < hz * 10; f++) {
        y += 3;
        h.setRect(h.doc.querySelector("button")!, { ...R, y });
        h.fire("scroll", {}, h.win as never);
        h.advance(frame);
        h.flush(1);
        if (f % hz === hz - 1) { h.tick(); h.flush(1); }
        const now = h.all(INSPECT_CHANNEL.anchorRects).length;
        for (let i = seen; i < now; i++) times.push(h.now());
        seen = now;
      }
      const drops = dropped(times, INSPECTOR_CAPS.anchorRectsPerSecond);
      console.log(`QA-G2 rects ${hz}Hz: sent=${times.length} maxWindow=${maxInAnyWindow(times)} embedderDrops=${drops}`);
      await run(h, 1500, INSPECT_CHANNEL.anchorRects, times);
      const last = h.last(INSPECT_CHANNEL.anchorRects)!.payload.rects[0].rect;
      expect(last.y).toBe(y);               // healed by the re-assertion within the quiet period
      if (hz === 60) expect(drops).toBe(0);
      // At 120 Hz the guest sends one rects message per frame, which IS the embedder's 120/s limit, plus the 1 s re-assertion's extra one: expect
      // the embedder to shed about 1 to 2 per second (intermediate scroll positions; the last position heals within a second, asserted above).
      else expect(drops).toBeLessThanOrEqual(20);
    });
  }
});

describe("QA G2 fix pass: route re-check (QA-G2-5)", () => {
  it("pushState with no DOM change flips to other-route within the re-assertion plus the pass gap, and back again", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    const times: number[] = [];
    await run(h, 800, INSPECT_CHANNEL.anchorResults, times);
    expect(lastResults(h)!.results[0]!.match).toBe("selector");
    h.win.history.pushState({}, "", "/elsewhere.html");
    await run(h, 1700, INSPECT_CHANNEL.anchorResults, times);
    expect(lastResults(h)!.results[0]!.match).toBe("other-route");
    h.win.history.replaceState({}, "", "/page.html#frag");
    await run(h, 1700, INSPECT_CHANNEL.anchorResults, times);
    expect(lastResults(h)!.results[0]!.match).toBe("selector");
  });

  it("a redacted artifact re-checks by path only: a hash replaceState does not start a pass", async () => {
    const { h, calls } = spied();
    setAnchors(h, [q({ route: "/page.html", textAnchor: { tag: "button", text: "" } })], true);
    await run(h, 800, INSPECT_CHANNEL.anchorResults, []);
    calls.length = 0;
    h.win.history.replaceState({}, "", "/page.html#/note/Secret");
    await run(h, 3000, INSPECT_CHANNEL.anchorResults, []);
    expect(lastResults(h)!.results[0]!.match).toBe("selector");
    expect(calls).toEqual([]);
  });
});

/** A harness whose querySelectorAll spy is installed BEFORE the guest starts (the guest captures natives at start). */
function spied(html = PAGE) {
  epochCounter = 0;
  const h = boot(html, { start: false });
  const calls: Array<{ selector: string; at: number }> = [];
  const real = h.win.Document.prototype.querySelectorAll;
  h.win.Document.prototype.querySelectorAll = function (this: Document, selector: string) { calls.push({ selector, at: h.now() }); return real.call(this, selector); } as typeof real;
  h.start();
  const b = h.doc.querySelector("button");
  if (b) h.setRect(b, R);
  return { h, calls: calls as unknown as string[] & Array<{ selector: string; at: number }>, raw: calls };
}

describe("QA G2 fix pass: clamp (A2)", () => {
  const cases: Array<[string, { x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number }]> = [
    ["exactly at the boundary stays", { x: 1e6, y: -1e6, width: 1e6, height: 1e6 }, { x: 1e6, y: -1e6, width: 1e6, height: 1e6 }],
    ["one over is clamped to the boundary", { x: 1e6 + 1, y: -1e6 - 1, width: 1e6 + 1, height: 1e6 + 1 }, { x: 1e6, y: -1e6, width: 1e6, height: 1e6 }],
    ["1e12 and -1e12", { x: 1e12, y: -1e12, width: 1e12, height: 5 }, { x: 1e6, y: -1e6, width: 1e6, height: 5 }],
    ["negative size becomes 0", { x: 1, y: 2, width: -5, height: -1 }, { x: 1, y: 2, width: 0, height: 0 }],
  ];
  it.each(cases)("%s", async (_n, raw, expected) => {
    const h = fresh();
    h.setRect(h.doc.querySelector("button")!, raw);
    setAnchors(h, [q()]);
    await run(h, 400, INSPECT_CHANNEL.anchorResults, []);
    expect(lastResults(h)!.results[0]!.rect).toEqual(expected);
    h.setRect(h.doc.querySelector("button")!, { ...raw, x: raw.x + 0.5 });
    h.fire("scroll", {}, h.win as never);
    h.flush(2);
    const rects = h.last(INSPECT_CHANNEL.anchorRects)?.payload.rects[0].rect;
    if (rects) expect(Math.abs(rects.x)).toBeLessThanOrEqual(1e6);
  });

  // BUG QA-G2-7 (Info): visibility is computed from the CLAMPED rect, so an element 1e7 px wide that really covers the viewport
  // (x -5e6) is clamped to x -1e6, width 1e6 (right edge 0) and reported visible:false. Fix in artifact-inspector-anchors.ts placed()/measure():
  // compute intersectsViewport from deps.rectOf(el) (unclamped) and clamp only what is sent. Remove .fails when fixed.
  it("a huge element that really covers the viewport is reported visible", async () => {
    const h = fresh();
    h.setRect(h.doc.querySelector("button")!, { x: -5e6, y: -5e6, width: 1e7, height: 1e7 });
    setAnchors(h, [q()]);
    await run(h, 400, INSPECT_CHANNEL.anchorResults, []);
    console.log("QA-G2 giant overlay visible=" + lastResults(h)!.results[0]!.visible + " rect=" + JSON.stringify(lastResults(h)!.results[0]!.rect));
    expect(lastResults(h)!.results[0]!.match).toBe("selector");
    expect(lastResults(h)!.results[0]!.visible).toBe(true);
  });
});

describe("QA G2 fix pass: truncated text index (A1)", () => {
  const many = (n: number, uniqueAt: number, dupAt?: number) =>
    `<body>${Array.from({ length: n }, (_, i) => `<em>${i === uniqueAt || i === dupAt ? "target" : "x" + i}</em>`).join("")}</body>`;
  const em = (): InspectAnchorQuery => q({ tag: "em", selector: "#gone", textAnchor: { tag: "em", text: "target" } });
  async function resolve(html: string) {
    const h = fresh(html);
    setAnchors(h, [em()]);
    await run(h, 600, INSPECT_CHANNEL.anchorResults, []);
    return lastResults(h)!.results[0]!;
  }
  it("exactly 5000 elements: a complete scan, agrees true", async () => {
    expect(await resolve(many(5000, 10))).toMatchObject({ match: "text", agrees: true });
  });
  it("5001 elements, unique inside the window: found but agrees false", async () => {
    expect(await resolve(many(5001, 10))).toMatchObject({ match: "text", agrees: false });
  });
  it("5001 elements, the twin sits in the unread tail: still not claimed as agreeing", async () => {
    expect(await resolve(many(5600, 10, 5500))).toMatchObject({ match: "text", agrees: false });
  });
  it("the only match is past the window: detached, never a wrong element", async () => {
    expect((await resolve(many(5600, 5500))).match).toBe("detached");
  });
  it("two matches inside the window: no guess, even when truncated", async () => {
    expect((await resolve(many(5600, 10, 20))).match).toBe("detached");
  });
  it("other tags are scanned independently (a truncated em scan does not taint a small strong scan)", async () => {
    const html = `<body>${Array.from({ length: 5200 }, (_, i) => `<em>x${i}</em>`).join("")}<b>target</b></body>`;
    const h = fresh(html);
    setAnchors(h, [em(), q({ key: "a1", tag: "b", selector: "#gone", textAnchor: { tag: "b", text: "target" } })]);
    await run(h, 800, INSPECT_CHANNEL.anchorResults, []);
    const res = lastResults(h)!.results;
    expect(res[0]!.match).toBe("detached");
    expect(res[1]).toMatchObject({ match: "text", agrees: true });
  });
});

describe("QA G2 fix pass: reassert interplay and spacing", () => {
  it("steady state: the re-assertion starts no resolve pass when nothing changed", async () => {
    const { h, raw } = spied();
    setAnchors(h, [q()]);
    await run(h, 500, INSPECT_CHANNEL.anchorResults, []);
    raw.length = 0;
    await run(h, 5000, INSPECT_CHANNEL.anchorResults, []);
    expect(raw).toEqual([]);
  });

  it("F1: a re-assertion right after a pass-completion send is held back so two results are never closer than 150 ms", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    const times: number[] = [];
    await run(h, 60, INSPECT_CHANNEL.anchorResults, times); // the first results went out within the first frames
    expect(times).toHaveLength(1);
    h.tick(); h.flush(1); await settle();                    // the 1 s re-assertion fires 'now', a few ms after that send
    expect(h.all(INSPECT_CHANNEL.anchorResults)).toHaveLength(1); // held back, not sent immediately
    await run(h, 400, INSPECT_CHANNEL.anchorResults, times);
    expect(times).toHaveLength(2);
    // literals on purpose: 150 ms spacing is what keeps any 1 s window at 7 results, under the embedder's 8
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(150);
    expect(times[1]! - times[0]!).toBeLessThanOrEqual(170);
    expect(Math.ceil(1000 / INSPECTOR_CAPS.anchorResultsSpacingMillis)).toBeLessThanOrEqual(INSPECTOR_CAPS.anchorResultsPerSecond - 1);
  });

  it("F4: passes started by the immediate triggers (hash flips) are at least 250 ms apart", async () => {
    const { h, raw } = spied();
    setAnchors(h, [q()]);
    await run(h, 400, INSPECT_CHANNEL.anchorResults, []);
    raw.length = 0;
    await run(h, 5000, INSPECT_CHANNEL.anchorResults, [], (t) => { if (t % 20 === 0) { h.win.location.hash = (t / 20) % 2 ? "#frag" : "#other"; h.fire("hashchange", {}, h.win as never); } });
    const starts = raw.map((c) => c.at).filter((t, i, all) => i === 0 || t - all[i - 1]! > 5); // one start per pass (a pass makes one query here)
    expect(starts.length).toBeGreaterThan(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!, `pass ${i}`).toBeGreaterThanOrEqual(250);
  });

  it("an anchors message mid-throttle cancels the pending trailing send of the old epoch", async () => {
    const h = fresh();
    const e1 = setAnchors(h, [q()]);
    await run(h, 100, INSPECT_CHANNEL.anchorResults, []);
    h.doc.querySelector("button")!.textContent = "Zzzz";
    await run(h, 300, INSPECT_CHANNEL.anchorResults, []);
    const e2 = setAnchors(h, []);
    await run(h, 2000, INSPECT_CHANNEL.anchorResults, []);
    const epochs = h.all(INSPECT_CHANNEL.anchorResults).map((m) => m.payload.epoch);
    expect(Math.max(...epochs)).toBe(e1);
    expect(e2).toBeGreaterThan(e1);
    expect(epochs.filter((e) => e === e2)).toEqual([]);
  });
});

describe("QA G2 fix pass: generator and grammar agree for custom elements (QA-G2-2)", () => {
  it("elements with non-ASCII or underscore names keep an EXACT selector hit through the tracker, not a fallback", async () => {
    const h = fresh(`<body><x-f\u00f6\u00f6 class="u1">one</x-f\u00f6\u00f6><x-f\u00f6\u00f6 class="a">two</x-f\u00f6\u00f6><my_el class="c">three</my_el></body>`);
    const picked: Array<{ selector: string; alternates: string[]; tag: string; textAnchor: any; route: string; landmark: string | null }> = [];
    for (const el of [...h.doc.body.querySelectorAll("*")]) {
      h.deliver(INSPECT_CHANNEL.mode, { mode: "pick", redactText: false });
      h.pointAt(el); h.sent.length = 0; h.fire("click", { clientX: 1, clientY: 1, button: 0 }, el); h.flush(3);
      const m = h.last(INSPECT_CHANNEL.select)!.payload;
      picked.push({ selector: m.selector, alternates: m.selectorAlternates, tag: m.tag, textAnchor: m.textAnchor, route: m.route, landmark: m.landmark });
    }
    expect(picked).toHaveLength(3);
    for (const p of picked) expect(p.selector, "a primary selector must exist").not.toBe("");
    h.sent.length = 0;
    setAnchors(h, picked.map((p, i) => ({ key: `a${i}`, route: p.route, tag: p.tag, selector: p.selector, alternates: p.alternates, textAnchor: p.textAnchor, landmark: p.landmark })));
    await run(h, 600, INSPECT_CHANNEL.anchorResults, []);
    expect(lastResults(h)!.results.map((r) => [r.match, r.agrees])).toEqual([["selector", true], ["selector", true], ["selector", true]]);
  });
});

describe("QA G2 fix pass: advisories from review (BUG: tests, src fixes needed)", () => {
  // BUG QA-G2-8: rect messages have no spacing and no trailing send. On a >120 Hz display (or with jitter) the guest sends more than
  // the embedder's 120/s window accepts, so the embedder sheds intermediate AND possibly the final rect; the pin is stale until the
  // 1 s re-assertion. Fix: space rects (>= 9 ms) with a trailing send of the latest, like the results. Remove .fails when fixed.
  it("at 144 Hz the guest never sends more than 120 rects messages in any 1 s window", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    await run(h, 600, INSPECT_CHANNEL.anchorRects, []);
    const times: number[] = [];
    const frame = 1000 / 144;
    let y = 0;
    let seen = h.all(INSPECT_CHANNEL.anchorRects).length;
    for (let f = 0; f < 144 * 5; f++) {
      y += 3;
      h.setRect(h.doc.querySelector("button")!, { ...R, y });
      h.fire("scroll", {}, h.win as never);
      h.advance(frame);
      h.flush(1);
      const now = h.all(INSPECT_CHANNEL.anchorRects).length;
      for (let i = seen; i < now; i++) times.push(h.now());
      seen = now;
    }
    expect(maxInAnyWindow(times)).toBeLessThanOrEqual(INSPECTOR_CAPS.anchorRectsPerSecond);
  });

  it("at 120 Hz (rAF-coalesced, the re-assertion inside a scroll frame) the guest stays within the 120/s window", async () => {
    const h = fresh();
    setAnchors(h, [q()]);
    await run(h, 600, INSPECT_CHANNEL.anchorRects, []);
    const times: number[] = [];
    let y = 0;
    let seen = h.all(INSPECT_CHANNEL.anchorRects).length;
    for (let f = 0; f < 120 * 8; f++) {
      y += 3;
      h.setRect(h.doc.querySelector("button")!, { ...R, y });
      if (f % 120 === 119) h.tick();             // the interval fires inside the frame; its measure coalesces with the scroll's
      h.fire("scroll", {}, h.win as never);
      h.advance(1000 / 120);
      h.flush(1);
      const now = h.all(INSPECT_CHANNEL.anchorRects).length;
      for (let i = seen; i < now; i++) times.push(Math.round(h.now()));
      seen = now;
    }
    expect(maxInAnyWindow(times)).toBeLessThanOrEqual(INSPECTOR_CAPS.anchorRectsPerSecond);
    expect(dropped(times, INSPECTOR_CAPS.anchorRectsPerSecond)).toBe(0);
  });

  // BUG QA-G2-9 (defense in depth, unreachable today because the guest's own rectOf maps NaN to 0): the tracker's clamp passes NaN
  // through (Math.min/Math.max propagate it), and one NaN rect makes the embedder drop the whole message. Fix: clamp(v) = Number.isFinite(v) ? ... : 0.
  it("the tracker's clamp turns a NaN rect from its dependency into a finite number", () => {
    const h = fresh();
    const sent: Array<{ channel: string; payload: any }> = [];
    const frames: Array<() => void> = [];
    const tracker = createAnchorTracker({
      win: h.win, doc: h.doc, send: (channel, payload) => sent.push({ channel, payload }), now: () => 1000,
      requestFrame: (cb) => frames.push(cb), setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
      addListener: () => {}, removeListener: () => {},
      queryAll: (sel) => h.doc.querySelectorAll(sel), elementsByTag: (t) => h.doc.getElementsByTagName(t),
      rectOf: () => ({ x: Number.NaN, y: 0, width: Number.NaN, height: 5 }),
      textOf: (el) => (el.textContent ?? "").trim(), tagOf: (el) => el.localName, isElement: (v): v is Element => typeof v === "object" && v !== null && (v as Node).nodeType === 1,
      isGuestHost: () => false, attachShadow: (el, init) => el.attachShadow(init), scrollIntoView: undefined,
    });
    tracker.onAnchors({ epoch: 1, redactText: false, anchors: [q()] });
    for (let i = 0; i < 5; i++) { const run = frames.splice(0); for (const f of run) f(); }
    const rect = sent.find((m) => m.channel === INSPECT_CHANNEL.anchorResults)!.payload.results[0].rect;
    expect(Number.isFinite(rect.x) && Number.isFinite(rect.width)).toBe(true);
    tracker.dispose();
  });

  // BUG QA-G2-10 (Low): the generator's data-testid limit is a literal 128 in artifact-inspector-guest.ts, duplicating
  // INSPECTOR_CAPS.anchorAttributeValueUnits, so the two can drift apart again (that was QA-G2-1). Fix: use the constant.
  it("the generator's data-testid length limit comes from INSPECTOR_CAPS.anchorAttributeValueUnits, not a literal", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "artifact-inspector-guest.ts"), "utf8");
    expect(src).not.toMatch(/value\.length <= 128/);
  });
});
