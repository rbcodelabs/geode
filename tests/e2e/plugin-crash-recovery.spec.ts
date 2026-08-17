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
    const { Plugin } = require('geode');
    module.exports = class extends Plugin { onload(){ globalThis.__probeLoads = (globalThis.__probeLoads || 0) + 1; } };
  `);

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    expect(await window.evaluate(() => (window as any).app.pluginManager.isEnabled("loaded-probe"))).toBe(true);

    const replacementPromise = app.waitForEvent("window");
    await window.evaluate(() => {
      console.error("geode-e2e-before-controlled-crash");
      process.crash();
    }).catch(() => {});
    const recoveredWindow = await replacementPromise;
    await expect(recoveredWindow.locator(".crash-recovery-banner")).toBeVisible({ timeout: 10_000 });

    expect(await recoveredWindow.evaluate(() => (window as any).app.pluginManager.isRecoveryMode())).toBe(true);
    expect(await recoveredWindow.evaluate(() => (window as any).app.pluginManager.isEnabled("loaded-probe"))).toBe(false);
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
