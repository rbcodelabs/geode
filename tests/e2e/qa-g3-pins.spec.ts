import * as fs from "node:fs";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { BASIC_ARTIFACT, makeEnv, writeStaticArtifact } from "./helpers/artifact-picker-fixtures";
import { guestEval, repoRoot, session, type Session } from "./helpers/anchor-e2e";

/**
 * QA G3 (independent): things the engineer's pins spec does not exercise, in the real Electron app with the probe
 * plugin's fake v2 provider. Linux/Xvfb at DPR 1 only. Tests named BUG: are `test.fail()`: they assert the CORRECT
 * behaviour and are expected to fail until src is fixed. Tests named CHAR: record an observed number, never assert it.
 */

const SHOT_DIR = process.env.G3_SHOT_DIR ?? path.resolve(__dirname, "..", "..", "test-results", "qa-g3-shots");
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
const seed = (w: Page, rows: unknown[]) => w.evaluate((r) => (window as any).__feedbackProbe.store.seed(r), rows);
const SEED_BUY = { tag: "button", label: "button Buy now", anchor: { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } } };
const SEED_PRICE = { tag: "p", label: "p $29 per month", status: "sent", anchor: { tag: "p", selector: ".price", textAnchor: { tag: "p", text: "$29 per month" } } };
const SEED_HEADING = { tag: "h2", label: "h2 Plans", anchor: { tag: "h2", selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" } } };

const focusPaneOn = (w: Page): Promise<boolean> => w.evaluate(() => (window as any).app.workspace.focusedGroup !== null);
const resetFocusPane = (w: Page) => w.evaluate(() => (window as any).app.workspace.exitFocusPane());

const badgeCentre = (w: Page, text: string) => w.evaluate((t) => {
  const stage = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
  const el = [...document.querySelectorAll<HTMLElement>(".pin-badge")].find((b) => b.firstChild?.nodeValue?.replace("~", "") === t);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - stage.left, y: r.top + r.height / 2 - stage.top };
}, text);
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
const distance = (a: { x: number; y: number } | null, b: { x: number; y: number }) => (a === null ? Infinity : Math.hypot(a.x - b.x, a.y - b.y));

/** A narrow window with the right sidebar open so the pane is well under the artifact's 900 px frame: the stage scrolls. */
async function narrow(s: Session): Promise<void> {
  const bw = await s.app.browserWindow(s.window);
  await bw.evaluate((win: any) => win.setSize(640, 800));
  await s.window.evaluate(() => { const side = (window as any).app.workspace.rightSidebar; if (side.collapsed) side.toggle(); });
  await expect.poll(() => s.window.locator(".artifact-view").evaluate((e) => e.clientWidth), { timeout: 15_000 }).toBeLessThan(540);
}
/** A short window with the desktop device preset: the frame is taller than the stage, so the STAGE (overflow:auto) scrolls vertically. */
async function narrowScrollable(s: Session): Promise<void> {
  const bw = await s.app.browserWindow(s.window);
  await bw.evaluate((win: any) => win.setSize(1280, 520));
  await s.window.locator('[data-viewport="desktop"]').click();
  await expect.poll(() => s.window.locator(".artifact-view-stage").evaluate((e) => e.scrollHeight - e.clientHeight), { timeout: 10_000 }).toBeGreaterThan(50);
}

/** QA_NOFAIL=1 runs the BUG tests as ordinary tests so the real failure message can be read. */
const knownBug = (): void => { if (!process.env.QA_NOFAIL) test.fail(); };

test.describe("QA G3 pins and rail (independent)", () => {
  test.setTimeout(180_000);

  // ---- (4) the Mod+Shift+Enter collision, in the real app -------------------------------------------------------
  test("global 'Toggle focus on active pane' still works outside the popover (control)", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await commentsToggle(w).focus();
      await w.keyboard.press("Control+Shift+Enter");
      await expect.poll(() => focusPaneOn(w)).toBe(true);
      await w.keyboard.press("Control+Shift+Enter");
      await expect.poll(() => focusPaneOn(w)).toBe(false);
    } finally { await s.cleanup(); }
  });

  test("inside the Pin popover the combo pins (and does not toggle focus pane); a page keystroke with the same combo pins nothing", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await pickToggle(w).click();
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(w)).toBeVisible();
      // a page keystroke: Ctrl+Shift+Enter delivered to the guest webContents while the popover is open
      await guestInput(s.app, { type: "keyDown", keyCode: "Return", modifiers: ["control", "shift"] });
      await guestInput(s.app, { type: "keyUp", keyCode: "Return", modifiers: ["control", "shift"] });
      await w.waitForTimeout(500);
      expect(await store(w, (st) => st.comments.length)).toBe(0);
      // the app's own hotkey still reaches the guest-focused window (global command): record, then reset
      console.log("QA-ANN guest-keystroke-toggles-focus-pane", await focusPaneOn(w));
      await resetFocusPane(w);
      await w.locator(".pick-popover-comment").focus();
      await w.keyboard.type("Bigger");
      await w.keyboard.press("Control+Shift+Enter");
      await expect(w.locator(".pick-popover-status")).toHaveText("Pinned as comment 1.");
      expect(await focusPaneOn(w)).toBe(false);
      expect(await store(w, (st) => st.comments.length)).toBe(1);
    } finally { await s.cleanup(); }
  });

  // BUG (static review #6): a v1 handler's popover has no Pin, yet the combo is still swallowed in it.
  test("BUG: in a v1 popover Control+Shift+Enter still toggles focus pane (the window listener swallows it)", async () => {
    knownBug();
    const s = await session(BASIC_ARTIFACT); // v1 handler
    const w = s.window;
    try {
      await pickToggle(w).click();
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(w)).toBeVisible();
      await expect(popover(w).getByRole("button", { name: "Pin" })).toBeHidden();
      await w.locator(".pick-popover-comment").focus();
      await w.keyboard.press("Control+Shift+Enter");
      await expect.poll(() => focusPaneOn(w), { timeout: 3_000 }).toBe(true);
      await resetFocusPane(w);
    } finally { await s.cleanup(); }
  });

  // ---- (3)(4) overlay mapping: stage scroll, edge clipping ------------------------------------------------------
  test("CHAR: after the STAGE (not the page) scrolls horizontally, how long do badges stay at the old place (vertical stage scroll, desktop preset in a short window); and the final position", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await narrowScrollable(s);
      await seed(w, [SEED_BUY, SEED_HEADING]);
      await expect(badges(w)).toHaveCount(2, { timeout: 20_000 });
      await expect.poll(async () => distance(await badgeCentre(w, "1"), await expectedCentre(w, "#buy")), { timeout: 15_000 }).toBeLessThan(2);
      const scrollable = await w.locator(".artifact-view-stage").evaluate((e) => e.scrollHeight - e.clientHeight);
      console.log("QA-ANN stage-scrollable-px", scrollable);
      expect(scrollable).toBeGreaterThan(50);
      await w.locator(".artifact-view-stage").evaluate((e) => { e.scrollTop = 100; });
      const samples: Array<{ ms: number; err: number }> = [];
      const t0 = Date.now();
      for (let i = 0; i < 40; i++) {
        samples.push({ ms: Date.now() - t0, err: distance(await badgeCentre(w, "1"), await expectedCentre(w, "#buy")) });
        if (samples.at(-1)!.err < 1.5) break;
        await w.waitForTimeout(50);
      }
      console.log("QA-ANN stage-scroll-lag", JSON.stringify({ first: samples[0], last: samples.at(-1), n: samples.length }));
      await windowShot(s, "stage-scrolled");
      // eventually consistent
      await expect.poll(async () => distance(await badgeCentre(w, "1"), await expectedCentre(w, "#buy")), { timeout: 5_000 }).toBeLessThan(2);
    } finally { await s.cleanup(); }
  });

  // BUG (static review #4): there is no scroll listener on the stage, so a stage scroll leaves badges stranded until the next guest report.
  test("BUG: a stage scroll moves the badges with the element within two frames (no scroll listener on the stage)", async () => {
    knownBug();
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await narrowScrollable(s);
      await seed(w, [SEED_BUY]);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect.poll(async () => distance(await badgeCentre(w, "1"), await expectedCentre(w, "#buy")), { timeout: 15_000 }).toBeLessThan(2);
      await w.locator(".artifact-view-stage").evaluate((e) => { e.scrollTop = 100; });
      await w.waitForTimeout(120); // about 7 frames at 60 Hz
      expect(distance(await badgeCentre(w, "1"), await expectedCentre(w, "#buy"))).toBeLessThan(2);
    } finally { await s.cleanup(); }
  });

  test("CHAR: a sent pin's check mark at the stage's bottom-right corner: how far it protrudes past the stage", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [{ ...SEED_PRICE, anchor: { tag: "p", selector: "#vault-note", textAnchor: { tag: "p", text: "Secret title: Quarterly layoffs" } } }]);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      // shrink the stage so the element's top-right is outside it: the badge clamps into the corner
      const bw = await s.app.browserWindow(w);
      await bw.evaluate((win: any) => win.setSize(300, 300));
      await expect.poll(async () => await badges(w).count(), { timeout: 10_000 }).toBeLessThanOrEqual(1);
      const m = await w.evaluate(() => {
        const st = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
        const check = document.querySelector<HTMLElement>(".pin-badge-check");
        const badge = document.querySelector<HTMLElement>(".pin-badge");
        if (!check || !badge) return null;
        const c = check.getBoundingClientRect();
        const b = badge.getBoundingClientRect();
        const pe = getComputedStyle(check).pointerEvents;
        return { overRight: c.right - st.right, overBottom: c.bottom - st.bottom, badgeOverRight: b.right - st.right, badgeOverBottom: b.bottom - st.bottom, pointerEvents: pe };
      });
      console.log("QA-ANN check-protrusion", JSON.stringify(m));
    } finally { await s.cleanup(); }
  });

  // ---- (4) focus: reorder drops keyboard focus -------------------------------------------------------------------
  test("BUG: a focused badge keeps focus when a rect update reorders the pin layer (insertBefore blurs it in Chromium)", async () => {
    knownBug();
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      // reading order (y, then x): #plans-h (y~84), .price (y~100), #buy (y~200)
      await seed(w, [SEED_BUY, { ...SEED_PRICE, status: "open" }, SEED_HEADING]);
      await expect(badges(w)).toHaveCount(3, { timeout: 20_000 });
      const orderBefore = await badges(w).evaluateAll((els) => els.map((e) => e.textContent));
      const moving = badges(w).filter({ hasText: /^1$/ }); // #buy's pin: last in reading order now, first after the edit
      await moving.focus();
      await expect(moving).toBeFocused();
      const focusedText = await moving.textContent();
      // the agent moves #buy to the top: its pin jumps from last to first, reordering the DOM (the focused node is moved)
      const css = fs.readFileSync(path.join(s.root, "style.css"), "utf8").replace("#buy{position:absolute;left:100px;top:200px", "#buy{position:absolute;left:100px;top:10px");
      fs.writeFileSync(path.join(s.root, "style.css"), css);
      await expect.poll(async () => (await badges(w).evaluateAll((els) => els.map((e) => e.textContent))).join(","), { timeout: 30_000 }).not.toBe(orderBefore.join(","));
      const activeIsBadge = await w.evaluate(() => document.activeElement?.classList.contains("pin-badge") === true);
      const activeText = await w.evaluate(() => document.activeElement?.textContent ?? null);
      expect({ activeIsBadge, activeText }).toEqual({ activeIsBadge: true, activeText: focusedText });
    } finally { await s.cleanup(); }
  });

  // ---- (4)(8) closing the rail while focus is inside it ---------------------------------------------------------
  test("BUG: closing the rail with the palette command while focus is inside it leaves focus on the Comments toggle, not body", async () => {
    knownBug();
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY]);
      await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      await rail(w).locator(".comments-rail-row").first().focus();
      await w.evaluate(() => (window as any).app.commands.executeCommandById("artifact.toggle-comments"));
      await expect(rail(w)).toBeHidden();
      await expect(commentsToggle(w)).toBeFocused();
    } finally { await s.cleanup(); }
  });

  // ---- (5)(7) registry change rebuilds the coordinator -----------------------------------------------------------
  test("BUG: a registry change keeps the rail open with its filter and the Retry for a timed-out send (same requestId)", async () => {
    knownBug();
    test.setTimeout(240_000);
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY, SEED_HEADING]);
      await commentsToggle(w).click();
      await rail(w).getByRole("button", { name: /^Open/ }).click();
      await expect(rail(w).locator('[aria-pressed="true"]')).toHaveText(/^Open/);
      // the provider never answers the first sendBatch (the view's 15 s timeout fires), then behaves (fixture: sendMode "hang-once")
      await store(w, (st) => { st.sendMode = "hang-once"; });
      await rail(w).locator(".comments-rail-send").click();
      await expect(rail(w).locator(".comments-rail-retry")).toBeVisible({ timeout: 40_000 });
      // any registry change (another plugin loads or unloads) notifies the view
      await w.evaluate(() => (window as any).app.artifactFeedbackService.notify());
      await w.waitForTimeout(500);
      const railOpen = await rail(w).isVisible();
      console.log("QA-ANN rail-open-after-registry-change", railOpen);
      if (!railOpen) await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      const pressed = await rail(w).locator('[aria-pressed="true"]').textContent();
      const retryVisible = await rail(w).locator(".comments-rail-retry").isVisible();
      console.log("QA-ANN after-registry-change", JSON.stringify({ railOpen, filter: pressed, retryVisible }));
      expect.soft(railOpen, "the rail stays open").toBe(true);
      expect.soft(pressed, "the Open filter stays").toMatch(/^Open/);
      expect.soft(retryVisible, "Retry (same requestId) for the timed-out send stays").toBe(true);
      // whatever the UI offers, a user clicking Send again after the timeout must not mint a second id for the same click
      await rail(w).locator(retryVisible ? ".comments-rail-retry" : ".comments-rail-send").click();
      await expect.poll(() => store(w, (st) => st.sendCalls.length)).toBe(2);
      const ids = (await store(w, (st) => st.sendCalls.map((c: any) => c.requestId))) as string[];
      console.log("QA-ANN request-ids", JSON.stringify(ids));
      expect.soft(ids[1], "the retry after a timeout reuses the id").toBe(ids[0]);
    } finally { await s.cleanup(); }
  });

  // ---- (6) leaks ------------------------------------------------------------------------------------------------
  test("closing the artifact tab leaves no provider subscription, no popover node, no window listener, and no further list calls", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await commentsToggle(w).click();
      await pickToggle(w).click();
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(w)).toBeVisible();
      expect(await store(w, (st) => st.listeners.size)).toBe(1);
      await w.evaluate(() => {
        const live = new Map<string, number>();
        const key = (t: string, l: unknown, c: unknown) => `${t}|${(l as any)?.name ?? "anon"}|${typeof c === "object" ? JSON.stringify(c) : String(c)}`;
        const ids = new WeakMap<object, number>();
        let n = 0;
        const idOf = (l: unknown) => { if (typeof l !== "function" && typeof l !== "object") return -1; if (!ids.has(l as object)) ids.set(l as object, ++n); return ids.get(l as object)!; };
        const add = window.addEventListener.bind(window);
        const rem = window.removeEventListener.bind(window);
        window.addEventListener = ((t: string, l: any, c: any) => { const k = `${key(t, l, c)}#${idOf(l)}`; live.set(k, (live.get(k) ?? 0) + 1); return add(t, l, c); }) as never;
        window.removeEventListener = ((t: string, l: any, c: any) => { const k = `${key(t, l, c)}#${idOf(l)}`; if (live.has(k)) { const v = live.get(k)! - 1; if (v <= 0) live.delete(k); else live.set(k, v); } return rem(t, l, c); }) as never;
        (window as any).__qaLive = live;
      });
      // close, reopen, close: anything the view registered with the patched window API and did not remove stays in the map
      await w.evaluate(() => (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].detach());
      await expect.poll(() => w.locator(".artifact-view").count()).toBe(0);
      expect(await w.locator(".pick-popover").count()).toBe(0);
      expect(await store(w, (st) => st.listeners.size)).toBe(0);
      const leftover = await w.evaluate(() => [...(window as any).__qaLive.keys()] as string[]);
      expect(leftover.filter((k) => /^(focus|resize|keydown)\|/.test(k))).toEqual([]);
      const calls = await store(w, (st) => st.listCalls);
      await w.waitForTimeout(1500);
      await w.evaluate(() => window.dispatchEvent(new Event("focus")));
      await w.waitForTimeout(300);
      expect(await store(w, (st) => st.listCalls)).toBe(calls); // a closed view does not list on window focus
    } finally { await s.cleanup(); }
  });

  test("window focus re-lists (change made while the window was in the background appears), and a failing list shows a notice and hides Pin without errors", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    const errors: string[] = [];
    w.on("pageerror", (e) => errors.push(String(e)));
    w.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    try {
      await seed(w, [SEED_BUY]);
      await commentsToggle(w).click();
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(1);
      const lists = await store(w, (st) => st.listCalls);
      // a quiet change with no change event (the subscription cap case or a missed event)
      await w.evaluate(() => { const st = (window as any).__feedbackProbe.store; st.comments.push({ ...st.comments[0], id: "cmt_" + "e".repeat(32), selectionId: "sel_" + "e".repeat(32), ordinal: 2, anchor: { ...st.comments[0].anchor, selector: "#plans-h", textAnchor: { tag: "h2", text: "Plans" }, tag: "h2" } }); });
      await w.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(2);
      expect(await store(w, (st) => st.listCalls)).toBeGreaterThan(lists);
      // the provider's list starts failing
      await w.evaluate(() => { const svc = (window as any).app.artifactFeedbackService; svc.entries[0].handler.comments.list = async () => { throw new Error("list exploded"); }; });
      await w.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(rail(w).locator(".comments-rail-notice")).toBeVisible();
      await pickToggle(w).click();
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popover(w)).toBeVisible();
      await expect(popover(w).getByRole("button", { name: "Pin" })).toBeHidden();
      await expect(popover(w).getByRole("button", { name: "Send" })).toBeVisible();
      await expect(rail(w).locator(".comments-rail-row")).toHaveCount(2); // the last good rows stay
      expect(errors.filter((e) => !/list exploded|did not answer|could not complete/.test(e))).toEqual([]);
    } finally { await s.cleanup(); }
  });

  // ---- (8) overlay mapping checked against PIXELS, not against the implementation's own formula ----------------------
  /** Bounding box (window css px) of the pixels close to `rgb` in a capture of the window, found in the main process. */
  const pixelBox = (app: ElectronApplication, rgb: [number, number, number]) => app.evaluate(async ({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const bmp = image.toBitmap(); // BGRA
    const scale = size.width / win.getContentBounds().width;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, n = 0;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      if (Math.abs(bmp[i + 2]! - target[0]) < 12 && Math.abs(bmp[i + 1]! - target[1]) < 12 && Math.abs(bmp[i]! - target[2]) < 12) {
        n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { scale, count: n, left: minX / scale, top: minY / scale, right: (maxX + 1) / scale, bottom: (maxY + 1) / scale };
  }, rgb);

  test("overlay mapping vs pixels (DPR 1): the badge centre is at the green button's top-right minus (4, -4), in fill, tablet and mobile presets", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY]);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      const rows: unknown[] = [];
      for (const preset of ["fill", "tablet", "mobile"]) {
        if (preset !== "fill") await w.locator(`[data-viewport="${preset}"]`).click();
        else await w.locator('[data-viewport="fill"]').click();
        await w.waitForTimeout(900);
        const box = await pixelBox(s.app, [34, 170, 102]);
        expect(box.count, `${preset}: found pixels`).toBeGreaterThan(1000);
        const badge = await w.locator(".pin-badge").boundingBox();
        const dx = badge!.x + badge!.width / 2 - (box.right - 4);
        const dy = badge!.y + badge!.height / 2 - (box.top + 4);
        rows.push({ preset, dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100, scale: box.scale });
        expect(Math.abs(dx), `${preset} dx`).toBeLessThanOrEqual(1.5);
        expect(Math.abs(dy), `${preset} dy`).toBeLessThanOrEqual(1.5);
      }
      console.log("QA-ANN pixel-mapping-dpr1", JSON.stringify(rows));
    } finally { await s.cleanup(); }
  });

  test("CHAR: the same pixel check with --force-device-scale-factor=2 on Linux/Xvfb (NOT a Retina Mac, NOT ProMotion; evidence only)", async () => {
    const env = makeEnv("geode-qa-g3-dpr2-");
    const root = path.join(env.temp, "artifact");
    writeStaticArtifact(root, BASIC_ARTIFACT);
    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${env.userDataDir}`, "--force-device-scale-factor=2"], cwd: repoRoot });
    try {
      const w = await app.firstWindow();
      await w.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
      const bw = await app.browserWindow(w);
      await bw.evaluate((win: any) => win.setSize(1280, 800));
      await w.evaluate(() => { const a = (window as any).app; for (const sb of [a.workspace.leftSidebar, a.workspace.rightSidebar]) if (!sb.collapsed) sb.toggle(); });
      await expect.poll(() => w.evaluate(() => typeof (window as any).__feedbackProbe?.register), { timeout: 30_000 }).toBe("function");
      await w.evaluate(() => (window as any).__feedbackProbe.registerV2());
      await w.evaluate((r) => (window as any).app.openArtifact(r), root);
      await expect(w.locator(".artifact-view-frame")).toBeVisible();
      const dpr = await w.evaluate(() => window.devicePixelRatio);
      await seed(w, [SEED_BUY]);
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      const rows: unknown[] = [];
      for (const preset of ["fill", "tablet", "mobile"]) {
        await w.locator(`[data-viewport="${preset}"]`).click();
        await w.waitForTimeout(1000);
        const box = await pixelBox(app, [34, 170, 102]);
        const badge = await w.locator(".pin-badge").boundingBox();
        const dx = badge!.x + badge!.width / 2 - (box.right - 4);
        const dy = badge!.y + badge!.height / 2 - (box.top + 4);
        rows.push({ preset, dpr, captureScale: box.scale, pixels: box.count, dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100 });
      }
      console.log("QA-ANN pixel-mapping-dpr2-linux", JSON.stringify(rows));
    } finally { await app.close().catch(() => {}); fs.rmSync(env.temp, { recursive: true, force: true }); }
  });

  test("narrow sheet: once the layout has settled the rail sheet is inside the pane (the engineer's version of this check flakes because it measures during the sidebar animation)", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY]);
      await narrow(s);
      // wait for the pane width to stop changing (the right sidebar opens with a transition)
      let last = -1, stableSince = Date.now();
      await expect.poll(async () => {
        const width = await w.locator(".artifact-view").evaluate((e) => e.getBoundingClientRect().width);
        if (width !== last) { last = width; stableSince = Date.now(); return false; }
        return Date.now() - stableSince > 600;
      }, { timeout: 15_000, intervals: [100] }).toBe(true);
      await commentsToggle(w).click();
      await expect(rail(w)).toHaveClass(/is-sheet/);
      const m = await w.evaluate(() => {
        const r = document.querySelector(".comments-rail")!.getBoundingClientRect();
        const p = document.querySelector(".artifact-view")!.getBoundingClientRect();
        return { railRight: r.right, paneRight: p.right, railLeft: r.left, paneLeft: p.left };
      });
      console.log("QA-ANN sheet-geometry", JSON.stringify(m));
      expect(m.railRight).toBeLessThanOrEqual(m.paneRight + 0.5);
      expect(m.railLeft).toBeGreaterThanOrEqual(m.paneLeft - 0.5);
    } finally { await s.cleanup(); }
  });

  // ---- G4: queued batch completes while the view is open and while it is closed ---------------------------------
  const drain = (w: Page) => store(w, (st) => {
    for (const c of st.comments) if (c.status === "pending") { c.status = "sent"; c.sentAt = new Date().toISOString(); c.version++; }
    st.emit("send-result", "all");
  });

  test("G4: a queued batch shows Waiting for the agent (rail chip, dashed pins, confirm to cancel) and completes live while the view is open", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY, SEED_HEADING]);
      await store(w, (st) => { st.sendMode = "queued"; });
      await commentsToggle(w).click();
      await expect(rail(w).locator(".comments-rail-send")).toHaveText("Send 2");
      await rail(w).locator(".comments-rail-send").click();
      await expect(rail(w).locator(".comments-rail-results")).toHaveText("2 waiting for the agent");
      await expect(rail(w).locator('.comments-rail-row[data-status="pending"]')).toHaveCount(2);
      await expect(rail(w).locator(".comments-rail-send")).toBeDisabled();
      await expect(badges(w).first()).toHaveClass(/is-pending/);
      // unqueue needs a confirm and names the size of the queued batch
      await rail(w).locator('.comments-rail-row[data-status="pending"]').first().locator('[data-action="unqueue"]').click();
      await expect(rail(w).locator(".comments-rail-confirm")).toContainText("Cancels the queued send of 2 comments.");
      await w.keyboard.press("Escape");
      await expect(rail(w).locator(".comments-rail-confirm")).toHaveCount(0);
      expect(await store(w, (st) => st.updateCalls.length)).toBe(0);
      // the agent drains the queue while the view is open
      await drain(w);
      await expect(rail(w).locator('.comments-rail-row[data-status="sent"]')).toHaveCount(2);
      await expect(badges(w).first()).toHaveClass(/is-sent/);
    } finally { await s.cleanup(); }
  });

  test("G4: a queued batch that completes while the artifact tab is CLOSED shows as sent when the tab is reopened", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY]);
      await store(w, (st) => { st.sendMode = "queued"; });
      await commentsToggle(w).click();
      await rail(w).locator(".comments-rail-send").click();
      await expect(rail(w).locator('.comments-rail-row[data-status="pending"]')).toHaveCount(1);
      await w.evaluate(() => (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].detach());
      await expect.poll(() => w.locator(".artifact-view").count()).toBe(0);
      await drain(w); // nobody is listening
      await w.evaluate((root) => (window as any).app.openArtifact(root), s.root);
      await expect(w.locator(".artifact-view-frame")).toBeVisible();
      await expect(commentsToggle(w)).toBeVisible();
      await commentsToggle(w).click();
      await expect(rail(w).locator('.comments-rail-row[data-status="sent"]')).toHaveCount(1, { timeout: 15_000 });
      await expect(badges(w)).toHaveCount(1, { timeout: 20_000 });
      await expect(badges(w).first()).toHaveClass(/is-sent/);
    } finally { await s.cleanup(); }
  });

  // ---- (7) a11y extras: roles, names, reduced motion, screenshots -----------------------------------------------
  test("a11y: roles, names and landmarks of the pin layer, rail and toggle; reduced motion removes transitions", async () => {
    const s = await session(BASIC_ARTIFACT, { register: "v2", probe: false, size: [1280, 800] });
    const w = s.window;
    try {
      await seed(w, [SEED_BUY, { ...SEED_PRICE }, SEED_HEADING]);
      await expect(badges(w)).toHaveCount(3, { timeout: 20_000 });
      await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      expect(await w.locator(".pin-layer").getAttribute("role")).toBe("group");
      expect(await w.locator(".pin-layer").getAttribute("aria-label")).toBe("Comment pins");
      expect(await rail(w).evaluate((e) => e.tagName)).toBe("ASIDE");
      expect(await rail(w).getAttribute("aria-label")).toBe("Design comments");
      expect(await commentsToggle(w).getAttribute("aria-controls")).toBe(await rail(w).getAttribute("id"));
      expect(await commentsToggle(w).getAttribute("aria-expanded")).toBe("true");
      const names = await badges(w).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      for (const n of names) expect(n).toMatch(/^Comment \d, (open|sent), on /);
      // every interactive control in the rail has an accessible name
      const unnamed = await rail(w).evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, input")].filter((e) => !(e.getAttribute("aria-label") || e.textContent?.trim() || e.getAttribute("title"))).map((e) => e.outerHTML.slice(0, 80)));
      expect(unnamed).toEqual([]);
      // a live region exists for announcements
      expect(await w.locator(".artifact-view-live").getAttribute("aria-live")).toBe("polite");
      // reduced motion
      await w.emulateMedia({ reducedMotion: "reduce" });
      const motion = await w.evaluate(() => ({ badge: getComputedStyle(document.querySelector(".pin-badge")!).transitionDuration, rail: getComputedStyle(document.querySelector(".comments-rail")!).transitionDuration }));
      expect(motion.badge).toMatch(/^0s/);
      await w.emulateMedia({ reducedMotion: "no-preference" });
      await w.waitForTimeout(400);
      await windowShot(s, "qa-rail-desktop");
      // desktop without the rail
      await commentsToggle(w).click();
      await expect(rail(w)).toBeHidden();
      await w.waitForTimeout(600);
      await windowShot(s, "qa-pins-desktop");
      await narrow(s);
      await w.waitForTimeout(1000);
      await windowShot(s, "qa-pins-narrow");
      await commentsToggle(w).click();
      await expect(rail(w)).toBeVisible();
      await expect(rail(w)).toHaveClass(/is-sheet/);
      await w.waitForTimeout(600);
      await windowShot(s, "qa-rail-narrow");
    } finally { await s.cleanup(); }
  });
});
