import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { BASIC_ARTIFACT } from "./helpers/artifact-picker-fixtures";
import { session, type Session } from "./helpers/anchor-e2e";

/** QA G3 re-verify: screenshots of the fixed pin states, taken with the window's own capture (macOS, DPR as the Mac has it). */
const SHOT_DIR = process.env.QA_SHOT_DIR ?? path.resolve(__dirname, "..", "..", "test-results", "qa-g3-shots2");
async function shot(s: Session, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await s.window.waitForTimeout(700);
  const png = await s.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(png, "base64"));
}
const badges = (w: Page): Locator => w.locator(".pin-badge");
const rail = (w: Page): Locator => w.locator(".comments-rail");
const toggle = (w: Page): Locator => w.locator(".artifact-view-comments-btn");
const seed = (w: Page, rows: unknown[]) => w.evaluate((r) => (window as any).__feedbackProbe.store.seed(r), rows);
const BUY = { tag: "button", label: "button Buy now", anchor: { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } } };
const PRICE = { tag: "p", label: "p $29 per month", status: "sent", anchor: { tag: "p", selector: ".price", textAnchor: { tag: "p", text: "$29 per month" } } };
const HEAD = { tag: "h2", label: "h2 Plans", provenance: "foreign", anchor: { tag: "h2", selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" } } };
const NOTE = { tag: "p", label: "p Secret", anchor: { tag: "p", selector: "#vault-note", textAnchor: { tag: "p", text: "Secret title: Quarterly layoffs" } } };
void ({} as ElectronApplication);

test("screenshots: foreign hollow pin, sent check, edge-clamped badge, adopt confirm, desktop and narrow", async () => {
  test.setTimeout(180_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false, size: [1280, 800] });
  const w = s.window;
  try {
    await seed(w, [BUY, PRICE, HEAD, NOTE]);
    await expect(badges(w)).toHaveCount(4, { timeout: 20_000 });
    await shot(s, "v2-pins-desktop");
    const info = await badges(w).evaluateAll((els) => els.map((e) => ({ t: e.textContent, c: e.className, l: e.getAttribute("aria-label"), r: e.getBoundingClientRect().toJSON() })));
    console.log("QA-ANN badges", JSON.stringify(info));
    await toggle(w).click();
    await expect(rail(w)).toBeVisible();
    await shot(s, "v2-rail-desktop");
    await rail(w).locator(".comments-rail-adopt-all").click();
    await expect(rail(w).locator(".comments-rail-adopt-yes")).toBeVisible();
    await shot(s, "v2-adopt-confirm-desktop");
    await rail(w).locator(".comments-rail-adopt-no").click();
    await toggle(w).click();
    // edge: a short window with the desktop preset; scroll the stage so #buy's top-right is above the stage
    const bw = await s.app.browserWindow(w);
    await bw.evaluate((win: any) => win.setSize(1280, 520));
    await w.locator('[data-viewport="desktop"]').click();
    await expect.poll(() => w.locator(".artifact-view-stage").evaluate((e) => e.scrollHeight - e.clientHeight), { timeout: 10_000 }).toBeGreaterThan(50);
    await w.locator(".artifact-view-stage").evaluate((e) => { e.scrollTop = 240; });
    await w.waitForTimeout(600);
    const edge = await badges(w).evaluateAll((els) => els.map((e) => ({ t: e.textContent, c: e.className, l: e.getAttribute("aria-label") })));
    console.log("QA-ANN edge-badges", JSON.stringify(edge));
    await shot(s, "v2-edge-clamped");
    await w.locator('[data-viewport="fill"]').click();
    await bw.evaluate((win: any) => win.setSize(640, 800));
    await w.evaluate(() => { const side = (window as any).app.workspace.rightSidebar; if (side.collapsed) side.toggle(); });
    await expect.poll(() => w.locator(".artifact-view").evaluate((e) => e.clientWidth), { timeout: 15_000 }).toBeLessThan(540);
    await shot(s, "v2-pins-narrow");
    await toggle(w).click();
    await expect(rail(w)).toHaveClass(/is-sheet/);
    await shot(s, "v2-rail-narrow");
  } finally { await s.cleanup(); }
});

test("reportAnchors in the real app: nothing for an unchanged page, one state-only report 2 s or more after an agent edit moves a pin, nothing more afterwards", async () => {
  test.setTimeout(120_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
  const w = s.window;
  try {
    await seed(w, [BUY]);
    await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
    await w.waitForTimeout(4000);
    expect(await w.evaluate(() => (window as any).__feedbackProbe.store.reports.length)).toBe(0); // first-seen exact: nothing to heal
    const t0 = Date.now();
    const css = fs.readFileSync(path.join(s.root, "style.css"), "utf8").replace("#buy{position:absolute;left:100px", "#buy{position:absolute;left:300px");
    fs.writeFileSync(path.join(s.root, "style.css"), css);
    // an edit that only moves the element keeps the selector: still exact, so still nothing; now change what the selector hits
    const html = fs.readFileSync(path.join(s.root, "index.html"), "utf8").replace('id="buy"', 'id="buy2"');
    fs.writeFileSync(path.join(s.root, "index.html"), html);
    await expect.poll(() => w.evaluate(() => (window as any).__feedbackProbe.store.reports.length), { timeout: 30_000 }).toBeGreaterThan(0);
    const reports = await w.evaluate(() => (window as any).__feedbackProbe.store.reports);
    console.log("QA-ANN report-after-ms", reports[0].at - t0, JSON.stringify(reports));
    expect(reports).toHaveLength(1);
    expect(Object.keys(reports[0].reports[0]).sort()).toEqual(["id", "state"]);
    await w.waitForTimeout(5000);
    expect(await w.evaluate(() => (window as any).__feedbackProbe.store.reports.length)).toBe(1);
  } finally { await s.cleanup(); }
});
