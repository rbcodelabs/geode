import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { anchorPerfArtifact } from "./helpers/artifact-picker-fixtures";
import { guestEval, inView, lastResults, percentile, query, repoRoot, route, session } from "./helpers/anchor-e2e";

/**
 * Spike S1 (design note section 7) and the T7 budget: 100 anchors on the 5k and 50k node pages. Measures, in the real
 * Electron guest, the time from setAnchors to the results message and the page's frame intervals (a requestAnimationFrame
 * loop in the page shares the main thread with the preload, so a long guest slice shows up as a long frame).
 * Writes test-results/s1-anchors.json; the assertions are the shipped budget.
 */

type Kind = "selector" | "structural" | "text" | "detached" | "mixed";
const FRAME_BUDGET_MS = 50; // a frame this long means the guest held the thread far beyond its 4 ms slice

function queries(kind: Kind, n: number, r: string) {
  const out: unknown[] = [];
  for (let k = 0; k < 100; k++) {
    const i = (k * 37 + 11) % n;
    const section = Math.floor(i / 50) + 1;
    const rowInSection = (i % 50) + 1; // h3 is the first child, rows are div children: nth-of-type counts divs only
    const which: Kind = kind === "mixed" ? (["selector", "structural", "text", "detached"] as const)[k % 4]! : kind;
    const base = { tag: "div", textAnchor: { tag: "div", text: `Item ${i}` }, landmark: null };
    if (which === "selector") out.push(query(`a${k}`, r, { ...base, selector: `#r${i}` }));
    else if (which === "structural") out.push(query(`a${k}`, r, { ...base, selector: `#big > section:nth-of-type(${section}) > div:nth-of-type(${rowInSection})` }));
    else if (which === "text") out.push(query(`a${k}`, r, { tag: "span", selector: "#gone", textAnchor: { tag: "span", text: `Item ${i}` } }));
    else out.push(query(`a${k}`, r, { tag: "span", selector: "#gone", textAnchor: { tag: "span", text: `No such ${i}` }, landmark: "No such heading" }));
  }
  return out;
}

const summary = (deltas: number[]) => ({
  frames: deltas.length,
  p50: Math.round(percentile(deltas, 0.5) * 10) / 10,
  p95: Math.round(percentile(deltas, 0.95) * 10) / 10,
  max: Math.round(Math.max(0, ...deltas) * 10) / 10,
});

const report: Record<string, unknown> = {};

for (const n of [5000, 50000]) {
  test.describe(`S1 ${n} nodes`, () => {
    test.setTimeout(240_000);
    for (const kind of ["selector", "structural", "text", "detached", "mixed"] as const) {
      test(`100 ${kind} anchors`, async () => {
        const s = await session(anchorPerfArtifact(n));
        try {
          await expect.poll(() => guestEval(s.window, `document.querySelectorAll("div.row").length`), { timeout: 60_000 }).toBe(n);
          const r = await route(s.window);
          await guestEval(s.window, `window.__perf.start()`);
          await s.window.waitForTimeout(1500);
          const baseline = await guestEval<number[]>(s.window, `(() => { const d = window.__perf.stop(); window.__perf.start(); return d; })()`);
          const started = Date.now();
          const set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), queries(kind, n, r));
          expect(set.sent).toBe(100);
          await expect.poll(async () => (await lastResults(s.window))?.epoch ?? 0, { timeout: 120_000 }).toBeGreaterThanOrEqual(set.epoch);
          const toResults = Date.now() - started;
          await s.window.waitForTimeout(500);
          const during = await guestEval<number[]>(s.window, `window.__perf.stop()`);
          const res = (await lastResults(s.window))!.results as Array<{ match: string }>;
          const matches = res.reduce<Record<string, number>>((acc, x) => { acc[x.match] = (acc[x.match] ?? 0) + 1; return acc; }, {});

          // churn: the page mutates 60 times a second for 3 s with the anchors live
          await guestEval(s.window, `window.__perf.start(); window.__startChurn(60)`);
          await s.window.waitForTimeout(3000);
          await guestEval(s.window, `window.__stopChurn()`);
          const churn = await guestEval<number[]>(s.window, `window.__perf.stop()`);

          report[`${n}/${kind}`] = { toResultsMs: toResults, matches, baseline: summary(baseline), duringPass: summary(during), duringChurn: summary(churn) };
          console.log(`S1 ${n} ${kind} ${JSON.stringify(report[`${n}/${kind}`])}`);
          fs.mkdirSync(path.join(repoRoot, "test-results"), { recursive: true });
          fs.writeFileSync(path.join(repoRoot, "test-results", `s1-anchors-${n}-${kind}.json`), JSON.stringify(report[`${n}/${kind}`], null, 2));
          expect(Math.max(...during)).toBeLessThan(Math.max(FRAME_BUDGET_MS, Math.max(...baseline) + FRAME_BUDGET_MS));
          expect(Math.max(...churn)).toBeLessThan(Math.max(FRAME_BUDGET_MS, Math.max(...baseline) + FRAME_BUDGET_MS));
        } finally { await s.cleanup(); }
      });
    }
  });
}
