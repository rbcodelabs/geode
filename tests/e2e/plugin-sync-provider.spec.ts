import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("a Geode plugin provides full-vault sync through the built-in approval UI", async ({}, testInfo) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-user-"));
  fs.writeFileSync(path.join(vaultDir, "Local.md"), "local");
  fs.writeFileSync(path.join(vaultDir, "Conflict.md"), "local conflict");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "sync-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id: "sync-probe", name: "Sync Probe", version: "1.0.0", minAppVersion: "0.1.0", description: "Sync contract fixture", author: "Geode" }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), `
    const { Plugin } = require('geode');
    module.exports.default = class extends Plugin {
      onload() {
        this.registerSyncProvider({
          id: 'probe.remote', name: 'Probe Remote',
          capabilities: { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true },
          open: async () => ({
            scan: async () => ({ status: 'complete', mode: 'snapshot', cursor: 'first', entries: [{ id: 'r1', path: 'Remote.md', kind: 'file', revision: '1', size: 6 }, { id: 'r2', path: 'Conflict.md', kind: 'file', revision: '1', size: 6 }] }),
            read: async () => new TextEncoder().encode('remote').buffer,
            create: async ({ path, data, operationKey }) => ({ id: 'new:' + path, path, kind: 'file', revision: '1', size: data.byteLength, operationKey }),
            update: async ({ id, path, data, operationKey }) => ({ id, path, kind: 'file', revision: '2', size: data.byteLength, operationKey }),
            move: async () => {}, trash: async () => {}, close: async () => {},
          }),
        });
      }
    };
  `);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["sync-probe"]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => Boolean((window as any).app?.workspace));
    expect(await window.evaluate(() => (window as any).app.pluginManager?.getLoadError("sync-probe") ?? null)).toBeNull();
    await expect.poll(() => window.evaluate(() => ({ providers: (window as any).app?.sync?.listProviders().length, enabled: (window as any).app?.pluginManager?.isEnabled("sync-probe"), manifests: [...((window as any).app?.pluginManager?.manifests?.keys?.() ?? [])] }))).toEqual({ providers: 1, enabled: true, manifests: ["sync-probe"] });
    await window.evaluate(() => (window as any).app.setting.openTabById("sync"));
    const modal = window.locator('.modal.mod-settings[aria-label="Settings"]');
    await expect(modal.getByRole("heading", { name: "Sync" })).toBeVisible();
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("probe.remote");
    await modal.getByRole("button", { name: "Preview" }).click();
    await expect(modal).toContainText("1 upload, 1 download, 0 deletions, 1 conflict");
    expect(fs.existsSync(path.join(vaultDir, "Remote.md"))).toBe(false);
    await modal.getByRole("button", { name: "Approve & sync" }).click();
    await expect.poll(() => fs.existsSync(path.join(vaultDir, "Remote.md"))).toBe(true);
    expect([...fs.readFileSync(path.join(vaultDir, "Remote.md"))]).toEqual([...Buffer.from("remote")]);
    expect(fs.existsSync(path.join(vaultDir, ".geode", "sync"))).toBe(false);
    const conflict = modal.locator('[data-sync-conflict]');
    await expect(conflict).toContainText("Conflict.md");
    await expect(conflict.getByRole("button", { name: "Keep local" })).toBeVisible();
    await window.setViewportSize({ width: 800, height: 650 });
    await window.screenshot({ path: testInfo.outputPath("sync-conflict-small.png") });
    await window.setViewportSize({ width: 1440, height: 1000 });
    await window.screenshot({ path: testInfo.outputPath("sync-conflict-large.png") });
    await conflict.getByRole("button", { name: "Accept remote" }).click();
    await expect(conflict).toHaveCount(0);
    expect(fs.readFileSync(path.join(vaultDir, "Conflict.md"), "utf8")).toBe("remote");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
