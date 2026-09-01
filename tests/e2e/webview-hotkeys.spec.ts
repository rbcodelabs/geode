import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const isMac = process.platform === "darwin";
const MOD = isMac ? "meta" : "control";

/**
 * Hotkeys pressed inside a `<webview>` guest used to do nothing: Geode's only
 * keydown listener lives on the host document, and a guest runs in its own
 * process. Worse, Cmd+W then bubbled back unhandled to the application menu's
 * Close Window accelerator and killed the whole window instead of the tab.
 *
 * Playwright's `keyboard.press` targets the host page, so it cannot exercise
 * the guest path at all. These tests drive the guest's own WebContents from
 * the main process with `sendInputEvent`, which is what actually flows through
 * the `before-input-event` bridge under test.
 */

/**
 * A throwaway vault per test. The shared `test-vault/` would work, but these
 * tests open and close tabs, and `test-vault/.geode/workspace.json` persists
 * between runs, so absolute tab counts would depend on whatever the previous
 * spec left behind.
 */
async function launch() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webview-hotkeys-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webview-hotkeys-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n\nBody text.\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  const cleanup = () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, cleanup };
}

async function runCommand(window: Page, name: string) {
  await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
  await window.locator(".prompt-input").fill(name);
  await window.getByText(name, { exact: true }).click();
}

/** Send a keystroke to the `<webview>` guest itself, not to the host page. */
async function pressInGuest(app: ElectronApplication, key: string, modifiers: string[]) {
  return app.evaluate(({ webContents }, payload) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview");
    if (!guest) return false;
    guest.focus();
    guest.sendInputEvent({
      type: "keyDown",
      keyCode: payload.key,
      modifiers: payload.modifiers as ("meta" | "control" | "shift" | "alt")[],
    });
    return true;
  }, { key, modifiers });
}

const rootTabs = (window: Page) =>
  window.locator(".workspace-split.mod-root .workspace-tab-header");

const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test("Mod+W inside a web viewer guest closes the tab and leaves the window open", async () => {
  const { app, window, cleanup } = await launch();

  try {
    const tabsBefore = await rootTabs(window).count();
    await runCommand(window, "Open web viewer");
    await expect(window.locator(".web-view-frame")).toBeVisible();
    await expect(rootTabs(window)).toHaveCount(tabsBefore + 1);

    expect(await pressInGuest(app, "w", [MOD])).toBe(true);

    // The tab goes away...
    await expect(window.locator(".web-view")).toHaveCount(0, { timeout: 10_000 });
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
    // ...and the window survives. This is the reported bug: Cmd+W from a web
    // tab used to hit the menu's Close Window accelerator instead.
    expect(await windowCount(app)).toBe(1);
    expect(window.isClosed()).toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});

test("a Geode hotkey pressed inside a web viewer guest runs its command", async () => {
  const { app, window, cleanup } = await launch();

  try {
    await runCommand(window, "Open web viewer");
    await expect(window.locator(".web-view-frame")).toBeVisible();

    // Mod+P is dead inside a guest without the bridge.
    expect(await pressInGuest(app, "p", [MOD])).toBe(true);
    await expect(window.locator(".prompt-input")).toBeVisible({ timeout: 10_000 });
    await window.keyboard.press("Escape");
    await expect(window.locator(".prompt-input")).toHaveCount(0);

    // Mod+T ("New tab") collides with nothing in the application menu, so it
    // shows the bridge dispatches commands, not merely that Cmd+W stopped
    // misfiring into the menu.
    const tabsBefore = await rootTabs(window).count();
    expect(await pressInGuest(app, "t", [MOD])).toBe(true);
    await expect(rootTabs(window)).toHaveCount(tabsBefore + 1, { timeout: 10_000 });
  } finally {
    await app.close();
    cleanup();
  }
});

test("an editor-command hotkey pressed inside a web viewer does not target a stale active Markdown leaf", async () => {
  const { app, window, cleanup } = await launch();

  try {
    await window.locator('.nav-file-title[data-path="Note.md"]').click();
    await window.evaluate(async () => {
      const geodeApp = (window as any).app;
      const markdownGroup = geodeApp.workspace.activeLeaf.group;
      const webLeaf = geodeApp.workspace.splitActiveLeaf("vertical");
      await webLeaf.setViewState({ type: "webviewer", active: true, state: { url: "https://example.com" } });
      geodeApp.workspace.setActiveGroup(markdownGroup);
      (window as any).__editorGuestCommandFired = 0;
      geodeApp.commands.add({
        id: "probe:editor-guest",
        name: "Editor guest probe",
        hotkeys: [{ modifiers: ["Mod"], code: "KeyJ" }],
        editorCallback: () => { (window as any).__editorGuestCommandFired += 1; },
      });
    });
    await expect(window.locator(".web-view-frame")).toBeVisible();
    await window.waitForTimeout(100);

    // The host-document path still resolves the active Markdown editor.
    await window.keyboard.press(isMac ? "Meta+j" : "Control+j");
    expect(await window.evaluate(() => (window as any).__editorGuestCommandFired)).toBe(1);

    // The guest path must use the guest-owning Web Viewer leaf, not the stale
    // host activeLeaf that still points at the Markdown split.
    expect(await pressInGuest(app, "j", [MOD])).toBe(true);
    await window.waitForTimeout(100);
    expect(await window.evaluate(() => (window as any).__editorGuestCommandFired)).toBe(1);
  } finally {
    await app.close();
    cleanup();
  }
});

test("changed and conflicted bindings republish live to the webview guest", async () => {
  const { app, window, cleanup } = await launch();
  try {
    await runCommand(window, "Open web viewer");
    await expect(window.locator(".web-view-frame")).toBeVisible();
    await window.evaluate(async () => {
      const commands = (window as any).app.commands;
      await commands.setBindings("command-palette", [{ modifiers: ["Mod"], code: "KeyY" }]);
    });
    await window.waitForTimeout(100);
    expect(await pressInGuest(app, "p", [MOD])).toBe(true);
    await expect(window.locator(".prompt-input")).toHaveCount(0);
    expect(await pressInGuest(app, "y", [MOD])).toBe(true);
    await expect(window.locator(".prompt-input")).toBeVisible();
    await window.keyboard.press("Escape");

    // A manually introduced duplicate is omitted from the published set, so
    // main leaves the event in the guest instead of swallowing it.
    await window.evaluate(() => (window as any).app.commands.add({ id: "probe:duplicate-y", name: "Duplicate Y", hotkeys: [{ modifiers: ["Mod"], code: "KeyY" }], callback: () => {} }));
    await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview");
      return guest?.executeJavaScript("window.__geodeGuestKeys=0; window.addEventListener('keydown',()=>window.__geodeGuestKeys++)");
    });
    await window.waitForTimeout(100);
    expect(await pressInGuest(app, "y", [MOD])).toBe(true);
    await expect.poll(() => app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview");
      return guest?.executeJavaScript("window.__geodeGuestKeys") ?? 0;
    })).toBe(1);
    await expect(window.locator(".prompt-input")).toHaveCount(0);
  } finally {
    await app.close(); cleanup();
  }
});

test("an unbound combo inside a web viewer guest is left alone for the page", async () => {
  const { app, window, cleanup } = await launch();

  try {
    await runCommand(window, "Open web viewer");
    await expect(window.locator(".web-view-frame")).toBeVisible();
    const tabsBefore = await rootTabs(window).count();

    // Mod+A (Select All) and Mod+C (Copy) are not Geode commands; the bridge
    // must not swallow them or the page's own editing shortcuts break.
    expect(await pressInGuest(app, "a", [MOD])).toBe(true);
    expect(await pressInGuest(app, "c", [MOD])).toBe(true);
    // Plain typing must be untouched too: "w" alone is not "Mod+W".
    expect(await pressInGuest(app, "w", [])).toBe(true);

    await expect(window.locator(".web-view")).toHaveCount(1);
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
    await expect(window.locator(".prompt-input")).toHaveCount(0);
  } finally {
    await app.close();
    cleanup();
  }
});

test("Mod+W still closes a markdown tab from the host document", async () => {
  const { app, window, cleanup } = await launch();

  try {
    await window.locator('.nav-file-title[data-path="Note.md"]').click();
    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();
    const tabsBefore = await rootTabs(window).count();

    // A second tab, because closing the last one leaves an empty tab behind
    // and the count would not move.
    await runCommand(window, "New tab");
    await expect(rootTabs(window)).toHaveCount(tabsBefore + 1);
    await window.locator('.nav-file-title[data-path="Note.md"]').click();
    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();

    await window.keyboard.press(isMac ? "Meta+w" : "Control+w");

    await expect(rootTabs(window)).toHaveCount(tabsBefore, { timeout: 10_000 });
    expect(await windowCount(app)).toBe(1);
    expect(window.isClosed()).toBe(false);
  } finally {
    await app.close();
    cleanup();
  }
});
