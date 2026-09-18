import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const PLUGIN_MAIN = `
  const obsidian = require('obsidian');
  const VIEW = 'pinned-probe';
  class PinnedProbeView extends obsidian.ItemView {
    getViewType() { return VIEW; }
    getDisplayText() { return 'Pinned Probe'; }
    getIcon() { return 'panel-top'; }
    async onOpen() { this.contentEl.createDiv({ cls: 'pinned-probe-body', text: 'plugin-view-ok' }); }
  }
  module.exports.default = class extends obsidian.Plugin {
    async onload() { this.registerView(VIEW, (leaf) => new PinnedProbeView(leaf)); }
  };
`;

function makeVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-pinned-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-pinned-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Destination.md"), "# Destination\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "pinned-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "pinned-probe",
    name: "Pinned Probe",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    description: "Pinned tab compatibility probe",
    author: "geode",
  }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), PLUGIN_MAIN);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["pinned-probe"]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultDir],
    lastVault: vaultDir,
  }));
  return { vaultDir, userDataDir };
}

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
}

/**
 * Block until plugin view types exist.
 *
 * A rendered file explorer does NOT mean plugins have loaded:
 * `App.openVaultMeasured` adds `FileExplorerView` and only then does a long
 * stretch of async startup (dynamic `bookmarks-view` import, web-viewer
 * lifecycle, built-in view factories) before `pluginManager.initialize()`
 * awaits each enabled plugin's `onload()` — which is where this spec's
 * fixture plugin calls `registerView("pinned-probe", ...)`. Gating on the nav
 * item alone therefore races plugin registration, and `setViewState()` throws
 * `No view registered for type "pinned-probe"` whenever the host is slow
 * enough to lose it (reliably on CI's macos-latest runner, never on a fast
 * dev machine).
 *
 * `workspace.layoutReady` is flipped by `flushLayoutReady()` strictly after
 * plugin init and layout restore, so it is the correct gate — and the one the
 * rest of the e2e suite already uses.
 */
function waitForLayoutReady(win: Page): Promise<unknown> {
  return win.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
}

test("pins a hosted plugin tab from its context menu, protects navigation, and restores it", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  let app = await launch(userDataDir);
  try {
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Destination.md"]')).toBeVisible();
    await waitForLayoutReady(win);

    await win.evaluate(async () => {
      const workspace = (window as any).app.workspace;
      const leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: "pinned-probe", active: true });
    });
    const pluginTab = win.locator(".workspace-split.mod-root .workspace-tab-header", { hasText: "Pinned Probe" });
    await expect(pluginTab).toBeVisible();

    await pluginTab.click({ button: "right" });
    const pinItem = win.locator(".menu-item", { hasText: "Pin" });
    await expect(pinItem).toBeVisible();
    if (screenshotDir) await win.screenshot({ path: path.join(screenshotDir, "pinned-tab-context-menu.png") });
    await pinItem.click();
    await expect(pluginTab).toHaveClass(/mod-pinned/);
    await expect(pluginTab.locator(".workspace-tab-header-status-icon.mod-pinned")).toBeVisible();
    if (screenshotDir) await win.screenshot({ path: path.join(screenshotDir, "pinned-tab-active.png") });

    const apiState = await win.evaluate(() => {
      const leaf = (window as any).app.workspace.getLeavesOfType("pinned-probe")[0];
      leaf.setPinned(false);
      leaf.togglePinned();
      return leaf.pinned;
    });
    expect(apiState).toBe(true);
    await expect(pluginTab).toHaveClass(/mod-pinned/);

    await win.evaluate(async () => {
      const a = (window as any).app;
      await a.workspace.openLinkText("Destination", "", false);
    });
    // Pin protection sent the link to a different tab, so the plugin view must
    // no longer be the one on screen. It is still *mounted* — a background tab
    // now stays in the document and is hidden rather than detached, which is
    // what stops a tab switch from tearing its view down — so the assertion is
    // "not the visible leaf", not "not in the DOM".
    await expect(win.locator(".workspace-split.mod-root .workspace-leaf.mod-active .pinned-probe-body")).toHaveCount(0);
    await expect(win.locator(".workspace-tab-container .pinned-probe-body")).toBeHidden();
    await expect(pluginTab).toHaveClass(/mod-pinned/);
    await expect(win.locator(".workspace-split.mod-root .workspace-tab-header", { hasText: "Destination" })).toBeVisible();
    expect(await win.evaluate(() => (window as any).app.workspace.getLeavesOfType("pinned-probe").length)).toBe(1);

    await expect.poll(() => {
      const file = path.join(vaultDir, ".geode", "workspace.json");
      if (!fs.existsSync(file)) return false;
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const groups = saved.version === 2 || saved.version === 3
        ? (saved.center.root.type === "split" ? saved.center.root.children : [saved.center.root])
        : saved.groups;
      return groups
        .flatMap((group: any) => group.leaves ?? [])
        .some((leaf: any) => leaf.type === "pinned-probe" && leaf.pinned === true);
    }, { timeout: 4000 }).toBe(true);
    await app.close();

    app = await launch(userDataDir);
    win = await app.firstWindow();
    // Same race on the restore path: until plugin init runs, the saved
    // "pinned-probe" leaf resolves to a DeferredView placeholder rather than
    // the real view, so its tab header has no "Pinned Probe" text to match.
    // layoutReady also covers hydrateDeferredLeaves(), which is what swaps the
    // placeholder for the plugin's view.
    await waitForLayoutReady(win);
    const restoredPluginTab = win.locator(".workspace-split.mod-root .workspace-tab-header", { hasText: "Pinned Probe" });
    await expect(restoredPluginTab).toHaveClass(/mod-pinned/);
    await restoredPluginTab.click({ button: "right" });
    const unpinItem = win.locator(".menu-item", { hasText: "Unpin" });
    await expect(unpinItem).toBeVisible();
    await unpinItem.click();
    await expect(restoredPluginTab).not.toHaveClass(/mod-pinned/);
    await expect(restoredPluginTab.locator(".workspace-tab-header-status-icon.mod-pinned")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
