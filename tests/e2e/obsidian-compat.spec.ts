import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "obsidian-compat-probe",
  name: "Obsidian Compat Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises Geode's Obsidian-compatibility surface.",
  author: "geode",
};

/**
 * A plugin written exactly like a real Obsidian plugin — `require('obsidian')`,
 * an `ItemView` subclass, Obsidian DOM helpers (`createEl`/`createDiv`), a
 * Node builtin (`require('os')`), `instanceof TFile`, and `app.secretStorage`.
 * If this loads and its view renders, Geode's plugin host is faithfully
 * emulating the Obsidian runtime contract (the same one Claude Threads needs).
 */
const MAIN_JS = `
  const obsidian = require('obsidian');
  const os = require('os'); // Node builtin must resolve via the real require
  const VIEW_TYPE = 'compat-probe-view';

  class ProbeView extends obsidian.ItemView {
    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'Compat Probe'; }
    async onOpen() {
      const wrap = this.contentEl.createDiv({ cls: 'probe-wrap' });
      wrap.createEl('h2', { text: 'probe-ok' });
      wrap.createEl('div', { cls: 'probe-host', text: 'host:' + os.hostname().length });
      // instanceof against a real vault file object
      const f = this.app.vault.getMarkdownFiles()[0];
      wrap.createEl('div', { cls: 'probe-instanceof', text: 'isTFile:' + (f instanceof obsidian.TFile) });
      // secretStorage round-trips synchronously
      this.app.secretStorage.setSecret('probe-key', 'sekret');
      const got = this.app.secretStorage.getSecret('probe-key');
      wrap.createEl('div', { cls: 'probe-secret', text: 'secret:' + got });
    }
  }

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      new obsidian.Notice('probe loaded');
      this.registerView(VIEW_TYPE, (leaf) => new ProbeView(leaf));
      this.addRibbonIcon('message-square', 'Open probe', async () => {
        const leaf = this.app.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
      });
    }
  };
`;

test("hosts a real-shaped Obsidian plugin: require('obsidian') + Node builtin + ItemView + DOM helpers", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-compat-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-compat-ud-"));
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "obsidian-compat-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(pluginDir, "styles.css"), ".probe-wrap { padding: 8px; }");
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["obsidian-compat-probe"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const consoleErrors: string[] = [];
  try {
    const window = await app.firstWindow();
    window.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    window.on("pageerror", (e) => consoleErrors.push(String(e)));

    // Plugin loaded and onload() completed (Notice shown), no load error.
    await expect(window.locator(".notice", { hasText: "probe loaded" })).toBeVisible();
    const loadError = await window.evaluate(
      () => (window as any).app.pluginManager.getLoadError("obsidian-compat-probe") ?? null
    );
    expect(loadError).toBeNull();

    // Plugin actions live in a shell-owned left ribbon. The action keeps
    // button semantics/tooltips and remains visible when the left sidebar is
    // collapsed; clicking it invokes the plugin callback.
    const ribbon = window.locator(".workspace-ribbon.mod-left");
    const ribbonActions = ribbon.locator(".workspace-ribbon-actions");
    const probeAction = ribbonActions.getByRole("button", { name: "Open probe" });
    await expect(ribbon).toBeVisible();
    await expect(probeAction).toHaveAttribute("title", "Open probe");

    await window.evaluate(() => {
      const ws = (window as any).app.workspace;
      if (!ws.leftSidebar.collapsed) ws.leftSidebar.toggle();
    });
    await expect(window.locator(".workspace-sidebar.mod-left")).toHaveClass(/is-collapsed/);
    await expect(probeAction).toBeVisible();
    await probeAction.click();
    await expect(window.locator(".workspace-sidebar.mod-right .probe-wrap")).toBeVisible();

    // Settings is a persistent bottom action and opens the existing Settings
    // modal rather than a second settings surface.
    const settingsAction = ribbon.locator(".workspace-ribbon-bottom").getByRole("button", {
      name: "Open settings",
    });
    await expect(settingsAction).toBeVisible();
    await settingsAction.click();
    await expect(window.locator(".modal.mod-settings")).toBeVisible();
    await expect(window.locator(".vertical-tab-nav-item", { hasText: "Appearance" })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.locator(".modal.mod-settings")).toHaveCount(0);

    if (screenshotDir) {
      const browserWindow = await app.browserWindow(window);
      await browserWindow.evaluate((win: any) => win.setSize(900, 700));
      await expect.poll(() => window.evaluate(() => innerWidth)).toBeLessThan(920);
      await window.screenshot({ path: path.join(screenshotDir, "left-ribbon-small.png") });
      await browserWindow.evaluate((win: any) => win.maximize());
      await expect.poll(() => window.evaluate(() => innerWidth)).toBeGreaterThan(920);
      await window.screenshot({ path: path.join(screenshotDir, "left-ribbon-maximized.png") });
      console.log(`[obsidian-compat] screenshots written to: ${screenshotDir}`);
    }

    // Its stylesheet was injected (Obsidian auto-loads plugin styles.css).
    await expect(
      window.locator('style[data-plugin-id="obsidian-compat-probe"]')
    ).toHaveCount(1);

    // Open the plugin's ItemView the way a real Obsidian plugin does —
    // getRightLeaf() + setViewState() + revealLeaf() — and verify it DOCKS
    // IN THE RIGHT SIDEBAR (not the main tab area), rendered via the DOM
    // helpers, with the Node builtin resolved, instanceof TFile working
    // against a real vault file, and secretStorage round-tripping.
    const docked = await window.evaluate(async () => {
      const ws = (window as any).app.workspace;
      const leaf = ws.getLeavesOfType("compat-probe-view")[0];
      return leaf.group?.constructor?.name; // should be "Sidebar"
    });
    expect(docked).toBe("Sidebar");

    // The rendered pane lives inside the right sidebar, not a main-area tab.
    const rightPane = window.locator(".workspace-sidebar.mod-right .sidebar-content .probe-wrap");
    await expect(rightPane).toBeVisible();
    await expect(rightPane.locator("h2")).toHaveText("probe-ok");
    await expect(
      window.locator(".workspace-tab-container .probe-wrap")
    ).toHaveCount(0); // definitely not in the main tab area
    await expect(window.locator(".probe-instanceof")).toHaveText("isTFile:true");
    await expect(window.locator(".probe-secret")).toHaveText("secret:sekret");
    // os.hostname() returned a non-empty string via the real Node require.
    await expect(window.locator(".probe-host")).not.toHaveText("host:0");

    // getLeavesOfType() sees the docked sidebar leaf (so plugins don't
    // reopen a pane they've already docked).
    const leafCount = await window.evaluate(
      () => (window as any).app.workspace.getLeavesOfType("compat-probe-view").length
    );
    expect(leafCount).toBe(1);

    // Component cleanup registered by Plugin.addRibbonIcon removes the same
    // element from the host when the plugin is disabled.
    await window.evaluate(() =>
      (window as any).app.pluginManager.disable("obsidian-compat-probe", { persist: false })
    );
    await expect(probeAction).toHaveCount(0);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("hides and restores the ribbon without unloading plugin actions, and persists the choice", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-ribbon-settings-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-ribbon-settings-ud-"));
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "obsidian-compat-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["obsidian-compat-probe"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const launch = () =>
    electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  let app = await launch();
  try {
    let window = await app.firstWindow();
    const ribbon = window.locator(".workspace-ribbon.mod-left");
    const probeAction = ribbon.locator('button[aria-label="Open probe"]');
    await expect(ribbon).toBeVisible();
    await expect(probeAction).toBeVisible();

    await ribbon.getByRole("button", { name: "Open settings" }).click();
    const showRibbonRow = window.locator(".setting-item", { hasText: "Show ribbon" });
    const showRibbonToggle = showRibbonRow.locator('input[type="checkbox"]');
    await expect(showRibbonToggle).toBeChecked();
    await showRibbonToggle.uncheck();

    await expect(ribbon).toBeHidden();
    await expect(probeAction).toHaveCount(1);
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "left-ribbon-hidden-setting.png") });
    }
    await expect
      .poll(() =>
        JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "app.json"), "utf8")).showRibbon
      )
      .toBe(false);

    await app.close();
    app = await launch();
    window = await app.firstWindow();
    const relaunchedRibbon = window.locator(".workspace-ribbon.mod-left");
    await expect(relaunchedRibbon).toBeHidden();
    const relaunchedProbeAction = relaunchedRibbon.locator('button[aria-label="Open probe"]');
    await expect(relaunchedProbeAction).toHaveCount(1);

    await window.evaluate(() => (window as any).app.setting.open());
    const relaunchedToggle = window
      .locator(".setting-item", { hasText: "Show ribbon" })
      .locator('input[type="checkbox"]');
    await expect(relaunchedToggle).not.toBeChecked();
    await relaunchedToggle.check();
    await expect(relaunchedRibbon).toBeVisible();
    await expect(relaunchedProbeAction).toBeVisible();
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "left-ribbon-restored-setting.png") });
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
