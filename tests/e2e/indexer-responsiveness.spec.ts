import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function fixture(noteCount: number, pluginMain?: string) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-indexer-latency-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-indexer-latency-vault-"));
  for (let index = 0; index < noteCount; index += 1) {
    fs.writeFileSync(path.join(vaultPath, `Note-${String(index).padStart(4, "0")}.md`), `# Note ${index}\n`);
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  if (pluginMain) {
    const pluginDir = path.join(vaultPath, ".geode", "plugins", "blocking-probe");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(["blocking-probe"]));
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      id: "blocking-probe", name: "Blocking probe", version: "1.0.0", minAppVersion: "0.1.0", description: "test", author: "test",
    }));
    fs.writeFileSync(path.join(pluginDir, "main.js"), pluginMain);
  }
  return { userDataDir, vaultPath };
}

test("slow main/utility filesystem work does not starve renderer heartbeats", async () => {
  test.setTimeout(60_000);
  const ribbonPlugin = `
    const { Plugin } = require('geode');
    module.exports = class extends Plugin { onload() {
      this.addRibbonIcon('bot', 'Latency probe', () => {});
      this.app.workspace.onLayoutReady(() => this.addRibbonIcon('check', 'Layout ready probe', () => {}));
    } };
  `;
  const { userDataDir, vaultPath } = fixture(250, ribbonPlugin);
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot,
    env: {
      ...process.env,
      GEODE_TEST_VAULT_IO_DELAY_MS: "50",
      GEODE_TEST_INDEXER_READ_DELAY_MS: "50",
      GEODE_TEST_HEARTBEAT_INTERVAL_MS: "100",
      GEODE_TEST_WATCHDOG_TIMEOUT_MS: "1000",
      GEODE_TEST_WATCHDOG_INTERVAL_MS: "100",
    },
  });
  const window = await app.firstWindow();
  try {
    await window.evaluate(() => {
      (window as any).__responsivenessTicks = 0;
      (window as any).__indexSnapshotComplete = false;
      window.geode.onMetadataIndexerMessage((message: any) => {
        if (message?.type === "snapshot-complete") (window as any).__indexSnapshotComplete = true;
      });
      setInterval(() => { (window as any).__responsivenessTicks += 1; }, 50);
    });
    // Plugin startup is gated by vault discovery, not metadata readiness. The
    // bounded-concurrency walk must keep the ribbon from inheriting the full
    // per-file latency even though utility indexing remains deliberately slow.
    await expect(window.locator('[aria-label="Latency probe"]')).toBeVisible({ timeout: 5_000 });
    expect(await window.evaluate(() => (window as any).__indexSnapshotComplete as boolean)).toBe(false);
    await expect(window.locator('[aria-label="Layout ready probe"]')).toBeVisible({ timeout: 2_000 });
    expect(await window.evaluate(() => (window as any).__indexSnapshotComplete as boolean)).toBe(false);
    await expect(window.locator('.nav-file-title[data-path="Note-0000.md"]')).toBeVisible({ timeout: 30_000 });
    const ticksBeforeIndex = await window.evaluate(() => (window as any).__responsivenessTicks as number);
    expect(await window.evaluate(() => window.geode.startMetadataIndexer())).toBe(true);
    const ticksAfterIndex = await window.evaluate(() => (window as any).__responsivenessTicks as number);
    expect(ticksAfterIndex - ticksBeforeIndex).toBeGreaterThan(100);
    const recovery = await window.evaluate(() => window.geode.getCrashRecoveryState());
    expect(recovery.suppressPlugins).toBe(false);
    expect(recovery.entries.filter((entry) => entry.type === "renderer-hang")).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test("control: watchdog detects renderer-blocking plugin work", async () => {
  test.setTimeout(20_000);
  const pluginMain = `
    const { Plugin } = require('geode');
    module.exports = class extends Plugin { onload() { const until = Date.now() + 1500; while (Date.now() < until) {} } };
  `;
  const { userDataDir, vaultPath } = fixture(1, pluginMain);
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot,
    env: {
      ...process.env,
      GEODE_TEST_HEARTBEAT_INTERVAL_MS: "100",
      GEODE_TEST_WATCHDOG_TIMEOUT_MS: "700",
      GEODE_TEST_WATCHDOG_INTERVAL_MS: "100",
    },
  });
  try {
    const initialWindow = await app.firstWindow();
    await initialWindow.waitForLoadState("domcontentloaded");
    const replacement = await app.waitForEvent("window", { timeout: 10_000 });
    await expect(replacement.locator(".crash-recovery-banner")).toBeVisible({ timeout: 5_000 });
    const recovery = await replacement.evaluate(() => window.geode.getCrashRecoveryState());
    expect(recovery.suppressPlugins).toBe(true);
    expect(recovery.entries).toEqual(expect.arrayContaining([expect.objectContaining({ type: "renderer-hang" })]));
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
