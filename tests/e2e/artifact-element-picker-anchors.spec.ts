import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { ANCHORS_ARTIFACT, RESPONSIVE_ARTIFACT } from "./helpers/artifact-picker-fixtures";
import { counts, guestEval, inView, lastRects, lastResults, near, percentile, query, route, session } from "./helpers/anchor-e2e";

/**
 * Phase 2b-i G2 (ADR 0006 addendum 2): the guest anchor tracker in the real preload, driven through the view's
 * anchorProbe (no pin UI yet). T1 forged anchor messages, T2 patched prototypes and decoys, T3 pathological selectors
 * on a 50k-node DOM, T9 the page cannot read comments or see them on the wire.
 */

const BUY = { x: 100, y: 200, width: 160, height: 48 };
const waitResults = (w: import("@playwright/test").Page, epoch: number) =>
  expect.poll(async () => (await lastResults(w))?.epoch ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(epoch);

test.describe("guest anchors (phase 2b-i G2)", () => {
  test.setTimeout(180_000);

  test("pins resolve with the picker off, follow resize and scroll, notice removal, and survive a reload", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      const r = await route(s.window);
      const set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), [
        query("a0", r, { selector: "#fluid", textAnchor: { tag: "div", text: "Fluid block" } }),
        query("a1", r, { tag: "p", selector: "#far", textAnchor: { tag: "p", text: "Far down the page" } }),
        query("a2", r, { tag: "button", selector: "#victim", textAnchor: { tag: "button", text: "Remove me" } }),
      ]);
      expect(set).toMatchObject({ sent: 3, rejected: [] });
      await waitResults(s.window, set.epoch);
      const first = (await lastResults(s.window))!;
      expect(first.results.map((x: any) => [x.key, x.match, x.agrees])).toEqual([["a0", "selector", true], ["a1", "selector", true], ["a2", "selector", true]]);
      const trueFluid = await guestEval<{ x: number; width: number }>(s.window, `(() => { const r = document.querySelector("#fluid").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      expect(near(first.results[0].rect.x, trueFluid.x)).toBe(true);
      expect(first.results[0].visible).toBe(true);
      expect(first.results[1].visible).toBe(false); // 2500 px down

      // resize: the fluid block moves, a rects report follows with its new place
      const bw = await s.app.browserWindow(s.window);
      await bw.evaluate((win: any) => win.setSize(960, 700));
      await expect.poll(async () => {
        const rects = await lastRects(s.window);
        const now = await guestEval<number>(s.window, `document.querySelector("#fluid").getBoundingClientRect().x`);
        return rects ? near(rects.rects[0].rect.x, now) && Math.abs(now - trueFluid.x) > 20 : false;
      }, { timeout: 20_000 }).toBe(true);

      // scroll: the far paragraph becomes visible and its rect is the true one
      await guestEval(s.window, `window.scrollTo(0, 2400)`);
      await expect.poll(async () => (await lastRects(s.window))?.rects.find((x: any) => x.key === "a1")?.visible, { timeout: 20_000 }).toBe(true);
      const farNow = await guestEval<number>(s.window, `document.querySelector("#far").getBoundingClientRect().y`);
      expect(near((await lastRects(s.window))!.rects.find((x: any) => x.key === "a1").rect.y, farNow)).toBe(true);
      await guestEval(s.window, `window.scrollTo(0, 0)`);

      // removal is noticed by the mutation observer, a restored element is found again
      await guestEval(s.window, `window.__remove()`);
      await expect.poll(async () => (await lastResults(s.window))?.results.find((x: any) => x.key === "a2")?.match, { timeout: 20_000 }).toBe("detached");
      await guestEval(s.window, `window.__restore()`);
      await expect.poll(async () => (await lastResults(s.window))?.results.find((x: any) => x.key === "a2")?.match, { timeout: 20_000 }).toBe("selector");

      // jump to: scrolls the page, and the flash outline is drawn
      await guestEval(s.window, `window.scrollTo(0, 0)`);
      expect(await inView(s.window, (p: any) => p.focus("a1", "scroll"))).toBe(true);
      await expect.poll(() => guestEval<number>(s.window, `window.scrollY`), { timeout: 20_000 }).toBeGreaterThan(1000);

      // a reload (new document) gets the anchors again under a new epoch
      const before = await counts(s.window);
      await guestEval(s.window, `setTimeout(() => location.reload(), 0)`).catch(() => {});
      await expect.poll(async () => (await counts(s.window)).epoch, { timeout: 30_000 }).toBeGreaterThan(before.epoch);
      await waitResults(s.window, before.epoch + 1);
      expect((await lastResults(s.window))!.results.map((x: any) => x.match)).toEqual(["selector", "selector", "selector"]);
    } finally { await s.cleanup(); }
  });

  test("T1: a page that forges anchor messages (postMessage, events, correct epoch and keys) changes nothing", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      await expect.poll(() => guestEval(s.window, `typeof window.__anchorHostile`)).toBe("object");
      const r = await route(s.window);
      const set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), [
        query("a0", r, { tag: "button", selector: "[data-testid=\"buy\"]", textAnchor: { tag: "button", text: "Buy now" } }),
      ]);
      await waitResults(s.window, set.epoch);
      const settled = await counts(s.window);
      await guestEval(s.window, `window.__anchorHostile.forge(${set.epoch}, ["a0"]); window.__anchorHostile.forge(${set.epoch + 1}, ["a0", "a1"])`);
      await s.window.waitForTimeout(1500);
      const after = await counts(s.window);
      expect(after.results).toBe(settled.results);
      expect(after.rects).toBe(settled.rects);
      expect(await guestEval<number>(s.window, `window.__forged`)).toBeGreaterThanOrEqual(8);
      expect((await lastResults(s.window))!.results[0].rect).toMatchObject(BUY);
    } finally { await s.cleanup(); }
  });

  test("T2: patched prototypes cannot move a pin; a decoy cannot beat the original; a lone decoy is the documented residual", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      await expect.poll(() => guestEval(s.window, `typeof window.__anchorHostile`)).toBe("object");
      await guestEval(s.window, `window.__anchorHostile.patch(); window.__anchorHostile.addDecoy()`);
      const r = await route(s.window);
      const buyQuery = query("a0", r, { tag: "button", selector: "[data-testid=\"buy\"]", textAnchor: { tag: "button", text: "Buy now" } });
      let set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), [buyQuery]);
      await waitResults(s.window, set.epoch);
      expect((await lastResults(s.window))!.results[0]).toMatchObject({ match: "selector", agrees: true, rect: BUY });

      // stale selector + the decoy has the same text: two candidates, so no guess
      set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), [{ ...buyQuery, selector: "#gone" }]);
      await waitResults(s.window, set.epoch);
      expect((await lastResults(s.window))!.results[0].match).toBe("detached");

      // original gone, only the decoy left: the text anchor finds it (visual-only residual, ADR addendum 2)
      await guestEval(s.window, `window.__anchorHostile.removeBuy()`);
      set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), [{ ...buyQuery, selector: "#gone" }]);
      await waitResults(s.window, set.epoch);
      expect((await lastResults(s.window))!.results[0]).toMatchObject({ match: "text", rect: { x: 600, y: 500 } });
      expect(await guestEval<number | undefined>(s.window, `window.__hostileScroll`)).toBeUndefined(); // the patched scrollIntoView was never called
    } finally { await s.cleanup(); }
  });

  test("T3: pathological stored selectors on a 50k-node page are detached without a hang", async () => {
    const s = await session(ANCHORS_ARTIFACT);
    try {
      await guestEval(s.window, `window.__anchorHostile.build(50000)`);
      const r = await route(s.window);
      const bad = [
        ":has(*) :has(*) :has(*) :has(*)", "span:has(> span)", "span:is(a, b, c)", ":where(span) :where(span)", "span:not(.a):not(.b)",
        "span, div, p", "span ~ span", "span + span", "svg|*", "*:nth-child(2n+1)", "span::before",
        Array.from({ length: 50 }, () => "span").join(" > "), `span${"[a]".repeat(120)}`,
      ];
      const queries = [
        ...bad.map((selector, i) => query(`a${i}`, r, { tag: "span", selector, alternates: [bad[(i + 1) % bad.length]], textAnchor: { tag: "span", text: "" } })),
        query("a50", r, { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } }),
      ];
      await guestEval(s.window, `window.__perf.start()`);
      const started = Date.now();
      const set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), queries);
      await waitResults(s.window, set.epoch);
      const elapsed = Date.now() - started;
      const deltas = await guestEval<number[]>(s.window, `window.__perf.stop()`);
      const res = (await lastResults(s.window))!.results;
      for (const x of res.slice(0, bad.length)) expect(x.match).toBe("detached");
      expect(res[bad.length]).toMatchObject({ match: "selector", agrees: true });
      expect(elapsed).toBeLessThan(5000);
      expect(Math.max(...deltas)).toBeLessThan(250);
    } finally { await s.cleanup(); }
  });

  test("T9: the page cannot read comments.json, and neither comment text nor ids are ever sent to the guest", async () => {
    const s = await session(ANCHORS_ARTIFACT, {
      prepare: (root) => {
        fs.mkdirSync(path.join(root, ".threads-design"), { recursive: true });
        fs.writeFileSync(path.join(root, ".threads-design", "comments.json"), `{"secret":"ANCHOR-COMMENT-SECRET"}`);
      },
    });
    try {
      const fetched = await guestEval<string>(s.window, `fetch(".threads-design/comments.json").then((r) => r.text().then((t) => r.status + ":" + t), (e) => "blocked").catch(() => "blocked")`);
      expect(fetched).not.toContain("ANCHOR-COMMENT-SECRET");
      expect(fetched.startsWith("200")).toBe(false);

      await s.window.evaluate(() => {
        const view = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view;
        const frame = view.containerEl.querySelector("webview");
        const sent: string[] = ((window as any).__wire = []);
        const original = frame.send.bind(frame);
        frame.send = (channel: string, ...args: unknown[]) => { sent.push(`${channel} ${JSON.stringify(args)}`); return original(channel, ...args); };
      });
      const r = await route(s.window);
      const set = await inView(s.window, (p: any, _v: any, a: any) => p.setAnchors(a), [
        { ...query("a0", r, { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } }), id: "cmt_00000000000000000000000000000001", text: "ANCHOR-COMMENT-SECRET", ordinal: 4, status: "open" },
      ]);
      await waitResults(s.window, set.epoch);
      await inView(s.window, (p: any) => p.focus("a0", "flash"));
      const wire = await s.window.evaluate(() => (window as any).__wire as string[]);
      const anchors = wire.filter((m) => m.includes("inspect:v1:anchors"));
      expect(anchors.length).toBeGreaterThan(0);
      expect(wire.join("\n")).not.toContain("ANCHOR-COMMENT-SECRET");
      expect(wire.join("\n")).not.toContain("cmt_");
    } finally { await s.cleanup(); }
  });
});

void percentile;
