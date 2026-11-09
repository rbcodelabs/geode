import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import {
  BASIC_ARTIFACT,
  HOSTILE_ARTIFACT,
  SIDECAR_ARTIFACT,
  VAULT_READ_ARTIFACT,
  bigArtifact,
  makeEnv,
  writeStaticArtifact,
  type ArtifactSpec,
  type E2eEnv,
} from "./helpers/artifact-picker-fixtures";

/**
 * Element picker (ADR 0006, Phase 1) in real Electron: the real registry, bridge, host preload,
 * webview, pick controller and popover. The Design plugin is replaced by the fixture plugin
 * tests/fixtures/plugins/artifact-feedback-probe, which registers through the public
 * Plugin.registerArtifactFeedbackHandler API and records every request.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const BUY = { x: 100, y: 200, width: 160, height: 48 };
const BUY_CENTER = { x: 180, y: 224 };
// 1x1 transparent PNG
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SELECTION_ID = /^sel_[0-9a-f]{32}$/;

interface Session { app: ElectronApplication; window: Page; env: E2eEnv; cleanup(): Promise<void> }

async function launch(env: E2eEnv, options: { size?: [number, number] } = {}): Promise<Session> {
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${env.userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  const [width, height] = options.size ?? [1280, 800];
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any, size) => win.setSize(size[0], size[1]), [width, height]);
  return {
    app, window, env,
    cleanup: async () => { await app.close().catch(() => {}); fs.rmSync(env.temp, { recursive: true, force: true }); },
  };
}

async function waitForProbe(window: Page): Promise<void> {
  await expect.poll(() => window.evaluate(() => typeof (window as any).__feedbackProbe?.register), { timeout: 30_000 }).toBe("function");
}

const openArtifact = async (window: Page, root: string): Promise<void> => {
  await window.evaluate((r) => (window as any).app.openArtifact(r), root);
  await expect(window.locator(".artifact-view-frame")).toBeVisible();
};

const probe = {
  register: (window: Page) => window.evaluate(() => (window as any).__feedbackProbe.register()),
  dispose: (window: Page) => window.evaluate(() => (window as any).__feedbackProbe.dispose()),
  setMode: (window: Page, mode: string) => window.evaluate((m) => { (window as any).__feedbackProbe.mode = m; }, mode),
  requests: (window: Page) => window.evaluate(() => (window as any).__feedbackProbe.requests as any[]),
  aborted: (window: Page) => window.evaluate(() => (window as any).__feedbackProbe.aborted as number),
};

/** Input into the artifact guest's own webContents: these are real, trusted events (spike A2/A3). */
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
/** PNG (base64) of a region of the guest's own surface, from the main process. Used to see the highlight. */
const guestPixels = (app: ElectronApplication, rect: { x: number; y: number; width: number; height: number }) =>
  app.evaluate(async ({ webContents }, r) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed() && !w.getURL().startsWith("devtools"))!;
    return (await guest.capturePage(r)).toPNG().toString("base64");
  }, rect);

const frameOf = (window: Page): Locator => window.locator(".artifact-view-frame");
const guestEval = <T = unknown>(window: Page, code: string): Promise<T> =>
  frameOf(window).evaluate((guest, c) => (guest as any).executeJavaScript(c), code) as Promise<T>;
const toggleOf = (window: Page): Locator => window.locator(".artifact-view-pick-btn");
const popoverOf = (window: Page): Locator => window.locator(".pick-popover");
const statusOf = (window: Page): Locator => window.locator(".pick-popover-status");
const activeIs = (window: Page, selector: string) =>
  window.evaluate((s) => document.activeElement?.matches(s) === true, selector);

/** Highlight-sensitive region around #buy (padding so the outline is inside). */
const BUY_REGION = { x: BUY.x - 12, y: BUY.y - 12, width: BUY.width + 24, height: BUY.height + 24 };

async function pickAndSelect(session: Session): Promise<void> {
  await toggleOf(session.window).click();
  await expect(toggleOf(session.window)).toHaveAttribute("aria-pressed", "true");
  await clickAt(session.app, BUY_CENTER.x, BUY_CENTER.y);
  await expect(popoverOf(session.window)).toBeVisible();
}

function expectWithinCaps(selection: any): void {
  expect(selection.schemaVersion).toBe(1);
  expect(selection.selectionId).toMatch(SELECTION_ID);
  expect(selection.outerHTML.html.length).toBeLessThanOrEqual(4096);
  expect(selection.selector.length).toBeLessThanOrEqual(512);
  expect(selection.selectorAlternates.length).toBeLessThanOrEqual(3);
  for (const alt of selection.selectorAlternates) expect(alt.length).toBeLessThanOrEqual(512);
  expect(selection.ancestors.length).toBeLessThanOrEqual(3);
  expect(selection.route.length).toBeLessThanOrEqual(512);
  expect(selection.textAnchor.text.length).toBeLessThanOrEqual(80);
  if (selection.landmark !== null) expect(selection.landmark.length).toBeLessThanOrEqual(120);
  if (selection.a11y.name !== null) expect(selection.a11y.name.length).toBeLessThanOrEqual(200);
  expect(Object.keys(selection.computedStyles).length).toBeLessThanOrEqual(40);
  for (const value of Object.values(selection.computedStyles)) expect((value as string).length).toBeLessThanOrEqual(200);
  expect(selection.tag).toMatch(/^[a-z][a-z0-9:-]{0,31}$/);
  expect(Object.keys(selection)).not.toContain("__proto__");
}

function expectBox(selection: any, expected = BUY): void {
  const box = selection.boundingBox.viewport;
  expect(Math.abs(box.x - expected.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - expected.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.width - expected.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - expected.height)).toBeLessThanOrEqual(1);
}

async function basicSession(options: { register?: boolean; spec?: ArtifactSpec; vaultFiles?: Record<string, string>; size?: [number, number] } = {}) {
  const env = makeEnv("geode-picker-e2e-", { vaultFiles: options.vaultFiles });
  const artifactRoot = path.join(env.temp, "artifact");
  writeStaticArtifact(artifactRoot, options.spec ?? BASIC_ARTIFACT);
  const session = await launch(env, { size: options.size });
  await waitForProbe(session.window);
  if (options.register !== false) expect(await probe.register(session.window)).toBe("registered");
  await openArtifact(session.window, artifactRoot);
  return { ...session, artifactRoot };
}

test.describe("element picker", () => {
  test.setTimeout(120_000);

  test("(a) the Pick button exists only while a handler can receive feedback", async () => {
    const s = await basicSession({ register: false });
    try {
      await expect(frameOf(s.window)).toBeVisible();
      await expect(toggleOf(s.window)).toBeHidden(); // no handler registered
      expect(await probe.register(s.window)).toBe("registered");
      await expect(toggleOf(s.window)).toBeVisible();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-label", "Pick element to comment");
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await probe.dispose(s.window); // disposal exits pick mode in every view and hides the button
      await expect(toggleOf(s.window)).toBeHidden();
      // canHandle false also hides it
      await s.window.evaluate(() => { (window as any).__feedbackProbe.canHandle = false; });
      expect(await probe.register(s.window)).toBe("registered");
      await expect(toggleOf(s.window)).toBeHidden();
      await s.window.evaluate(() => { (window as any).__feedbackProbe.canHandle = true; (window as any).__feedbackProbe.dispose(); });
      expect(await probe.register(s.window)).toBe("registered");
      await expect(toggleOf(s.window)).toBeVisible();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
    } finally { await s.cleanup(); }
  });

  test("(b) happy path: hover highlights, click selects, comment goes to the handler with a bounded screenshot", async () => {
    const s = await basicSession();
    try {
      const before = await guestPixels(s.app, BUY_REGION);
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await expect(s.window.locator(".artifact-view-status")).toContainText("Pick mode");
      await moveTo(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(s.window.locator(".artifact-view-hover")).toContainText("<button>");
      // the highlight is drawn by the guest: the pixels around #buy change
      await expect.poll(async () => (await guestPixels(s.app, BUY_REGION)) !== before).toBe(true);
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);

      const popover = popoverOf(s.window);
      await expect(popover).toBeVisible();
      await expect(popover.getByRole("heading")).toHaveText("Comment on <button>");
      await expect(popover.locator(".pick-popover-target")).toContainText("Buy now");
      await expect(popover).toHaveAttribute("aria-modal", "false");
      expect(await activeIs(s.window, ".pick-popover-comment")).toBe(true);
      // the page's own listeners saw nothing of the pick
      expect(await guestEval(s.window, `JSON.stringify(window.__log)`)).toBe(JSON.stringify({ trustedClick: 0, trustedMouse: 0, anyClick: 0, buyClicks: 0 }));
      // no Pin button in Phase 1
      await expect(popover.getByRole("button")).toHaveText(["Show what will be sent", "Send", "Cancel"]);

      await popover.locator("details > summary").click();
      await expect(popover.locator(".pick-popover-disclosure")).toContainText("Selector: #buy");
      await expect(popover.locator(".pick-popover-disclosure")).toContainText("Screenshot: included (image/png");
      await popover.getByRole("textbox", { name: "Comment on the selected element" }).fill("Make this button larger and use our brand green.");
      await popover.getByRole("button", { name: "Send" }).click();

      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await probe.requests(s.window);
      expect(requests).toHaveLength(1);
      const [r] = requests;
      expect(r.comment).toBe("Make this button larger and use our brand green.");
      expect(r.stale).toBe(false);
      expect(r.frozen).toBe(true);
      expect(r.artifact).toEqual({ root: s.artifactRoot, artifactId: "picker-basic", title: "Pricing page", runtime: "static", vaultRead: false });
      expect(r.selection.tag).toBe("button");
      expect(r.selection.selector).toBe("#buy");
      expect(r.selection.redacted).toBe(false);
      expect(r.selection.textAnchor.text).toBe("Buy now");
      expect(r.selection.a11y).toMatchObject({ role: "button", name: "Buy now" });
      expect(r.selection.route).toMatch(/index\.html/);
      expect(r.selection.viewportPreset).toBe("fill");
      expect(r.selection.artifactId).toBe("picker-basic");
      expectBox(r.selection);
      expectWithinCaps(r.selection);
      expect(r.screenshotOmitted).toBeNull();
      expect(r.screenshot.mimeType).toBe("image/png");
      expect(r.screenshot.isUint8Array).toBe(true);
      expect(r.screenshot.signature).toEqual(PNG_SIGNATURE);
      expect(r.screenshot.length).toBeGreaterThan(100);
      expect(r.screenshot.length).toBeLessThanOrEqual(512 * 1024);
      // the screenshot was taken with the highlight hidden: it is the crop of the selection, not the overlay
      expect(r.screenshot.cssRect.width).toBeGreaterThanOrEqual(BUY.width);

      // accepted: Done is focused; dismissing it ends the single-shot pick
      await expect(popoverOf(s.window).getByRole("button", { name: "Done" })).toBeFocused();
      await popoverOf(s.window).getByRole("button", { name: "Done" }).click();
      await expect(popoverOf(s.window)).toBeHidden();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
    } finally { await s.cleanup(); }
  });

  test("(c) a rejection shows the plugin's message; Retry re-sends the same selection id", async () => {
    const s = await basicSession();
    try {
      await probe.setMode(s.window, "reject-once");
      await pickAndSelect(s);
      await popoverOf(s.window).getByRole("textbox").fill("Swap the colours.");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("The agent is still working on an earlier comment. Try again in a moment.");
      await expect(statusOf(s.window)).toHaveAttribute("role", "alert");
      await expect(popoverOf(s.window).getByRole("textbox")).toHaveValue("Swap the colours.");
      await expect(popoverOf(s.window).getByRole("button", { name: "Cancel" })).toBeEnabled();
      await popoverOf(s.window).getByRole("button", { name: "Retry" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await probe.requests(s.window);
      expect(requests).toHaveLength(2);
      expect(requests[1].selection.selectionId).toBe(requests[0].selection.selectionId);
      expect(requests[1].selection.selectionId).toMatch(SELECTION_ID);
      expect(requests[1].comment).toBe("Swap the colours.");
    } finally { await s.cleanup(); }
  });

  test("(d) a handler that never answers: Cancel is disabled while pending, then a distinct timeout message", async () => {
    const s = await basicSession();
    try {
      await probe.setMode(s.window, "never");
      // shorten the timeout through the service instance (a plain TS-private field); the 15 s default is unit tested
      await s.window.evaluate(() => { (window as any).app.artifactFeedback.timeoutMs = 1000; });
      await pickAndSelect(s);
      await popoverOf(s.window).getByRole("textbox").fill("Is anyone there?");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Sending to Design Probe…");
      await expect(popoverOf(s.window)).toHaveAttribute("aria-busy", "true");
      await expect(popoverOf(s.window).getByRole("button", { name: "Cancel" })).toBeDisabled();
      await expect(popoverOf(s.window).getByRole("textbox")).toHaveJSProperty("readOnly", true);
      await s.window.keyboard.press("Escape"); // ignored while pending
      await expect(popoverOf(s.window)).toBeVisible();
      await expect(statusOf(s.window)).toContainText("No response from Design Probe in 1 s", { timeout: 8_000 });
      await expect(statusOf(s.window)).toContainText("It may have been received");
      await expect(statusOf(s.window)).toHaveAttribute("role", "alert");
      await expect(popoverOf(s.window).getByRole("button", { name: "Retry" })).toBeEnabled();
      await expect(popoverOf(s.window).getByRole("button", { name: "Cancel" })).toBeEnabled();
      expect(await probe.aborted(s.window)).toBe(1);
      // Retry resolves immediately with the same selection id once the handler answers
      await probe.setMode(s.window, "accept");
      await popoverOf(s.window).getByRole("button", { name: "Retry" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await probe.requests(s.window);
      expect(requests).toHaveLength(2);
      expect(requests[1].selection.selectionId).toBe(requests[0].selection.selectionId);
    } finally { await s.cleanup(); }
  });

  test("(d2) disposing the handler mid-flight settles the popover as unavailable and disables Send", async () => {
    const s = await basicSession();
    try {
      await probe.setMode(s.window, "never");
      await pickAndSelect(s);
      await popoverOf(s.window).getByRole("textbox").fill("Hello");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Sending to Design Probe…");
      await probe.dispose(s.window);
      await expect(statusOf(s.window)).toContainText("no longer available");
      await expect(popoverOf(s.window).getByRole("button", { name: /Retry|Send/ })).toBeDisabled();
      await expect(popoverOf(s.window).getByRole("button", { name: "Cancel" })).toBeEnabled();
    } finally { await s.cleanup(); }
  });

  test("(e) keyboard-only flow and the Esc order", async () => {
    const s = await basicSession();
    try {
      const toggle = toggleOf(s.window);
      await toggle.focus();
      await s.window.keyboard.press("Enter"); // keyboard activation moves focus into the page
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(await s.window.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("webview");

      // walk from <body> to its first child (the header), announce it, then select it with Enter
      await guestKey(s.app, "]");
      await expect(s.window.locator(".artifact-view-hover")).toContainText("<header>");
      await guestKey(s.app, "[");
      await expect(s.window.locator(".artifact-view-hover")).toContainText("<body>");
      await guestKey(s.app, "]");
      await guestKey(s.app, "Enter");
      await expect(popoverOf(s.window)).toBeVisible();
      expect(await activeIs(s.window, ".pick-popover-comment")).toBe(true);

      // Esc cancels the popover back to pick mode and returns focus to the page; a second Esc leaves pick mode
      await s.window.keyboard.press("Escape");
      await expect(popoverOf(s.window)).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(await s.window.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("webview");
      await guestKey(s.app, "Escape"); // natively in the page: same rules
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(toggle).toBeFocused();

      // the whole thing again, ending in Send by keyboard
      await toggle.focus();
      await s.window.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await guestKey(s.app, "]");
      await guestKey(s.app, "Enter");
      await expect(popoverOf(s.window)).toBeVisible();
      await s.window.keyboard.type("Tighten the header spacing.");
      await s.window.keyboard.press("Tab"); // disclosure summary
      await s.window.keyboard.press("Tab"); // Send
      await expect(popoverOf(s.window).getByRole("button", { name: "Send" })).toBeFocused();
      await s.window.keyboard.press("Enter");
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await probe.requests(s.window);
      expect(requests).toHaveLength(1);
      expect(requests[0].comment).toBe("Tighten the header spacing.");
      expect(requests[0].selection.tag).toBe("header");
      await expect(popoverOf(s.window).getByRole("button", { name: "Done" })).toBeFocused();
      await s.window.keyboard.press("Enter"); // Done: pick is single-shot, focus goes back to what held it
      await expect(popoverOf(s.window)).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(await s.window.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("webview");
    } finally { await s.cleanup(); }
  });

  test("(e2) mouse user: [ and ] typed in the toolbar are forwarded, Esc leaves pick mode, Capture turns it off", async () => {
    const s = await basicSession();
    try {
      const toggle = toggleOf(s.window);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toBeFocused();
      await s.window.keyboard.press("]");
      await expect(s.window.locator(".artifact-view-hover")).toContainText("<header>");
      await s.window.keyboard.press("Escape");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await s.window.getByRole("button", { name: "Capture artifact screenshot" }).click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    } finally { await s.cleanup(); }
  });

  test("(f) vault:read artifacts: no screenshot bytes and redacted text", async () => {
    const s = await basicSession({
      spec: VAULT_READ_ARTIFACT,
      vaultFiles: { "Tasks.base": "views:\n  - type: table\n    name: Main\n    order: [file.name]\n" },
    });
    try {
      await pickAndSelect(s);
      await popoverOf(s.window).locator("details > summary").click();
      await expect(popoverOf(s.window).locator(".pick-popover-disclosure")).toContainText("Screenshot: not included (this artifact reads vault data)");
      await expect(popoverOf(s.window).locator(".pick-popover-disclosure")).toContainText("Text redaction: on");
      await popoverOf(s.window).getByRole("textbox").fill("Rename this.");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const [r] = await probe.requests(s.window);
      expect(r.screenshot).toBeNull();
      expect(r.screenshotOmitted).toBe("vault-read");
      expect(r.selection.redacted).toBe(true);
      expect(r.selection.textAnchor.text).toBe("");
      expect(r.selection.a11y.name).toBeNull();
      expect(r.artifact.vaultRead).toBe(true);
      expect(r.selection.outerHTML.html).not.toContain("Buy now");
      // a different element: its (vault-adjacent) text must not leak either
      expect(JSON.stringify(r)).not.toContain("Quarterly layoffs");
    } finally { await s.cleanup(); }
  });

  test("(g) a nextjs artifact never gets a Pick button, even with a handler registered", async () => {
    const dev = await new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>Dev</title><main id="r" style="height:100vh">ready</main>`);
      });
      server.listen(0, "127.0.0.1", () => resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      }));
    });
    const env = makeEnv("geode-picker-next-e2e-");
    const root = path.join(env.temp, "next");
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "app", "page.tsx"), "export default function Page() { return null; }\n");
    fs.writeFileSync(path.join(root, "artifact.json"), JSON.stringify({
      schemaVersion: 2, id: "next-picker", title: "Next picker", entry: "app/page.tsx", runtime: "nextjs",
      createdByThreadId: "thread-e2e", viewport: { preset: "custom", width: 720, height: 480 },
      permissions: { network: "loopback", clipboard: false },
    }));
    const s = await launch(env);
    try {
      await waitForProbe(s.window);
      expect(await probe.register(s.window)).toBe("registered");
      await s.window.evaluate(([r, u]) => (window as any).app.openArtifact(r, { url: u }), [root, dev.url]);
      await expect(frameOf(s.window)).toHaveAttribute("src", `${dev.url}/`);
      await expect.poll(() => guestEval(s.window, `document.title`)).toBe("Dev");
      await expect(toggleOf(s.window)).toBeHidden();
      await expect(s.window.locator(".artifact-view-toolbar")).toBeVisible();
    } finally { await s.cleanup(); await dev.close(); }
  });

  test("(h) hostile page: nothing it does forges, observes or suppresses a selection", async () => {
    const s = await basicSession({ spec: HOSTILE_ARTIFACT });
    try {
      await expect.poll(() => guestEval(s.window, `typeof window.__hostile`)).toBe("object");
      await guestEval(s.window, `window.__hostile.build50k()`);
      const buyRegion = BUY_REGION;
      const idle = await guestPixels(s.app, buyRegion);

      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      // the attack: synthetic events, forged posts/CustomEvents with the real channel names, patched
      // prototypes, host-node removal every 100 ms; keep it running through the rest of the test
      await guestEval(s.window, `window.__hostile.startStorm()`);
      await s.window.waitForTimeout(1500);
      expect(await probe.requests(s.window)).toHaveLength(0);
      await expect(popoverOf(s.window)).toBeHidden();
      expect(await guestEval(s.window, `window.__log.forgedPosts`)).toBeGreaterThan(5);

      // the highlight recovers from removal while the page keeps removing it
      await moveTo(s.app, 5, 5);
      await moveTo(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect.poll(async () => (await guestPixels(s.app, buyRegion)) !== idle, { timeout: 10_000 }).toBe(true);
      await expect(s.window.locator(".artifact-view-hover")).toContainText("<button>");
      expect(await guestEval(s.window, `JSON.stringify(window.__hostile.trueRect())`)).toContain(`"x":${BUY.x}`);

      // a real click yields exactly one selection, with the TRUE rect (the page lies about getBoundingClientRect)
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popoverOf(s.window)).toBeVisible();
      await s.window.waitForTimeout(500);
      await popoverOf(s.window).getByRole("textbox").fill("Check this.");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toHaveText("Queued for the agent.");
      const requests = await probe.requests(s.window);
      expect(requests).toHaveLength(1);
      const [r] = requests;
      expectBox(r.selection);
      expectWithinCaps(r.selection);
      expect(r.selection.selector).toBe("#buy");
      expect(r.selection.route).not.toContain("forged");
      expect(JSON.stringify(r.selection)).not.toContain("FORGED");
      // hostile text is data: bounded, and present only inside the data fields
      expect(r.selection.outerHTML.html).not.toMatch(/on\w+=/i);
      // the page's own click/mouse listeners saw no trusted pick events
      const log = JSON.parse(await guestEval<string>(s.window, `JSON.stringify(window.__log)`));
      expect(log.trustedClick).toBe(0);
      expect(log.buyClicks).toBe(0);
      expect(log.trustedMouse).toBeLessThanOrEqual(0);
      await popoverOf(s.window).getByRole("button", { name: "Done" }).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
      await guestEval(s.window, `window.__hostile.stop()`);
    } finally { await s.cleanup(); }
  });

  test("(h2) removal flood and document.open(): the picker degrades or heals, never forges, and Esc always exits", async () => {
    const s = await basicSession({ spec: HOSTILE_ARTIFACT });
    try {
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await guestEval(s.window, `window.__hostile.startFlood()`);
      await moveTo(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await s.window.waitForTimeout(2000); // no spin, renderer stays responsive
      expect(await s.window.evaluate(() => 1 + 1)).toBe(2);
      expect(await probe.requests(s.window)).toHaveLength(0);
      // Esc still exits pick mode, from the toolbar and natively
      await s.window.keyboard.press("Escape");
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await guestKey(s.app, "Escape");
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");

      // document.open() drops the page's and the picker's listeners; the 1 Hz re-assertion restores them
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await guestEval(s.window, `window.__hostile.reopen()`);
      await s.window.waitForTimeout(1500);
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popoverOf(s.window)).toBeVisible({ timeout: 10_000 });
      expect(await guestEval(s.window, `document.getElementById("buy2") !== null`)).toBe(true);
      await s.window.keyboard.press("Escape");
      await s.window.keyboard.press("Escape");
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
    } finally { await s.cleanup(); }
  });

  test("(i) .threads-design/ is invisible to the page and never reloads it; index.html still does", async () => {
    const s = await basicSession({ register: false, spec: SIDECAR_ARTIFACT });
    try {
      const reserved = path.join(s.artifactRoot, ".threads-design");
      fs.mkdirSync(reserved, { recursive: true });
      fs.writeFileSync(path.join(reserved, "secret.js"), `window.__sidecarScriptRan = true;`);
      fs.writeFileSync(path.join(reserved, "comments.json"), `{"secret":"SIDECAR-SECRET"}`);
      fs.writeFileSync(path.join(reserved, "secret.png"), TINY_PNG);
      await expect.poll(() => guestEval(s.window, `typeof window.__tryLoad`)).toBe("function");
      fs.writeFileSync(path.join(s.artifactRoot, "ok.png"), fs.readFileSync(path.join(reserved, "secret.png")));
      // control: an ordinary image in the same artifact loads, so a "blocked" below is the deny, not the setup
      expect(await guestEval(s.window, `window.__tryLoad("control", "ok.png")`)).toBe("loaded");
      for (const [name, url] of [
        ["plain", ".threads-design/secret.png"],
        ["upper", ".Threads-Design/secret.png"],
        ["encoded", "%2ethreads-design/secret.png"],
        ["dotdot", "sub/../.threads-design/secret.png"],
        ["backslash", ".threads-design%5Csecret.png"],
      ] as const) {
        expect(await guestEval(s.window, `window.__tryLoad(${JSON.stringify(name)}, ${JSON.stringify(url)})`), name).toBe("blocked");
      }
      expect(await guestEval(s.window, `window.__tryScript("s", ".threads-design/secret.js")`)).toBe("blocked");

      // writing into the directory does not reload the page
      const marker = await guestEval<string>(s.window, `window.__marker`);
      const regId = await s.window.evaluate(() => {
        const leaf = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0];
        return leaf.view.registration.registrationId as string;
      });
      const revision = () => s.window.evaluate((id) => (window as any).geode.getArtifactState(id).then((st: any) => st.revision as number), regId);
      const revisionBefore = await revision();
      fs.writeFileSync(path.join(reserved, "comments.json"), `{"secret":"SIDECAR-SECRET","n":2}`);
      fs.mkdirSync(path.join(reserved, "captures-like"), { recursive: true });
      fs.writeFileSync(path.join(reserved, "captures-like", "p.png"), "x");
      await s.window.waitForTimeout(2500);
      expect(await revision()).toBe(revisionBefore);
      expect(await guestEval(s.window, `window.__marker`)).toBe(marker);

      // writing a served file does reload it
      fs.writeFileSync(path.join(s.artifactRoot, "index.html"), `<!doctype html><meta charset="utf-8"><title>Sidecar</title><main id="m">sidecar probe v2</main><script src="app.js"></script>`);
      await expect.poll(revision, { timeout: 10_000 }).toBeGreaterThan(revisionBefore);
      await expect.poll(() => guestEval(s.window, `document.getElementById("m")?.textContent`)).toBe("sidecar probe v2");

      // navigating to it gives the same 404 as a missing file
      const bodyAt = async (rel: string) => {
        await guestEval(s.window, `location.href = ${JSON.stringify(rel)}`);
        await expect.poll(() => guestEval(s.window, `location.pathname`)).toBe(`/${rel}`);
        return guestEval<string>(s.window, `document.documentElement.innerText`);
      };
      const missing = await bodyAt("missing.txt");
      const denied = await bodyAt(".threads-design/comments.json");
      expect(denied).toBe(missing);
      expect(denied).not.toContain("SIDECAR-SECRET");
    } finally { await s.cleanup(); }
  });

  test("(j) pick mode survives an artifact reload", async () => {
    const s = await basicSession();
    try {
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      const marker = await guestEval<string>(s.window, `window.__marker`);
      fs.writeFileSync(path.join(s.artifactRoot, "style.css"), fs.readFileSync(path.join(s.artifactRoot, "style.css"), "utf8") + "\n/* changed */");
      await expect.poll(() => guestEval(s.window, `window.__marker`), { timeout: 10_000 }).not.toBe(marker);
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await s.window.waitForTimeout(500);
      await moveTo(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(s.window.locator(".artifact-view-hover")).toContainText("<button>");
      await clickAt(s.app, BUY_CENTER.x, BUY_CENTER.y);
      await expect(popoverOf(s.window)).toBeVisible();
      // a reload while the popover is open keeps it and says the selection may be stale
      fs.writeFileSync(path.join(s.artifactRoot, "style.css"), fs.readFileSync(path.join(s.artifactRoot, "style.css"), "utf8") + "\n/* again */");
      await expect(statusOf(s.window)).toContainText("The page reloaded; this selection may be out of date.", { timeout: 10_000 });
      await popoverOf(s.window).getByRole("textbox").fill("After reload");
      await popoverOf(s.window).getByRole("button", { name: "Send" }).click();
      await expect(statusOf(s.window)).toContainText("Queued for the agent.");
      const [r] = await probe.requests(s.window);
      expect(r.stale).toBe(true);
    } finally { await s.cleanup(); }
  });

  test("(k) the palette command toggles the picker and has no default hotkey", async () => {
    const s = await basicSession();
    try {
      const command = await s.window.evaluate(() => {
        const a = (window as any).app;
        const list = a.commands.list?.() ?? [];
        const found = list.find((c: any) => c.name === "Toggle element picker");
        return found ? { id: found.id, hotkey: found.hotkey ?? null } : null;
      });
      expect(command).not.toBeNull();
      expect(command!.hotkey).toBeNull();
      await s.window.evaluate((id) => (window as any).app.commands.executeCommandById(id), command!.id);
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await s.window.evaluate((id) => (window as any).app.commands.executeCommandById(id), command!.id);
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "false");
      await probe.dispose(s.window);
      const available = await s.window.evaluate(() => {
        const a = (window as any).app;
        return a.commands.list().some((c: any) => c.name === "Toggle element picker");
      });
      expect(available).toBe(false);
    } finally { await s.cleanup(); }
  });

  test("(l) hover latency on a 5k-node page is recorded (not gated)", async ({}, testInfo) => {
    const s = await basicSession({ spec: bigArtifact(5000) });
    try {
      await toggleOf(s.window).click();
      await expect(toggleOf(s.window)).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => guestEval(s.window, `document.querySelectorAll("#big div").length`)).toBe(5000);
      await s.window.evaluate(() => {
        const view = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view;
        const frame = view.containerEl.querySelector("webview");
        (window as any).__hoverTimes = [];
        frame.addEventListener("ipc-message", (e: any) => { if (e.channel.endsWith(":hover")) (window as any).__hoverTimes.push(performance.timeOrigin + performance.now()); });
      });
      const sent: number[] = [];
      for (let i = 0; i < 80; i++) {
        const x = 20 + (i % 20) * 44;
        const y = 10 + Math.floor(i / 20) * 24 + (i % 2);
        sent.push(await s.app.evaluate(({ webContents }, p) => {
          const g = webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed() && !w.getURL().startsWith("devtools"))!;
          const t0 = performance.timeOrigin + performance.now();
          g.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
          return t0;
        }, { x, y }));
        await s.window.waitForTimeout(30);
      }
      await s.window.waitForTimeout(500);
      const times = await s.window.evaluate(() => (window as any).__hoverTimes as number[]);
      const deltas = times.map((t, i) => t - sent[Math.min(i, sent.length - 1)]!).filter((d) => d >= 0).sort((a, b) => a - b);
      const pct = (p: number) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] ?? NaN;
      const summary = { nodes: 5000, sent: sent.length, received: times.length, p50Ms: +pct(0.5).toFixed(1), p95Ms: +pct(0.95).toFixed(1) };
      console.log(`[picker-hover-latency] ${JSON.stringify(summary)}`);
      testInfo.annotations.push({ type: "hover-latency", description: JSON.stringify(summary) });
      expect(times.length).toBeGreaterThan(10);
    } finally { await s.cleanup(); }
  });
});
