import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("independent plugins activate in parallel under slow filesystem reads", async () => {
  test.setTimeout(20_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-plugin-parallel-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-plugin-parallel-vault-"));
  const ids = ["parallel-alpha", "parallel-beta", "parallel-gamma"];
  fs.writeFileSync(path.join(vaultPath, "Note.md"), "# Note\n");
  for (const id of ids) {
    const pluginDir = path.join(vaultPath, ".geode", "plugins", id);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      id, name: id, version: "1.0.0", minAppVersion: "0.1.0", description: "test", author: "test",
    }));
    fs.writeFileSync(path.join(pluginDir, "main.js"), `
      const { Plugin } = require('geode');
      module.exports = class extends Plugin { onload() { this.addRibbonIcon('box', '${id}', () => {}); } };
    `);
  }
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(ids));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));

  const launchedAt = Date.now();
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot,
    env: { ...process.env, GEODE_TEST_PLUGIN_IO_DELAY_MS: "1000" },
  });
  try {
    const window = await app.firstWindow();
    for (const id of ids) await expect(window.locator(`[aria-label="${id}"]`)).toBeVisible({ timeout: 7_000 });
    // Three phases (manifest, main.js, missing styles.css) at 1s each should
    // approach ~3s in parallel. The prior serialized loader required ~9s.
    expect(Date.now() - launchedAt).toBeLessThan(7_000);

    await window.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await window.locator(".vertical-tab-nav-item", { hasText: "Performance" }).click();
    const operations = window.locator(".performance-tab-table").first();
    await expect(operations).toContainText("plugin-read-filesystem:parallel-alpha:main.js");
    await expect(operations).toContainText("plugin-read-main-queue:parallel-beta:manifest.json");
    await expect(operations).toContainText("plugin-read-return-ipc:parallel-gamma:styles.css");
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
