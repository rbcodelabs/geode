import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { ArtifactSpec } from "./helpers/artifact-picker-fixtures";
import { guestEval, session, type Session } from "./helpers/anchor-e2e";

/**
 * Back / forward / home in an artifact tab. The reported bug: a design "variations" board links to
 * variations/A/index.html inside the same guest webview, and once the user clicked in there was no way back to the
 * board short of re-previewing the artifact. Real Electron app, real guest, real history.
 */

const SHOT_DIR = process.env.NAV_SHOT_DIR ?? path.resolve(__dirname, "..", "..", "test-results", "nav-shots");
const BOARD = "/index.html";
const PAGE_A = "/variations/A/index.html";

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="${title === "Design options" ? "" : "../../"}style.css"></head><body>${body}</body></html>`;

/** The shape Claude Design emits for "options": a board of panels, each linking to a full page for that option. */
const VARIATIONS: ArtifactSpec = {
  id: "nav-variations",
  title: "Design options",
  html: page("Design options", `<header id="board-head"><h1 id="board-title">Design options</h1></header>
<main class="board">
<a id="opt-a" class="panel" href="variations/A/index.html"><h2>Option A</h2><p>Dense</p></a>
<a id="opt-b" class="panel" href="variations/B/index.html"><h2>Option B</h2><p>Airy</p></a>
<a id="ext" class="panel" href="https://example.com/escape"><h2>External</h2></a></main>`),
  files: {
    "style.css": `body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f6f6f8;color:#111}
#board-head{padding:16px 24px;background:#e9e9f3}
#board-title,#variant-title{margin:0}
.board{display:flex;gap:16px;padding:24px;flex-wrap:wrap}
.panel{display:block;width:220px;height:140px;padding:16px;background:#fff;border:1px solid #ccd;border-radius:8px;color:inherit;text-decoration:none}
.variant{padding:24px;background:#fff;height:100vh}`,
    "variations/A/index.html": page("Option A", `<main class="variant"><h1 id="variant-title">Option A: dense</h1><p>Full page for option A.</p></main>`),
    "variations/B/index.html": page("Option B", `<main class="variant"><h1 id="variant-title">Option B: airy</h1><p>Full page for option B.</p></main>`),
  },
};

const view = (w: Page): Locator => w.locator(".artifact-view");
const backBtn = (w: Page): Locator => view(w).getByRole("button", { name: "Back", exact: true });
const forwardBtn = (w: Page): Locator => view(w).getByRole("button", { name: "Forward", exact: true });
const homeBtn = (w: Page): Locator => view(w).getByRole("button", { name: "Back to artifact home" });
const badges = (w: Page): Locator => w.locator(".pin-badge");
const guestPath = (w: Page) => guestEval<string>(w, `location.pathname`);
const guestH1 = (w: Page) => guestEval<string>(w, `document.querySelector("h1")?.textContent ?? ""`);
const guestInput = (app: ElectronApplication, event: Record<string, unknown>) =>
  app.evaluate(({ webContents }, e) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && !c.isDestroyed() && !c.getURL().startsWith("devtools"));
    if (!guest) return false;
    guest.sendInputEvent(e as never);
    return true;
  }, event);
/**
 * A real pointer click on a link in the page, as a user would make it, once the document has finished loading.
 * (A scripted `.click()` right after parse is a navigation during load, which Chromium turns into a history REPLACE,
 * so it would hide exactly the history this feature navigates.)
 */
async function clickInGuest(s: Session, selector: string): Promise<void> {
  await expect.poll(() => guestEval<string>(s.window, `document.readyState`)).toBe("complete");
  const at = await guestEval<{ x: number; y: number }>(s.window, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await guestInput(s.app, { type: "mouseMove", x: at.x, y: at.y });
  await guestInput(s.app, { type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await guestInput(s.app, { type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const seed = (w: Page, rows: unknown[]) => w.evaluate((r) => (window as any).__feedbackProbe.store.seed(r), rows);

const BOARD_PIN = { tag: "h1", label: "h1 Design options", anchor: { route: BOARD, tag: "h1", selector: "#board-title", textAnchor: { tag: "h1", text: "Design options" } } };
const PAGE_A_PIN = { tag: "h1", label: "h1 Option A: dense", anchor: { route: PAGE_A, tag: "h1", selector: "#variant-title", textAnchor: { tag: "h1", text: "Option A: dense" } } };

/** Playwright's page screenshot does not composite the webview under Xvfb; the window's own capture does. */
async function windowShot(app: ElectronApplication, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 600)); // let the guest paint before the capture
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(png, "base64"));
  // The window capture may not composite the guest under Xvfb; the guest's own capture is the page as the user sees it.
  const guestPng = await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && !c.isDestroyed() && !c.getURL().startsWith("devtools"));
    return guest ? (await guest.capturePage()).toPNG().toString("base64") : "";
  });
  if (guestPng) fs.writeFileSync(path.join(SHOT_DIR, `${name}-page.png`), Buffer.from(guestPng, "base64"));
}

async function open(options: { size?: [number, number] } = {}): Promise<Session> {
  return session(VARIATIONS, { register: "v2", probe: false, size: options.size ?? [1280, 800] });
}

test.describe("artifact tab navigation (back / forward / home)", () => {
  test.setTimeout(180_000);

  test("the reported bug: click into an option, go back, and the board is shown again", async () => {
    const s = await open();
    const w = s.window;
    try {
      await expect(guestH1(w)).resolves.toBe("Design options");
      // nothing to go back to on a freshly opened board
      await expect(backBtn(w)).toBeDisabled();
      await expect(forwardBtn(w)).toBeDisabled();
      await expect(homeBtn(w)).toBeDisabled();

      await clickInGuest(s, "#opt-a");
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      await expect(guestH1(w)).resolves.toBe("Option A: dense");
      await expect(backBtn(w)).toBeEnabled();
      await expect(homeBtn(w)).toBeEnabled();
      await expect(forwardBtn(w)).toBeDisabled();

      await backBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      await expect(guestH1(w)).resolves.toBe("Design options"); // the board is shown again
      await expect(backBtn(w)).toBeDisabled();
      await expect(forwardBtn(w)).toBeEnabled();
      await expect(homeBtn(w)).toBeDisabled();

      await forwardBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      await expect(forwardBtn(w)).toBeDisabled();
    } finally { await s.cleanup(); }
  });

  test("home returns to the board from a sub-page, and Back from there returns to the sub-page", async () => {
    const s = await open();
    const w = s.window;
    try {
      await clickInGuest(s, "#opt-b");
      await expect.poll(() => guestPath(w)).toBe("/variations/B/index.html");
      await homeBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      await expect(homeBtn(w)).toBeDisabled();
      await expect(backBtn(w)).toBeEnabled();
      await backBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe("/variations/B/index.html");
    } finally { await s.cleanup(); }
  });

  test("controls are keyboard operable and labelled; Mod+[ and Mod+] work from the chrome and from inside the page", async () => {
    const s = await open();
    const w = s.window;
    try {
      for (const [button, label] of [[backBtn(w), "Back"], [forwardBtn(w), "Forward"], [homeBtn(w), "Back to artifact home"]] as const) {
        await expect(button).toHaveAttribute("aria-label", label);
        await expect(button).toHaveAttribute("title", new RegExp(label));
        expect(await button.evaluate((el) => el.tagName)).toBe("BUTTON");
      }
      await expect(backBtn(w)).toHaveAttribute("title", /\[/); // the shortcut is in the tooltip

      await clickInGuest(s, "#opt-a");
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      // Enter on the focused Back button
      await backBtn(w).focus();
      await w.keyboard.press("Enter");
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      // Mod+] from the chrome (Ctrl on Linux)
      await w.keyboard.press("Control+]");
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      await w.keyboard.press("Control+[");
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      // the same combos while focus is inside the guest page
      await w.locator(".artifact-view-frame").focus();
      await s.app.evaluate(({ webContents }) => {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && !c.isDestroyed() && !c.getURL().startsWith("devtools"))!;
        guest.sendInputEvent({ type: "keyDown", keyCode: "]", modifiers: ["control"] });
        guest.sendInputEvent({ type: "keyUp", keyCode: "]", modifiers: ["control"] });
      });
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      // with nowhere to go the shortcut is inert (and does not throw)
      await w.keyboard.press("Control+]");
      expect(await guestPath(w)).toBe(PAGE_A);
    } finally { await s.cleanup(); }
  });

  test("Mod+[ does not steal the editor's own outdent in a note", async () => {
    const s = await open();
    const w = s.window;
    try {
      // On the artifact tab the commands are offered; on a markdown tab they are not, so the hotkey is not consumed
      // and CodeMirror keeps Mod+[ (indent less) / Mod+] (indent more).
      await clickInGuest(s, "#opt-a");
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      const onArtifact = await w.evaluate(() => (window as any).app.commands.list().map((c: any) => c.id).filter((id: string) => id.startsWith("artifact.")));
      expect(onArtifact).toEqual(expect.arrayContaining(["artifact.back", "artifact.home"]));
      const onNote = await w.evaluate(async () => {
        const a = (window as any).app;
        await a.openFile(a.vault.getFileByPath("Welcome.md"), true);
        return { ids: a.commands.list().map((c: any) => c.id).filter((id: string) => id.startsWith("artifact.")), back: a.commands.executeCommandById("artifact.back"), forward: a.commands.executeCommandById("artifact.forward") };
      });
      expect(onNote.ids).not.toContain("artifact.back");
      expect(onNote.ids).not.toContain("artifact.forward");
      expect(onNote.back).toBe(false);
      expect(onNote.forward).toBe(false);
    } finally { await s.cleanup(); }
  });

  test("external navigation stays denied, and does not pollute the history", async () => {
    const s = await open();
    const w = s.window;
    try {
      await clickInGuest(s, "#ext");
      await guestEval(w, `location.href = "https://example.com/escape2"`);
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      expect(await guestEval<string>(w, `location.origin`)).toBe("geode-artifact://nav-variations");
      await expect(backBtn(w)).toBeDisabled();
      await expect(forwardBtn(w)).toBeDisabled();
    } finally { await s.cleanup(); }
  });

  test("reload keeps the page and its history; re-loading in place, closing and reopening, or switching artifact starts clean", async () => {
    const s = await open();
    const w = s.window;
    const expectClean = async () => {
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      await expect(backBtn(w)).toBeDisabled();
      await expect(forwardBtn(w)).toBeDisabled();
      await expect(homeBtn(w)).toBeDisabled();
    };
    const intoA = async () => { await clickInGuest(s, "#opt-a"); await expect.poll(() => guestPath(w)).toBe(PAGE_A); await expect(backBtn(w)).toBeEnabled(); };
    try {
      await intoA();
      // reload: same page, history intact
      await view(w).getByRole("button", { name: "Reload artifact" }).click();
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      await expect(backBtn(w)).toBeEnabled();
      await expect(homeBtn(w)).toBeEnabled();

      // the view loads the same artifact again in place (what a dev-server restart does): a new guest, a clean history
      await w.evaluate(() => { const v = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view; return v.setState(v.getState()); });
      await expectClean();

      // a different artifact in the same tab: its own entry page, nothing carried over from the previous guest
      await intoA();
      const other = `${s.root}-other`;
      fs.cpSync(s.root, other, { recursive: true });
      fs.writeFileSync(path.join(other, "artifact.json"), fs.readFileSync(path.join(other, "artifact.json"), "utf8").replace("nav-variations", "nav-variations-other"));
      await w.evaluate((root) => { const v = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view; return v.setState({ ...v.getState(), root }); }, other);
      await expectClean();
      expect(await guestEval<string>(w, `location.origin`)).toBe("geode-artifact://nav-variations-other");

      // close the tab and preview again: a new view, a clean history
      await w.evaluate(() => (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].detach());
      await expect(view(w)).toHaveCount(0);
      await w.evaluate((r) => (window as any).app.openArtifact(r), s.root);
      await expect(view(w)).toBeVisible();
      await expectClean();
    } finally { await s.cleanup(); }
  });

  test("pins belong to their page: not shown on another page after back, forward or home", async () => {
    const s = await open();
    const w = s.window;
    try {
      await seed(w, [BOARD_PIN, PAGE_A_PIN]);
      // the board shows only the board's pin
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect(badges(w).first()).toHaveAttribute("aria-label", /Design options/);

      await clickInGuest(s, "#opt-a");
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect(badges(w).first()).toHaveAttribute("aria-label", /Option A: dense/);

      await backBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect(badges(w).first()).toHaveAttribute("aria-label", /Design options/);

      await clickInGuest(s, "#opt-b"); // a page that carries neither pin
      await expect.poll(() => guestPath(w)).toBe("/variations/B/index.html");
      await expect(badges(w)).toHaveCount(0, { timeout: 20_000 });
      await homeBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect(badges(w).first()).toHaveAttribute("aria-label", /Design options/);
    } finally { await s.cleanup(); }
  });

  test("screenshots: desktop and mobile, board and a sub-page with the controls enabled", async () => {
    const s = await open({ size: [1280, 800] });
    const w = s.window;
    try {
      await expect(guestH1(w)).resolves.toBe("Design options");
      await windowShot(s.app, "desktop-board");
      await clickInGuest(s, "#opt-a");
      await expect.poll(() => guestPath(w)).toBe(PAGE_A);
      await expect(backBtn(w)).toBeEnabled();
      await windowShot(s.app, "desktop-subpage");

      const bw = await s.app.browserWindow(w);
      await bw.evaluate((win: any) => { win.setMinimumSize(320, 400); win.setSize(390, 844); });
      await expect.poll(() => w.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(400);
      // every control must still be reachable at phone width: the toolbar wraps rather than clipping
      for (const button of [backBtn(w), forwardBtn(w), homeBtn(w)]) await expect(button).toBeInViewport();
      await windowShot(s.app, "mobile-subpage");
      await backBtn(w).click();
      await expect.poll(() => guestPath(w)).toBe(BOARD);
      await windowShot(s.app, "mobile-board");
    } finally { await s.cleanup(); }
  });
});
