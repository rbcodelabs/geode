import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BASIC_ARTIFACT } from "./helpers/artifact-picker-fixtures";
import { session } from "./helpers/anchor-e2e";

const badges = (w: Page) => w.locator(".pin-badge");
const rail = (w: Page) => w.locator(".comments-rail");
const toggle = (w: Page) => w.locator(".artifact-view-comments-btn");
const store = <T>(w: Page, fn: (store: any) => T): Promise<T> => w.evaluate(`(${fn.toString()})(window.__feedbackProbe.store)`) as Promise<T>;
const seed = (w: Page, rows: unknown[]) => w.evaluate((r) => (window as any).__feedbackProbe.store.seed(r), rows);
const BUY = { tag: "button", label: "button Buy now", anchor: { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } } };
const HEAD = { tag: "h2", label: "h2 Plans", anchor: { tag: "h2", selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" } } };

test("reportAnchors in the real app: nothing for an unchanged page, one state-only report after an agent edit changes what the selector hits, nothing more afterwards", async () => {
  test.setTimeout(120_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    await seed(w, [BUY]);
    await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
    await w.waitForTimeout(4000);
    expect(await store(w, (st) => st.reports.length)).toBe(0);
    const t0 = Date.now();
    const html = fs.readFileSync(path.join(s.root, "index.html"), "utf8").replace('id="buy"', 'id="buy2"');
    fs.writeFileSync(path.join(s.root, "index.html"), html);
    await expect.poll(() => store(w, (st) => st.reports.length), { timeout: 30_000 }).toBeGreaterThan(0);
    const reports = await store(w, (st) => st.reports);
    expect(reports).toHaveLength(1);
    expect(reports[0].at - t0).toBeGreaterThanOrEqual(2000);
    expect(Object.keys(reports[0].reports[0]).sort()).toEqual(["id", "state"]);
    expect(reports[0].reports[0].state).toBe("moved");
    await w.waitForTimeout(5000);
    expect(await store(w, (st) => st.reports.length)).toBe(1);
  } finally { await s.cleanup(); }
});

// BUG (QA-G3-12): the view-level "keep the coordinator, replace the client" branch is unreachable: the registry notifies on dispose,
// before the plugin registers again, so the view tears down first. Expected to fail until the reload keeps its state (or the claim and code go).
test("BUG: a reloaded handler (dispose then register) keeps the rail, the filter and the Retry for a timed-out send with the same requestId", async () => {
  test.fail();
  test.setTimeout(240_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    await seed(w, [BUY, HEAD]);
    await toggle(w).click();
    await rail(w).getByRole("button", { name: /^Open/ }).click();
    await store(w, (st) => { st.sendMode = "hang-once"; });
    await rail(w).locator(".comments-rail-send").click();
    await expect(rail(w).locator(".comments-rail-retry")).toBeVisible({ timeout: 40_000 });
    const first = await store(w, (st) => st.sendCalls[0].requestId);
    await w.evaluate(() => { const p = (window as any).__feedbackProbe; p.dispose(); return p.registerV2(); });
    await seed(w, [BUY, HEAD]);
    await w.waitForTimeout(800);
    await expect(rail(w)).toBeVisible();
    await expect(rail(w).locator('[aria-pressed="true"]')).toHaveText(/^Open/);
    await expect(rail(w).locator(".comments-rail-retry")).toBeVisible();
    await rail(w).locator(".comments-rail-retry").click();
    await expect.poll(() => store(w, (st) => st.sendCalls.length)).toBe(1);
    expect(await store(w, (st) => st.sendCalls[0].requestId)).toBe(first);
  } finally { await s.cleanup(); }
});

const SENT_ON_HEADING = { tag: "h2", label: "h2 Plans", status: "sent", anchor: { tag: "h2", selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" } } };
const FOREIGN_NOTE = { tag: "p", label: "p Secret", provenance: "foreign", anchor: { tag: "p", selector: "#vault-note", textAnchor: { tag: "p", text: "Secret title: Quarterly layoffs" } } };

test("marks: a foreign pin is hollow, dotted and named so; a sent pin's check is decoration inside the stage", async () => {
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false, size: [1280, 800] });
  const w = s.window;
  try {
    await seed(w, [BUY, SENT_ON_HEADING, FOREIGN_NOTE]);
    await expect(badges(w)).toHaveCount(3, { timeout: 20_000 });
    await w.waitForTimeout(800);
    const m = await w.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
      const all = [...document.querySelectorAll<HTMLElement>(".pin-badge")];
      const by = (t: string) => all.find((b) => b.firstChild?.nodeValue?.replace("~", "") === t)!;
      const cs = (e: HTMLElement) => getComputedStyle(e);
      const check = by("2").querySelector<HTMLElement>(".pin-badge-check")!;
      const cr = check.getBoundingClientRect();
      return {
        foreignClass: by("3").className, foreignLabel: by("3").getAttribute("aria-label"), foreignBorder: cs(by("3")).borderTopStyle,
        foreignBg: cs(by("3")).backgroundColor, openBg: cs(by("1")).backgroundColor, openBorder: cs(by("1")).borderTopStyle,
        checkPointer: cs(check).pointerEvents,
        checkInside: cr.left >= stage.left && cr.top >= stage.top && cr.right <= stage.right && cr.bottom <= stage.bottom,
        checkOver: { right: cr.right - stage.right, bottom: cr.bottom - stage.bottom },
      };
    });
    expect(m.foreignClass).toContain("is-foreign");
    expect(m.foreignLabel).toMatch(/not adopted/);
    expect(m.foreignBorder).toBe("dotted");
    expect(m.foreignBg).not.toBe(m.openBg);
    expect(m.openBorder).toBe("solid");
    expect(m.checkPointer).toBe("none");
    expect(m.checkInside).toBe(true);
  } finally { await s.cleanup(); }
});

test("marks: an element whose own anchor is outside the stage gets a clamped, marked, named badge", async () => {
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false, size: [1280, 800] });
  const w = s.window;
  try {
    await seed(w, [BUY]);
    await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
    const bw = await s.app.browserWindow(w);
    await bw.evaluate((win: any) => win.setSize(1280, 520));
    await w.locator('[data-viewport="desktop"]').click();
    await expect.poll(() => w.locator(".artifact-view-stage").evaluate((e) => e.scrollHeight - e.clientHeight), { timeout: 10_000 }).toBeGreaterThan(50);
    await w.locator(".artifact-view-stage").evaluate((e) => { e.scrollTop = 240; });
    await expect(badges(w)).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => badges(w).first().evaluate((e) => e.className), { timeout: 10_000 }).toContain("is-edge");
    expect(await badges(w).first().getAttribute("aria-label")).toMatch(/partly out of view/);
    await w.waitForTimeout(600);
    expect(await badges(w).first().evaluate((e) => getComputedStyle(e).opacity)).toBe("0.7");
    const inside = await w.evaluate(() => { const st = document.querySelector(".artifact-view-stage")!.getBoundingClientRect(); const b = document.querySelector(".pin-badge")!.getBoundingClientRect(); return b.left >= st.left && b.top >= st.top && b.right <= st.right && b.bottom <= st.bottom; });
    expect(inside).toBe(true);
  } finally { await s.cleanup(); }
});
