import * as fs from "node:fs";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import {
  CHART_ARTIFACT,
  RESPONSIVE_ARTIFACT,
  makeEnv,
  writeStaticArtifact,
  type ArtifactSpec,
  type E2eEnv,
} from "./helpers/artifact-picker-fixtures";

/**
 * Element picker, Phase 2a (ADR 0006 notes): the highlight, the selected-element box and the comment popover follow the
 * element when the pane resizes or the page scrolls; an element the page removes is reported without losing the typed
 * comment; the keyboard walk scrolls into view; the popover stays usable in a very narrow pane; SVG selectors keep
 * their tag case. Real Electron, the real registry/bridge/preload/webview, the fake feedback plugin from Phase 1.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const shotsDir = process.env.PICKER_SHOTS_DIR ?? path.join(repoRoot, "test-results", "p2a-screenshots");

interface Session { app: ElectronApplication; window: Page; env: E2eEnv; root: string; cleanup(): Promise<void> }

async function launch(env: E2eEnv, size: [number, number], collapseSidebars: boolean): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${env.userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any, s) => win.setSize(s[0], s[1]), size);
  if (collapseSidebars) {
    await window.evaluate(() => {
      const a = (window as any).app;
      for (const sidebar of [a.workspace.leftSidebar, a.workspace.rightSidebar]) if (!sidebar.collapsed) sidebar.toggle();
    });
  }
  return { app, window };
}

async function session(spec: ArtifactSpec, options: { size?: [number, number]; collapseSidebars?: boolean } = {}): Promise<Session> {
  const env = makeEnv("geode-picker-p2a-");
  const root = path.join(env.temp, "artifact");
  writeStaticArtifact(root, spec);
  const { app, window } = await launch(env, options.size ?? [1280, 800], options.collapseSidebars ?? true);
  await expect.poll(() => window.evaluate(() => typeof (window as any).__feedbackProbe?.register), { timeout: 30_000 }).toBe("function");
  expect(await window.evaluate(() => (window as any).__feedbackProbe.register())).toBe("registered");
  await window.evaluate((r) => (window as any).app.openArtifact(r), root);
  await expect(window.locator(".artifact-view-frame")).toBeVisible();
  await expect(toggleOf(window)).toBeVisible();
  return { app, window, env, root, cleanup: async () => { await app.close().catch(() => {}); fs.rmSync(env.temp, { recursive: true, force: true }); } };
}

const toggleOf = (w: Page): Locator => w.locator(".artifact-view-pick-btn");
const popoverOf = (w: Page): Locator => w.locator(".pick-popover");
const statusOf = (w: Page): Locator => w.locator(".pick-popover-status");
const frameOf = (w: Page): Locator => w.locator(".artifact-view-frame");
const guestEval = <T = unknown>(w: Page, code: string): Promise<T> => frameOf(w).evaluate((g, c) => (g as any).executeJavaScript(c), code) as Promise<T>;

const guestInput = (app: ElectronApplication, event: Record<string, unknown>) =>
  app.evaluate(({ webContents }, e) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed() && !w.getURL().startsWith("devtools"));
    if (!guest) return false;
    guest.sendInputEvent(e as any);
    return true;
  }, event);
const moveTo = (app: ElectronApplication, x: number, y: number) => guestInput(app, { type: "mouseMove", x, y });
async function clickAt(app: ElectronApplication, x: number, y: number): Promise<void> {
  await moveTo(app, x, y);
  await guestInput(app, { type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await guestInput(app, { type: "mouseUp", x, y, button: "left", clickCount: 1 });
}
async function guestKey(app: ElectronApplication, keyCode: string): Promise<void> {
  await guestInput(app, { type: "keyDown", keyCode });
  await guestInput(app, { type: "keyUp", keyCode });
}
/** RGB of one pixel of the guest's own surface (guest viewport px), from the main process. */
const guestPixel = (app: ElectronApplication, x: number, y: number): Promise<[number, number, number]> =>
  app.evaluate(async ({ webContents }, p) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed() && !w.getURL().startsWith("devtools"))!;
    const image = await guest.capturePage({ x: Math.round(p.x), y: Math.round(p.y), width: 1, height: 1 });
    const bitmap = image.toBitmap(); // BGRA
    return [bitmap[2]!, bitmap[1]!, bitmap[0]!] as [number, number, number];
  }, { x, y });
/** The guest highlight is #7c3aed over a 14% wash; its 2 px border pixel is unmistakably violet. */
const isViolet = ([r, g, b]: [number, number, number]) => b > 180 && r > 90 && r < 170 && g < 110;

interface Box { x: number; y: number; width: number; height: number }
const trueRect = (w: Page, selector: string) => guestEval<Box>(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const setWindowSize = async (s: Session, width: number, height: number) => {
  const bw = await s.app.browserWindow(s.window);
  await bw.evaluate((win: any, size) => win.setSize(size[0], size[1]), [width, height]);
};
async function windowShot(s: Session, name: string): Promise<void> {
  fs.mkdirSync(shotsDir, { recursive: true });
  await s.window.waitForTimeout(250);
  const png = await s.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(png, "base64"));
}
const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;
const hoverChip = (w: Page): Locator => w.locator(".artifact-view-hover");

test.describe("element picker phase 2a", () => {
  test.setTimeout(120_000);

  test("R1a: a hover highlight follows its element when the window resizes (no pointer move)", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      const before = await trueRect(s.window, "#fluid");
      await moveTo(s.app, before.x + before.width / 2, before.y + 30);
      await expect(hoverChip(s.window)).toContainText("<div>");
      await expect.poll(async () => isViolet(await guestPixel(s.app, before.x + 1, before.y + 30))).toBe(true);
      await windowShot(s, "R1a-1-hover-before-resize");

      await setWindowSize(s, 960, 700);
      await expect.poll(async () => Math.round((await trueRect(s.window, "#fluid")).x)).not.toBe(Math.round(before.x));
      const after = await trueRect(s.window, "#fluid");
      expect(Math.abs(after.x - before.x)).toBeGreaterThan(20); // it really moved
      // the highlight moved with it: violet on the element's new left border, not on the old one
      await expect.poll(async () => isViolet(await guestPixel(s.app, after.x + 1, after.y + 30)), { timeout: 8_000 }).toBe(true);
      expect(isViolet(await guestPixel(s.app, before.x + 1, before.y + 30))).toBe(false);
      // and the toolbar chip shows the new size
      await expect(hoverChip(s.window)).toContainText(`${Math.round(after.width)} × ${Math.round(after.height)}`);
      await windowShot(s, "R1a-2-hover-after-resize");
    } finally { await s.cleanup(); }
  });

  test("R1b: with the popover open, a resize moves the selected-element box and keeps the popover inside the pane with Send reachable", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      const r0 = await trueRect(s.window, "#fluid");
      await clickAt(s.app, r0.x + r0.width / 2, r0.y + 30);
      await expect(popoverOf(s.window)).toBeVisible();
      await popoverOf(s.window).getByRole("textbox").fill("Make this block taller and align it left.");
      await windowShot(s, "R1b-1-popover-before-resize");

      await setWindowSize(s, 900, 700);
      await expect.poll(async () => Math.round((await trueRect(s.window, "#fluid")).x)).not.toBe(Math.round(r0.x));
      const r1 = await trueRect(s.window, "#fluid");
      const frameBox = (await frameOf(s.window).boundingBox())!;
      await expect.poll(async () => {
        const box = await s.window.locator(".artifact-view-selection-box").boundingBox();
        return box ? Math.abs(box.x - (frameBox.x + r1.x)) + Math.abs(box.y - (frameBox.y + r1.y)) + Math.abs(box.width - r1.width) : 999;
      }, { timeout: 8_000 }).toBeLessThanOrEqual(6);
      const stage = (await s.window.locator(".artifact-view-stage").boundingBox())!;
      const pop = (await popoverOf(s.window).boundingBox())!;
      expect(pop.x).toBeGreaterThanOrEqual(stage.x - 1);
      expect(pop.x + pop.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
      expect(pop.y + pop.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
      await expect(popoverOf(s.window).getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });
      await expect(popoverOf(s.window).getByRole("textbox")).toHaveValue("Make this block taller and align it left.");
      await windowShot(s, "R1b-2-popover-after-resize");
      // Send still works after the re-anchor
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
    } finally { await s.cleanup(); }
  });

  test("R1b2: a viewport preset change re-anchors the box and the popover", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      const r0 = await trueRect(s.window, "#fluid");
      await clickAt(s.app, r0.x + r0.width / 2, r0.y + 30);
      await expect(popoverOf(s.window)).toBeVisible();
      await s.window.locator('[data-viewport="mobile"]').click();
      await expect.poll(async () => Math.round((await trueRect(s.window, "#fluid")).x)).not.toBe(Math.round(r0.x));
      const r1 = await trueRect(s.window, "#fluid");
      const frameBox = (await frameOf(s.window).boundingBox())!;
      await expect.poll(async () => {
        const box = await s.window.locator(".artifact-view-selection-box").boundingBox();
        return box ? Math.abs(box.x - (frameBox.x + r1.x)) + Math.abs(box.y - (frameBox.y + r1.y)) : 999;
      }, { timeout: 8_000 }).toBeLessThanOrEqual(6);
      const stage = (await s.window.locator(".artifact-view-stage").boundingBox())!;
      const pop = (await popoverOf(s.window).boundingBox())!;
      expect(pop.x + pop.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
      await windowShot(s, "R1b2-mobile-preset-popover");
    } finally { await s.cleanup(); }
  });

  test("R1c: scrolling the page with the popover open moves the box with the element, and an off-screen element keeps the popover usable", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      const r0 = await trueRect(s.window, "#fluid");
      await clickAt(s.app, r0.x + r0.width / 2, r0.y + 30);
      await expect(popoverOf(s.window)).toBeVisible();
      await popoverOf(s.window).getByRole("textbox").fill("Scrolling test comment");
      const frameBox = (await frameOf(s.window).boundingBox())!;
      const boxY = async () => (await s.window.locator(".artifact-view-selection-box").boundingBox())!.y;
      const y0 = await boxY();
      expect(near(y0, frameBox.y + r0.y)).toBe(true);

      await guestEval(s.window, `window.scrollTo(0, 200)`);
      await expect.poll(async () => Math.round(y0 - (await boxY())), { timeout: 8_000 }).toBeGreaterThanOrEqual(198);
      expect(near(y0 - (await boxY()), 200, 3)).toBe(true);
      await windowShot(s, "R1c-1-scrolled-200");

      // far past the element: the box is off the top of the stage; the popover is clamped inside it and stays usable
      await guestEval(s.window, `window.scrollTo(0, 1500)`);
      const stage = (await s.window.locator(".artifact-view-stage").boundingBox())!;
      await expect.poll(async () => {
        const pop = await popoverOf(s.window).boundingBox();
        return pop !== null && pop.y >= stage.y - 1 && pop.y + pop.height <= stage.y + stage.height + 1;
      }, { timeout: 8_000 }).toBe(true);
      await expect(popoverOf(s.window).getByRole("textbox")).toBeVisible();
      await expect(popoverOf(s.window).getByRole("textbox")).toHaveValue("Scrolling test comment");
      await windowShot(s, "R1c-2-scrolled-far");
    } finally { await s.cleanup(); }
  });

  test("R1d: when the page removes the selected element, the popover says so and keeps the typed comment; Pick again restores it on the next pick", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      await clickAt(s.app, 100, 420); // #victim
      await expect(popoverOf(s.window)).toBeVisible();
      await expect(popoverOf(s.window).getByRole("heading")).toHaveText("Comment on <button>");
      await popoverOf(s.window).getByRole("textbox").fill("Rename this button to something friendlier.");
      await windowShot(s, "R1d-1-before-removal");

      await guestEval(s.window, `window.__remove()`);
      await expect(statusOf(s.window)).toHaveText("The element changed or was removed. Pick it again to keep your comment.", { timeout: 8_000 });
      await expect(popoverOf(s.window).getByRole("textbox")).toHaveValue("Rename this button to something friendlier.");
      await expect(popoverOf(s.window).getByRole("button", { name: "Send" })).toBeHidden();
      await expect(popoverOf(s.window).getByRole("button", { name: "Pick again" })).toBeVisible();
      // the box that marked the vanished element is gone too (it would otherwise tint empty space)
      await expect(s.window.locator(".artifact-view-selection-box")).toBeHidden();
      await windowShot(s, "R1d-2-element-gone");

      await popoverOf(s.window).getByRole("button", { name: "Pick again" }).click();
      await expect(popoverOf(s.window)).toBeHidden();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await guestEval(s.window, `window.__restore()`);
      await expect.poll(() => guestEval(s.window, `!!document.getElementById("victim")`)).toBe(true);
      const r = await trueRect(s.window, "#victim");
      await clickAt(s.app, r.x + r.width / 2, r.y + r.height / 2);
      await expect(popoverOf(s.window)).toBeVisible();
      await expect(popoverOf(s.window).getByRole("textbox")).toHaveValue("Rename this button to something friendlier.");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await s.window.evaluate(() => (window as any).__feedbackProbe.requests as any[]);
      expect(requests).toHaveLength(1);
      expect(requests[0].comment).toBe("Rename this button to something friendlier.");
      expect(requests[0].selection.tag).toBe("button");
    } finally { await s.cleanup(); }
  });

  test("R2: [ and ] scroll the walked element into view so the highlight is visible", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).focus();
      await s.window.keyboard.press("Enter"); // keyboard activation: focus moves into the page
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      expect(await guestEval(s.window, `window.scrollY`)).toBe(0);
      await guestKey(s.app, "]"); // body > section#tall
      await expect(hoverChip(s.window)).toContainText("<section>");
      await guestKey(s.app, "]"); // section > p#far, 2500 px down
      await expect(hoverChip(s.window)).toContainText("<p>");
      await expect.poll(() => guestEval<number>(s.window, `window.scrollY`), { timeout: 8_000 }).toBeGreaterThan(1000);
      const far = await trueRect(s.window, "#far");
      const viewport = await guestEval<{ w: number; h: number }>(s.window, `({ w: innerWidth, h: innerHeight })`);
      expect(far.y).toBeGreaterThanOrEqual(0);
      expect(far.y + far.height).toBeLessThanOrEqual(viewport.h + 1);
      // the highlight is actually drawn on it (violet border pixel), not null/off-screen
      await expect.poll(async () => isViolet(await guestPixel(s.app, far.x + 1, far.y + far.height / 2)), { timeout: 8_000 }).toBe(true);
      await windowShot(s, "R2-keyboard-walk-scrolled");
      // Enter selects it
      await guestKey(s.app, "Enter");
      await expect(popoverOf(s.window)).toBeVisible();
    } finally { await s.cleanup(); }
  });

  test("R3: in a very narrow pane the popover keeps a usable width and Send and Cancel stay reachable", async () => {
    // Geode's real minimum window (640 px) with both side panels open leaves a pane of a few dozen px.
    const s = await session(RESPONSIVE_ARTIFACT, { size: [640, 800], collapseSidebars: false });
    try {
      const stage = (await s.window.locator(".artifact-view-stage").boundingBox())!;
      expect(stage.width, "precondition: a pane narrower than the popover minimum").toBeLessThan(250);
      await s.window.evaluate(() => (window as any).app.commands.executeCommandById("artifact.toggle-pick"));
      await expect.poll(() => s.window.evaluate(() => document.querySelector(".artifact-view-pick-btn")?.getAttribute("aria-pressed"))).toBe("true");
      await clickAt(s.app, Math.max(2, stage.width / 2), 20);
      await expect(popoverOf(s.window)).toBeVisible();
      await popoverOf(s.window).getByRole("textbox").fill("Narrow pane comment");
      const pop = (await popoverOf(s.window).boundingBox())!;
      const win = await s.window.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      expect(pop.width).toBeGreaterThanOrEqual(238);
      expect(pop.x).toBeGreaterThanOrEqual(0);
      expect(pop.x + pop.width).toBeLessThanOrEqual(win.w + 1);
      expect(pop.y + pop.height).toBeLessThanOrEqual(win.h + 1);
      await expect(popoverOf(s.window).getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });
      await expect(popoverOf(s.window).getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
      await windowShot(s, "R3-narrow-pane-popover");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click(); // actionable: nothing covers it
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      await windowShot(s, "R3-narrow-pane-accepted");
    } finally { await s.cleanup(); }
  });

  test("R3b: the popover is hidden while its artifact tab is not showing", async () => {
    const s = await session(RESPONSIVE_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      const r0 = await trueRect(s.window, "#fluid");
      await clickAt(s.app, r0.x + r0.width / 2, r0.y + 30);
      await expect(popoverOf(s.window)).toBeVisible();
      // open another tab in the same group: the artifact view is hidden, so must its body-level popover be
      await s.window.evaluate(async () => { const a = (window as any).app; await a.openFile(a.vault.getFileByPath("Welcome.md"), true); });
      await expect(popoverOf(s.window)).toBeHidden({ timeout: 8_000 });
    } finally { await s.cleanup(); }
  });

  test("R4: SVG picks produce selectors that resolve to exactly the picked node in real Chromium, with the original tag case", async () => {
    const s = await session(CHART_ARTIFACT);
    try {
      await toggleOf(s.window).click();
      // a bar (rect)
      const bar = await trueRect(s.window, "#bar2");
      await clickAt(s.app, bar.x + bar.width / 2, bar.y + bar.height / 2);
      await expect(popoverOf(s.window)).toBeVisible();
      await windowShot(s, "R4-1-svg-bar-popover");
      await popoverOf(s.window).getByRole("textbox").fill("Make this bar green.");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      let [request] = await s.window.evaluate(() => (window as any).__feedbackProbe.requests as any[]);
      expect(request.selection.tag).toBe("rect");
      expect(request.selection.selector).toBe("#bar2");
      await popoverOf(s.window).getByRole("button", { name: "Done" }).click();

      // a camelCase SVG element: foreignObject, reached by [ from its HTML child
      await toggleOf(s.window).focus();
      await s.window.keyboard.press("Enter");
      const note = await trueRect(s.window, "#note-body");
      await moveTo(s.app, note.x + 10, note.y + 8);
      await expect(hoverChip(s.window)).toContainText("<div>");
      await guestKey(s.app, "[");
      await expect(hoverChip(s.window)).toContainText("<foreignobject>"); // the contract tag stays lower-case
      await guestKey(s.app, "Enter");
      await expect(popoverOf(s.window)).toBeVisible();
      await popoverOf(s.window).getByRole("textbox").fill("Reword this note.");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await s.window.evaluate(() => (window as any).__feedbackProbe.requests as any[]);
      request = requests[1];
      expect(request.selection.tag).toBe("foreignobject");
      const selectors = [request.selection.selector, ...request.selection.selectorAlternates] as string[];
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        const result = await guestEval<{ count: number; name: string | null }>(s.window, `(() => { const f = document.querySelectorAll(${JSON.stringify(selector)}); return { count: f.length, name: f[0] ? f[0].localName : null }; })()`);
        expect(result, selector).toEqual({ count: 1, name: "foreignObject" });
      }
      // Observed (Electron 42 / Chromium): in an HTML document the lower-cased spelling ALSO matches SVG elements here, so the
      // case-preserving selector is spec-correct and engine-portable rather than a fix for a Chromium failure. Logged, not asserted.
      const lowercased = await guestEval<number>(s.window, `document.querySelectorAll("foreignobject").length`);
      console.log(`[picker-svg-case] document.querySelectorAll("foreignobject").length = ${lowercased} in this Chromium`);
      expect(request.selection.outerHTML.html).toContain("<foreignObject");
      expect(request.selection.outerHTML.html).toContain("</foreignObject>");
      await windowShot(s, "R4-2-svg-foreignobject-sent");
    } finally { await s.cleanup(); }
  });
});
