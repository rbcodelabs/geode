import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
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
async function run(h: GuestHarness, ms: number, channel: string, times: number[], each?: (t: number) => void, tickEveryMs = 1000): Promise<void> {
  let seen = h.all(channel).length;
  let sinceTick = 0;
  for (let t = 0; t < ms; t += 5) {
    each?.(t);
    h.advance(5);
    h.flush(1);
    await settle();
    sinceTick += 5;
    if (sinceTick >= tickEveryMs) { sinceTick = 0; h.tick(); h.flush(1); await settle(); }
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
      if (t % 60 === 0) h.win.location.hash = n % 2 ? "#frag" : "#other";
    });
    expect(times.length).toBeGreaterThan(40);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(INSPECTOR_CAPS.anchorResultsSpacingMillis);
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
    const burst = (i: number) => -(times[i]! % 400);          // every 400 ms window of arrivals collapses to its start
    expect(dropped(times, INSPECTOR_CAPS.anchorResultsPerSecond, burst)).toBeLessThanOrEqual(Math.ceil(times.length / 8));
    expect(lastResults(h)!.results[0]!.agrees).toBe(h.doc.querySelector("button")!.textContent === "Buy now");
  });

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
      else expect(drops).toBeLessThanOrEqual(12); // at most about one per second at 120 Hz
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

  it("a redacted artifact re-checks by path only: a hash replaceState does not trigger a pass", async () => {
    const h = fresh();
    setAnchors(h, [q({ route: "/page.html", textAnchor: { tag: "button", text: "" } })], true);
    const times: number[] = [];
    await run(h, 800, INSPECT_CHANNEL.anchorResults, times);
    const passes = () => h.all(INSPECT_CHANNEL.anchorResults).length;
    const before = passes();
    h.win.history.replaceState({}, "", "/page.html#/note/Secret");
    await run(h, 3000, INSPECT_CHANNEL.anchorResults, times);
    expect(lastResults(h)!.results[0]!.match).toBe("selector");
    expect(passes() - before).toBeLessThanOrEqual(3); // only the 1 s identical-results re-sends
  });
});

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

  it("a huge element that really covers the viewport is still reported visible (Info if not: clamping moves its edges)", async () => {
    const h = fresh();
    h.setRect(h.doc.querySelector("button")!, { x: -5e6, y: -5e6, width: 1e7, height: 1e7 });
    setAnchors(h, [q()]);
    await run(h, 400, INSPECT_CHANNEL.anchorResults, []);
    console.log("QA-G2 giant overlay visible=" + lastResults(h)!.results[0]!.visible + " rect=" + JSON.stringify(lastResults(h)!.results[0]!.rect));
    expect(lastResults(h)!.results[0]!.match).toBe("selector");
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

describe("QA G2 fix pass: reassert interplay", () => {
  it("re-assertion resends results and rects at most once a second each and does not start a pass when nothing changed", async () => {
    const h = fresh();
    const calls: string[] = [];
    setAnchors(h, [q()]);
    await run(h, 500, INSPECT_CHANNEL.anchorResults, []);
    const realQsa = h.win.Document.prototype.querySelectorAll;
    h.win.Document.prototype.querySelectorAll = function (this: Document, s: string) { calls.push(s); return realQsa.call(this, s); } as typeof realQsa;
    await run(h, 5000, INSPECT_CHANNEL.anchorResults, []);
    expect(calls).toEqual([]);
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
