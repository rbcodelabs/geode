import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("a throwing plugin command quarantines only that plugin and Settings can restore it", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-recovery-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-recovery-vault-"));
  const pluginDir = path.join(vaultPath, ".geode", "plugins", "crashy");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(["crashy"]));
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "crashy", name: "Crashy", version: "1.0.0", minAppVersion: "0.1.0", description: "test", author: "test",
  }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), `
    const { Plugin } = require('geode');
    module.exports = class extends Plugin { onload(){ this.addCommand({ id:'boom', name:'Boom', callback(){ throw new Error('e2e boom'); } }); } };
  `);

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate(() => (window as any).app.commands.execute("crashy:boom"));
    await expect.poll(() => window.evaluate(() => (window as any).app.pluginManager.isEnabled("crashy"))).toBe(false);

    await window.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await window.locator(".vertical-tab-nav-item", { hasText: "Community plugins & themes" }).click();
    const row = window.locator('.plugin-quarantine-item[data-plugin-id="crashy"]');
    await expect(row).toContainText("e2e boom");
    await row.getByRole("button", { name: "Restore plugin" }).click();
    await expect.poll(() => window.evaluate(() => (window as any).app.pluginManager.isEnabled("crashy"))).toBe(true);
    await expect(row).toBeHidden();
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test("a crashed renderer journals evidence and reloads once with plugins suppressed", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-renderer-crash-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-renderer-crash-vault-"));
  const pluginDir = path.join(vaultPath, ".geode", "plugins", "loaded-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(["loaded-probe"]));
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "loaded-probe", name: "Loaded Probe", version: "1.0.0", minAppVersion: "0.1.0", description: "test", author: "test",
  }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), `
    const { Plugin, ItemView } = require('geode');
    const VIEW = 'probe-pane';
    class ProbeView extends ItemView {
      getViewType(){ return VIEW; }
      getDisplayText(){ return 'Probe Pane'; }
      getIcon(){ return 'star'; }
      getState(){ return this._state ?? {}; }
      async setState(state){ this._state = state; }
      async onOpen(){ this.contentEl.createEl('div', { cls: 'probe-pane-body', text: 'probe-pane-ok' }); }
    }
    module.exports = class extends Plugin {
      onload(){
        globalThis.__probeLoads = (globalThis.__probeLoads || 0) + 1;
        this.registerView(VIEW, (leaf) => new ProbeView(leaf));
      }
    };
  `);

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    expect(await window.evaluate(() => (window as any).app.pluginManager.isEnabled("loaded-probe"))).toBe(true);

    // Dock the plugin's pane and let the debounced layout save reach disk, so
    // the crash below happens with a real plugin pane in `workspace.json`.
    await window.evaluate(async () => {
      const a = (window as any).app;
      const leaf = a.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "probe-pane", active: true, state: { cursor: 5 } });
      a.workspace.revealLeaf(leaf);
    });
    await expect(window.locator(".workspace-sidebar.mod-right .probe-pane-body")).toBeVisible();
    const workspaceFile = path.join(vaultPath, ".geode", "workspace.json");
    await expect
      .poll(() => (fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, "utf8") : ""), { timeout: 5000 })
      .toContain("probe-pane");

    const replacementPromise = app.waitForEvent("window");
    await window.evaluate(() => {
      console.error("geode-e2e-before-controlled-crash");
      process.crash();
    }).catch(() => {});
    const recoveredWindow = await replacementPromise;
    await expect(recoveredWindow.locator(".crash-recovery-banner")).toBeVisible({ timeout: 10_000 });

    expect(await recoveredWindow.evaluate(() => (window as any).app.pluginManager.isRecoveryMode())).toBe(true);
    expect(await recoveredWindow.evaluate(() => (window as any).app.pluginManager.isEnabled("loaded-probe"))).toBe(false);

    // The root cause this whole change exists for: in recovery mode zero
    // plugin factories are registered, so restore could resolve nothing — and
    // the recovery launch's own layout save then rewrote `workspace.json` with
    // every plugin pane stripped, destroying the data before the user ever
    // clicked "Restart with plugins". The pane must survive as a placeholder,
    // and the file on disk must still describe it.
    const deferred = await recoveredWindow.evaluate(() => {
      const leaves = (window as any).app.workspace.getLeavesOfType("probe-pane");
      return {
        count: leaves.length,
        constructorName: leaves[0]?.view?.constructor?.name ?? null,
        state: leaves[0]?.getViewState()?.state ?? null,
      };
    });
    expect(deferred.count).toBe(1);
    expect(deferred.constructorName).toBe("DeferredView");
    expect(deferred.state).toEqual({ cursor: 5 });
    await recoveredWindow.waitForTimeout(900); // outlast the 400ms save debounce
    const persisted = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
    expect(JSON.stringify(persisted)).toContain('"probe-pane"');
    expect(JSON.stringify(persisted)).toContain('"cursor":5');
    await recoveredWindow.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await recoveredWindow.locator(".vertical-tab-nav-item", { hasText: "Performance" }).click();
    await expect(recoveredWindow.locator(".performance-tab-table").first()).toContainText("plugin-enable:loaded-probe");
    expect(JSON.parse(fs.readFileSync(path.join(vaultPath, ".geode", "plugins.json"), "utf8"))).toEqual(["loaded-probe"]);
    const journal = JSON.parse(fs.readFileSync(path.join(userDataDir, "crash-journal.json"), "utf8"));
    expect(journal.at(-1)).toMatchObject({
      type: "renderer-gone",
      activePlugins: ["loaded-probe"],
      incidentId: expect.any(String),
      appVersion: expect.any(String),
      electronVersion: expect.any(String),
      platform: process.platform,
    });
    expect(journal.at(-1).consoleEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "geode-e2e-before-controlled-crash" }),
    ]));
    expect(journal.at(-1).dumpFiles ?? []).toEqual(expect.any(Array));
    const diagnosticLog = fs.readFileSync(path.join(userDataDir, "diagnostic.log"), "utf8");
    expect(diagnosticLog).toContain("geode-e2e-before-controlled-crash");
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
