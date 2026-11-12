import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { ANCHORS_ARTIFACT, anchorPerfArtifact } from "./helpers/artifact-picker-fixtures";
import { counts, guestEval, inView, lastResults, percentile, query, route, session } from "./helpers/anchor-e2e";

/**
 * QA (G2, independent) hostile-page cases the engineer's specs do not cover, in the real Electron guest:
 * worst-case selectors that PASS the grammar on a 50k-node DOM, a 1 kHz mutation storm with 100 live anchors, duplicate-text
 * scans past the 5,000 cap, route changes, and reserved-directory probes over the real protocol handler.
 */

const waitEpoch = (w: import("@playwright/test").Page, epoch: number, timeout = 60_000) =>
  expect.poll(async () => (await lastResults(w))?.epoch ?? 0, { timeout }).toBeGreaterThanOrEqual(epoch);
const set = (w: import("@playwright/test").Page, q: unknown[]) => inView(w, (p: any, _v: any, a: any) => p.setAnchors(a), q);

test.describe("QA G2 hostile page", () => {
  test.setTimeout(240_000);

  test("selectors the grammar ACCEPTS but that are expensive (12 deep descendant chains, universal chains) cannot freeze a 50k-node page", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      await guestEval(s.window, `window.__anchorHostile.build(50000)`);
      // make the DOM deep as well as wide: 60 nested divs holding spans (400 deep makes the PAGE's own layout stall for minutes, which is not the guest)
      await guestEval(s.window, `(() => { let p = document.getElementById("sink"); for (let i = 0; i < 60; i++) { const d = document.createElement("div"); p.appendChild(d); p = d; } for (let i = 0; i < 500; i++) { const x = document.createElement("span"); x.textContent = "deep" + i; p.appendChild(x); } })()`);
      const r = await route(s.window);
      const chain = (c: string, n: number, last = c) => Array.from({ length: n }, (_, i) => (i === n - 1 ? last : c)).join(" ");
      const bad = [
        chain("*", 12), chain("div", 12, "div.nomatch"), chain("div", 12, "span.nomatch"), chain("div", 11, "span:nth-child(99999)"), chain("*", 12, "*:first-child"),
        chain("div", 12, "span[x=\"" + "a".repeat(120) + "\"]"), Array.from({ length: 12 }, () => "*:nth-child(1)").join(" > "), chain("span", 12, "div"),
        "div div div div div div div div div div div span:last-of-type",
      ];
      expect(bad.every((b) => b.length <= 512)).toBe(true);
      const queries = Array.from({ length: 100 }, (_, i) => query(`a${i}`, r, { tag: "span", selector: bad[i % bad.length], alternates: [bad[(i + 1) % bad.length], bad[(i + 2) % bad.length], bad[(i + 3) % bad.length]], textAnchor: { tag: "span", text: "" } }));
      await guestEval(s.window, `window.__perf.start()`);
      await s.window.waitForTimeout(1000);
      const baseline = await guestEval<number[]>(s.window, `(() => { const d = window.__perf.stop(); window.__perf.start(); return d; })()`);
      const started = Date.now();
      const sent = await set(s.window, queries);
      expect(sent.sent).toBe(100);
      await waitEpoch(s.window, sent.epoch, 120_000);
      const elapsed = Date.now() - started;
      await s.window.waitForTimeout(500);
      const deltas = await guestEval<number[]>(s.window, `window.__perf.stop()`);
      const summary = { elapsedMs: elapsed, baselineMax: Math.max(...baseline), duringMax: Math.max(...deltas), p95: percentile(deltas, 0.95), frames: deltas.length };
      console.log("QA-G2 expensive-accepted " + JSON.stringify(summary));
      fs.mkdirSync("test-results", { recursive: true });
      fs.writeFileSync(path.join("test-results", "qa-g2-expensive-accepted.json"), JSON.stringify(summary));
      // One native query on this DOM is atomic (it cannot be sliced); the budget is that it stays well under a second per query.
      expect(Math.max(...deltas)).toBeLessThan(500);
      expect(elapsed).toBeLessThan(60_000);
    } finally { await s.cleanup(); }
  });

  test("a 1 kHz mutation storm with 100 live anchors: result messages stay far below the 8/s embedder budget and frames stay short", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      const r = await route(s.window);
      const queries = Array.from({ length: 100 }, (_, i) => query(`a${i}`, r, { tag: "p", selector: "#note", textAnchor: { tag: "p", text: "" } }));
      // one valid, 99 duplicates of the same target is fine (keys differ)
      const sent = await set(s.window, queries);
      await waitEpoch(s.window, sent.epoch);
      const before = await counts(s.window);
      await guestEval(s.window, `window.__perf.start(); window.__anchorHostile.startChurn(1000); window.__stormId = setInterval(() => { const n = document.createElement("i"); document.getElementById("sink").appendChild(n); n.remove(); }, 1);`);
      await s.window.waitForTimeout(6000);
      await guestEval(s.window, `clearInterval(window.__stormId); window.__anchorHostile.stopChurn()`);
      const deltas = await guestEval<number[]>(s.window, `window.__perf.stop()`);
      const after = await counts(s.window);
      const resultsDuring = after.results - before.results;
      console.log(`QA-G2 storm results=${resultsDuring} rects=${after.rects - before.rects} maxFrame=${Math.max(...deltas)} p95=${percentile(deltas, 0.95)}`);
      // the guest floors passes at 2 s under a storm: at most ~4 passes in 6 s, and results are sent only when they CHANGE (here never)
      expect(resultsDuring).toBeLessThanOrEqual(4);
      expect(Math.max(...deltas)).toBeLessThan(250);
    } finally { await s.cleanup(); }
  });

  test("duplicate text is never guessed, even past the 5,000-element scan cap; a unique text beyond the cap is not found (no hang)", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      await guestEval(s.window, `(() => { const h = document.getElementById("sink"); for (let i = 0; i < 6000; i++) { const x = document.createElement("em"); x.textContent = i < 5001 ? "same" : "tail" + i; h.appendChild(x); } })()`);
      const r = await route(s.window);
      const sent = await set(s.window, [
        query("a0", r, { tag: "em", selector: "#gone", textAnchor: { tag: "em", text: "same" } }),
        query("a1", r, { tag: "em", selector: "#gone", textAnchor: { tag: "em", text: "tail5999" } }),
      ]);
      await waitEpoch(s.window, sent.epoch);
      const res = (await lastResults(s.window))!.results;
      expect(res[0].match).toBe("detached");
      expect(res[1].match).toBe("detached"); // documented cap: index 5999 is past the first 5,000 elements of the tag
    } finally { await s.cleanup(); }
  });

  test("route changes: pushState and hash changes flip other-route and back, without a reload", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      const r = await route(s.window);
      const sent = await set(s.window, [query("a0", r, { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } })]);
      await waitEpoch(s.window, sent.epoch);
      expect((await lastResults(s.window))!.results[0].match).toBe("selector");
      await guestEval(s.window, `location.hash = "#/other"`);
      await expect.poll(async () => (await lastResults(s.window))!.results[0].match, { timeout: 20_000 }).toBe("other-route");
      await guestEval(s.window, `history.back()`);
      await expect.poll(async () => (await lastResults(s.window))!.results[0].match, { timeout: 20_000 }).toBe("selector");
    } finally { await s.cleanup(); }
  });

  // DEFECT QA-G2-5 (Low, advisory): the tracker re-resolves on hashchange, popstate and DOM mutations only. history.pushState fires neither
  // event, so a pin stays "selector" (visible on the wrong route) after a pushState navigation until the next observed DOM mutation.
  // Real routers mutate the DOM right after pushState, so this heals itself within ~250 ms; a router that changes the URL without
  // touching id/class/data-testid/data-variation/text does not. Remove test.fail() when the route is re-checked (e.g. by the 1 s re-assertion).
  test("pushState-only navigation flips the pin to other-route", async () => {
    test.fail();
    const s = await session(ANCHORS_ARTIFACT);
    try {
      const r = await route(s.window);
      const sent = await set(s.window, [query("a0", r, { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } })]);
      await waitEpoch(s.window, sent.epoch);
      await guestEval(s.window, `history.pushState({}, "", "/elsewhere.html")`);
      await expect.poll(async () => (await lastResults(s.window))!.results[0].match, { timeout: 8_000 }).toBe("other-route");
    } finally { await s.cleanup(); }
  });

  // Control for spike S1: the same 60 Hz page mutation on the 50k-node page WITHOUT any anchors, so the frame drops the page causes by itself
  // are not attributed to the tracker. Logs only (the numbers are what the report needs).
  test("S1 control: 50k-node page churning at 60 Hz with no anchors (frame intervals)", async () => {
    const s = await session(anchorPerfArtifact(50000));
    try {
      await expect.poll(() => guestEval(s.window, `document.querySelectorAll("div.row").length`), { timeout: 60_000 }).toBe(50000);
      const runs: Array<Record<string, number>> = [];
      for (let i = 0; i < 3; i++) {
        await guestEval(s.window, `window.__perf.start(); window.__startChurn(60)`);
        await s.window.waitForTimeout(3000);
        await guestEval(s.window, `window.__stopChurn()`);
        const d = await guestEval<number[]>(s.window, `window.__perf.stop()`);
        runs.push({ frames: d.length, p95: percentile(d, 0.95), max: Math.max(...d), over20: d.filter((x) => x > 20).length });
      }
      console.log("QA-G2 control churn " + JSON.stringify(runs));
    } finally { await s.cleanup(); }
  });

  test("reserved directory: comments.json and variants are never served to the page over the real protocol", async () => {
    const s = await session(ANCHORS_ARTIFACT, {
      prepare: (root) => {
        fs.mkdirSync(path.join(root, ".threads-design"), { recursive: true });
        fs.writeFileSync(path.join(root, ".threads-design", "comments.json"), `{"secret":"QA-G2-SECRET"}`);
      },
    });
    try {
      const variants = [
        "/.threads-design/comments.json", "/.threads-design/", "/.threads-design", "/.THREADS-DESIGN/comments.json", "/%2ethreads-design/comments.json",
        "/./.threads-design/comments.json", "/x/../.threads-design/comments.json", "/.threads-design%2fcomments.json", "//.threads-design/comments.json",
        "/.threads-design/comments.json?x=1", "/.threads-design/comments.json#h", "/.threads-design%5Ccomments.json", "/.threads-design./comments.json",
      ];
      const out = await guestEval<Array<{ v: string; status: number | string; leaked: boolean; img: string }>>(s.window, `Promise.all(${JSON.stringify(variants)}.map(async (v) => {
        let status = "err", leaked = false;
        try { const r = await fetch(v); status = r.status; leaked = (await r.text()).includes("QA-G2-SECRET"); } catch (e) { status = "blocked"; }
        const img = await new Promise((res) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => res("error"); i.src = v; setTimeout(() => res("timeout"), 3000); });
        return { v, status, leaked, img };
      }))`);
      console.log("QA-G2 reserved " + JSON.stringify(out.map((o) => `${o.v}=${o.status}/${o.img}`)));
      for (const o of out) {
        expect(o.leaked, o.v).toBe(false);
        expect(o.status === 200, o.v).toBe(false);
        expect(o.img, o.v).not.toBe("loaded");
      }
    } finally { await s.cleanup(); }
  });
});
