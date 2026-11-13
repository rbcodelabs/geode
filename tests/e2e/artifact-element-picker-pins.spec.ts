import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { BASIC_ARTIFACT } from "./helpers/artifact-picker-fixtures";
import { guestEval, session, type Session } from "./helpers/anchor-e2e";

/**
 * Phase 2b-i G3 (ADR 0006 Addendum 1 A.5): Pin from the popover, the pin layer, the rail and their keyboard model, in the
 * real Electron app with the probe plugin's fake v2 provider. Linux/Xvfb at DPR 1 only: nothing here verifies DPR 2,
 * ProMotion or non-default zoom (spike S2 owns that).
 */

const SHOT_DIR = process.env.G3_SHOT_DIR ?? path.resolve(__dirname, "..", "..", "test-results", "g3-shots");
const BUY_CENTER = { x: 180, y: 224 };

const guestInput = (app: ElectronApplication, event: Record<string, unknown>) =>
  app.evaluate(({ webContents }, e) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed() && !w.getURL().startsWith("devtools"));
    if (!guest) return false;
    guest.sendInputEvent(e as never);
    return true;
  }, event);
async function clickAt(app: ElectronApplication, x: number, y: number): Promise<void> {
  await guestInput(app, { type: "mouseMove", x, y });
  await guestInput(app, { type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await guestInput(app, { type: "mouseUp", x, y, button: "left", clickCount: 1 });
}
async function guestKey(app: ElectronApplication, keyCode: string): Promise<void> {
  await guestInput(app, { type: "keyDown", keyCode });
  await guestInput(app, { type: "keyUp", keyCode });
}
/** Playwright's page screenshot does not composite the webview under Xvfb; the window's own capture does. */
async function windowShot(s: Session, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const png = await s.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(png, "base64"));
}

const pickToggle = (w: Page): Locator => w.locator(".artifact-view-pick-btn");
const commentsToggle = (w: Page): Locator => w.locator(".artifact-view-comments-btn");
const popover = (w: Page): Locator => w.locator(".pick-popover");
const badges = (w: Page): Locator => w.locator(".pin-badge");
const rail = (w: Page): Locator => w.locator(".comments-rail");
const store = <T>(w: Page, fn: (store: any) => T): Promise<T> => w.evaluate(`(${fn.toString()})(window.__feedbackProbe.store)`) as Promise<T>;

const SEED_BUY = { tag: "button", label: "button Buy now", anchor: { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } } };
const SEED_PRICE = { tag: "p", label: "p $29 per month", status: "sent", anchor: { tag: "p", selector: ".price", textAnchor: { tag: "p", text: "$29 per month" } } };
const SEED_HEADING = { tag: "h2", label: "h2 Plans", anchor: { tag: "h2", selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" } } };
const seed = (w: Page, rows: unknown[]) => w.evaluate((r) => (window as any).__feedbackProbe.store.seed(r), rows);

/** Where a badge centre should be for a selector, from the TRUE DOM rect (guest) and the real webview/stage rects. */
async function expectedCentre(w: Page, selector: string): Promise<{ x: number; y: number }> {
  const r = await guestEval<{ right: number; top: number }>(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { right: r.right, top: r.top }; })()`);
  const frame = await w.evaluate(() => {
    const f = document.querySelector<HTMLElement>(".artifact-view-frame")!;
    const st = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
    const b = f.getBoundingClientRect();
    return { left: b.left + f.clientLeft - st.left, top: b.top + f.clientTop - st.top, width: st.width, height: st.height };
  });
  const clamp = (v: number, max: number) => Math.min(Math.max(12, v), Math.max(12, max - 12));
  return { x: clamp(frame.left + r.right - 4, frame.width), y: clamp(frame.top + r.top + 4, frame.height) };
}
const badgeCentre = (w: Page, text: string) => w.evaluate((t) => {
  const stage = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
  const el = [...document.querySelectorAll<HTMLElement>(".pin-badge")].find((b) => b.firstChild?.nodeValue?.replace("~", "") === t);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - stage.left, y: r.top + r.height / 2 - stage.top };
}, text);
const near = (a: { x: number; y: number } | null, b: { x: number; y: number }, tol = 1.5) => a !== null && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

test.describe("pinned comments (phase 2b-i G3)", () => {
  test.setTimeout(180_000);

  test("a11y: keyboard pin, navigate pins, rail, send, focus restoration", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await expect(commentsToggle(w)).toBeVisible();
      // Pin 1 by keyboard: pick toggle -> page -> walk to <header> -> type -> Ctrl+Shift+Enter
      await pickToggle(w).focus();
      await w.keyboard.press("Enter");
      await guestKey(s.app, "]");
      await guestKey(s.app, "Enter");
      await expect(popover(w)).toBeVisible();
      await expect(popover(w).getByRole("button", { name: "Pin" })).toBeVisible();
      await w.keyboard.type("Tighten the header.");
      await w.keyboard.press("Control+Shift+Enter");
      await expect(w.locator(".pick-popover-status")).toHaveText("Pinned as comment 1.");
      expect(await store(w, (st) => st.comments.length)).toBe(1);
      expect(await w.evaluate(() => (window as any).__feedbackProbe.requests.length)).toBe(0); // Pin never sends
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect(popover(w).getByRole("button", { name: "Done" })).toBeFocused();
      await w.keyboard.press("Enter");
      await expect(popover(w)).toBeHidden();
      await expect(badges(w).first()).toBeFocused(); // focus returns to the new badge
      await expect(badges(w).first()).toHaveAttribute("aria-label", /^Comment 1, open, on header/);

      // Pin 2 on #buy (pointer to reach it), finished by keyboard
      await pickToggle(w).click();
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(w)).toBeVisible();
      await w.keyboard.type("Make Buy larger.");
      await popover(w).getByRole("button", { name: "Pin" }).focus();
      await w.keyboard.press("Enter");
      await expect(w.locator(".pick-popover-status")).toHaveText("Pinned as comment 2.");
      await expect(badges(w)).toHaveCount(2, { timeout: 20_000 });
      await popover(w).getByRole("button", { name: "Done" }).focus();
      await w.keyboard.press("Enter");
      await expect(badges(w).filter({ hasText: "2" })).toBeFocused();

      // navigate the pin layer with the arrow keys (roving tabindex, reading order: header first, then #buy)
      await w.keyboard.press("ArrowLeft");
      await expect(badges(w).filter({ hasText: "1" })).toBeFocused();
      await w.keyboard.press("End");
      await expect(badges(w).filter({ hasText: "2" })).toBeFocused();
      expect(await badges(w).evaluateAll((els) => els.map((e) => (e as HTMLElement).tabIndex))).toEqual([-1, 0]);

      // Enter opens the rail on that row; the page is asked to scroll to it, focus stays in the rail
      await w.keyboard.press("Enter");
      await expect(rail(w)).toBeVisible();
      await expect(commentsToggle(w)).toHaveAttribute("aria-expanded", "true");
      await expect(w.locator('.comments-rail-row[data-status="open"]').nth(1)).toBeFocused();
      await expect(rail(w).locator("h2")).toHaveText("Comments (2)");

      // Send both (defaults to every open comment) from the rail by keyboard
      await rail(w).locator(".comments-rail-send").focus();
      await expect(rail(w).locator(".comments-rail-send")).toHaveText("Send 2");
      await w.keyboard.press("Enter");
      await expect(rail(w).locator(".comments-rail-results")).toHaveText("2 sent");
      const calls = await store(w, (st) => st.sendCalls);
      expect(calls).toHaveLength(1);
      expect(calls[0].ids).toHaveLength(2);
      expect(calls[0].resend).toBe(false);
      expect(calls[0].requestId).toMatch(/^req_[0-9a-f]{32}$/);
      expect(Object.keys(calls[0].anchorStates)).toHaveLength(2);
      await expect(rail(w).locator('.comments-rail-row[data-status="sent"]')).toHaveCount(2);

      // Esc closes the rail and focus returns to the Comments toggle
      await rail(w).locator(".comments-rail-row").first().focus();
      await w.keyboard.press("Escape");
      await expect(rail(w)).toBeHidden();
      await expect(commentsToggle(w)).toBeFocused();

      // the palette command reaches the same toggle
      await w.evaluate(() => (window as any).app.commands.executeCommandById("artifact.toggle-comments"));
      await expect(rail(w)).toBeVisible();
      await expect(rail(w).locator("h2")).toBeFocused();
    } finally { await s.cleanup(); }
  });

  test("pin positions follow the real element rects at the desktop and narrow presets (screenshots, DPR 1)", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false, size: [1280, 800] });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY, SEED_PRICE, SEED_HEADING]);
      await expect(badges(w)).toHaveCount(3, { timeout: 20_000 });
      const check = async () => {
        await expect.poll(async () => near(await badgeCentre(w, "1"), await expectedCentre(w, "#buy")), { timeout: 15_000 }).toBe(true);
        await expect.poll(async () => near(await badgeCentre(w, "2"), await expectedCentre(w, ".price")), { timeout: 15_000 }).toBe(true);
        await expect.poll(async () => near(await badgeCentre(w, "3"), await expectedCentre(w, "#plans-h")), { timeout: 15_000 }).toBe(true);
      };
      await check();
      // the sent pin is drawn with a check, the open ones solid
      await expect(badges(w).filter({ hasText: "2" }).locator(".pin-badge-check")).toHaveCount(1);
      await windowShot(s, "pins-desktop");
      await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      await expect(rail(w)).not.toHaveClass(/is-sheet/); // docked at this width
      await check(); // the stage shrank; badges follow
      await windowShot(s, "rail-desktop");
      await commentsToggle(w).click();

      // narrow preset: a 640 px window; the rail becomes a sheet
      const bw = await s.app.browserWindow(w);
      await bw.evaluate((win: any) => win.setSize(640, 800));
      // with the right sidebar open the pane is well under the 560 px breakpoint
      await w.evaluate(() => { const side = (window as any).app.workspace.rightSidebar; if (side.collapsed) side.toggle(); });
      await expect.poll(() => w.locator(".artifact-view").evaluate((e) => e.clientWidth), { timeout: 15_000 }).toBeLessThan(540);
      // the sidebar animates open: measure only once the pane width has been identical for 600 ms
      let last = -1; let since = Date.now();
      await expect.poll(async () => {
        const width = await w.locator(".artifact-view").evaluate((e) => e.getBoundingClientRect().width);
        if (width !== last) { last = width; since = Date.now(); }
        return Date.now() - since >= 600;
      }, { timeout: 15_000, intervals: [100] }).toBe(true);
      await check();
      await windowShot(s, "pins-narrow");
      await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      await expect(rail(w)).toHaveClass(/is-sheet/);
      const box = await rail(w).boundingBox();
      const pane = await w.locator(".artifact-view").boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
      await windowShot(s, "rail-narrow");
    } finally { await s.cleanup(); }
  });

  test("overlapping pins collapse into a count badge that opens the rail filtered to those comments", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY, SEED_BUY, SEED_BUY, SEED_PRICE]);
      await expect(badges(w)).toHaveCount(2, { timeout: 20_000 });
      const cluster = w.locator(".pin-badge.is-cluster");
      await expect(cluster).toHaveText("3");
      await expect(cluster).toHaveAttribute("aria-label", "3 comments here. Activate to list");
      await expect(w.locator(".pin-badge.is-pin")).toHaveText(/4/);
      await windowShot(s, "cluster-desktop");
      await cluster.focus();
      await w.keyboard.press("Enter");
      await expect(rail(w)).toBeVisible();
      await expect(rail(w).locator(".comments-rail-cluster-chip")).toContainText("3 comments at this spot");
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(3);
      await windowShot(s, "cluster-rail-desktop");
      await w.keyboard.press("Escape"); // focus is in the rail: Esc clears the chip first
      await expect(rail(w).locator(".comments-rail-cluster-chip")).toBeHidden();
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(4);
      await expect(rail(w)).toBeVisible();
    } finally { await s.cleanup(); }
  });

  test("an agent edit re-anchors: pins follow a moved element, detach when it is removed, and no status changes by itself", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY, SEED_PRICE]);
      await expect(badges(w)).toHaveCount(2, { timeout: 20_000 });
      const before = await badgeCentre(w, "1");
      // the agent moves #buy 200 px to the right
      const css = fs.readFileSync(path.join(s.root, "style.css"), "utf8").replace("#buy{position:absolute;left:100px", "#buy{position:absolute;left:300px");
      fs.writeFileSync(path.join(s.root, "style.css"), css);
      await expect.poll(async () => (await badgeCentre(w, "1"))?.x ?? 0, { timeout: 30_000 }).toBeGreaterThan(before!.x + 150);
      expect(near(await badgeCentre(w, "1"), await expectedCentre(w, "#buy"))).toBe(true);
      // then removes it
      const html = fs.readFileSync(path.join(s.root, "index.html"), "utf8").replace(/<button id="buy"[^>]*>Buy now<\/button>/, "");
      fs.writeFileSync(path.join(s.root, "index.html"), html);
      await expect(badges(w)).toHaveCount(1, { timeout: 30_000 });
      await commentsToggle(w).click();
      const row = rail(w).locator('.comments-rail-row[data-id]').first();
      await expect(row).toHaveClass(/is-greyed/);
      await expect(row).toContainText("Detached: the element was not found");
      expect(await store(w, (st) => st.comments.map((c: any) => c.status))).toEqual(["open", "sent"]);
      expect(await store(w, (st) => st.updateCalls.length)).toBe(0);
    } finally { await s.cleanup(); }
  });

  test("hostile page (T1, T9): forged anchor traffic changes no badge, and the page cannot fetch the comments file", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [{ ...SEED_BUY, text: "SECRET COMMENT TEXT" }]);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect.poll(async () => near(await badgeCentre(w, "1"), await expectedCentre(w, "#buy")), { timeout: 15_000 }).toBe(true);
      const before = await badgeCentre(w, "1");
      // the page forges every message it can reach, with the real channel names and plausible keys and epochs
      await guestEval(w, `(() => {
        const forged = { epoch: 1, results: [{ key: "a0", match: "selector", agrees: true, rect: { x: 900, y: 500, width: 5, height: 5 }, visible: true }], rects: [{ key: "a0", rect: { x: 900, y: 500, width: 5, height: 5 }, visible: true }] };
        for (const name of ["anchor-results", "anchor-rects"]) {
          const channel = "geode-artifact:inspect:v1:" + name;
          window.postMessage({ channel, args: [forged] }, "*");
          window.dispatchEvent(new MessageEvent("message", { data: { channel, args: [forged] } }));
          window.dispatchEvent(new CustomEvent(channel, { detail: forged }));
        }
        return true;
      })()`);
      await w.waitForTimeout(1500);
      expect(await badges(w).count()).toBe(1);
      expect(near(await badgeCentre(w, "1"), before!, 0.5)).toBe(true);
      // the comments file is never served to the page, and the comment text is never in the page
      const status = await guestEval<number>(w, `fetch("/.threads-design/comments.json").then((r) => r.status).catch(() => -1)`);
      expect([404, 403, -1]).toContain(status);
      expect(await guestEval<boolean>(w, `document.documentElement.outerHTML.includes("SECRET COMMENT TEXT")`)).toBe(false);
    } finally { await s.cleanup(); }
  });

  test("a v1 handler hides Pin and the rail; a v2 provider that is unavailable hides Pin and shows the notice", async () => {
    const v1 = await session(BASIC_ARTIFACT);
    try {
      await expect(commentsToggle(v1.window)).toBeHidden();
      await pickToggle(v1.window).click();
      await clickAt(v1.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(v1.window)).toBeVisible();
      await expect(popover(v1.window).getByRole("button", { name: "Send" })).toBeVisible();
      await expect(popover(v1.window).getByRole("button", { name: "Pin" })).toBeHidden();
    } finally { await v1.cleanup(); }

    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await store(w, (st) => { st.health = "unavailable"; st.notice = "The comments file cannot be used."; st.emit("external", "all"); });
      await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      await expect(rail(w).locator(".comments-rail-notice")).toHaveText("The comments file cannot be used.");
      await rail(w).locator(".comments-rail-close").click();
      await expect(commentsToggle(w)).toBeFocused();
      await pickToggle(w).click();
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(w)).toBeVisible();
      await expect(popover(w).getByRole("button", { name: "Pin" })).toBeHidden();
      await expect(popover(w).getByRole("button", { name: "Send" })).toBeVisible(); // Pick + Send still work
    } finally { await s.cleanup(); }
  });

  test("foreign comments are read first and adopted; a change while the rail is open appears without a reload", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [{ ...SEED_BUY, provenance: "foreign", text: "<img src=x onerror=window.__pwned=1>" }]);
      await commentsToggle(w).click();
      await expect(rail(w).locator(".comments-rail-foreign")).toBeVisible();
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(1);
      await expect(rail(w).locator(".comments-rail-select")).toHaveCount(0); // foreign cannot be sent
      await expect(rail(w).locator(".comments-rail-text")).toHaveText("<img src=x onerror=window.__pwned=1>"); // text, not markup
      expect(await w.evaluate(() => (window as any).__pwned)).toBeUndefined();
      expect(await rail(w).locator("img").count()).toBe(0);
      await rail(w).locator(".comments-rail-adopt-all").click();
      await rail(w).locator(".comments-rail-adopt-yes").click(); // asks first
      await expect(rail(w).locator(".comments-rail-foreign")).toBeHidden();
      await expect(rail(w).locator(".comments-rail-select")).toHaveCount(1);
      // an external change (the agent edited the file) while subscribed
      await seed(w, [SEED_HEADING]);
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(2);
      await store(w, (st) => { st.health = "recovered"; st.notice = "Comments were recovered from a backup."; st.emit("recovered", "all"); });
      await expect(rail(w).locator(".comments-rail-notice")).toHaveText("Comments were recovered from a backup.");
    } finally { await s.cleanup(); }
  });
});
