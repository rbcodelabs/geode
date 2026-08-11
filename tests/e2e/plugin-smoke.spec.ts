import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "sample-plugin",
  name: "Sample Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "A minimal plugin used by the e2e smoke test.",
  author: "geode",
};

/** Real CommonJS-style main.js, exactly as a plugin author would ship it (require('geode')). */
const MAIN_JS = `
  const { Plugin } = require('geode');

  module.exports.default = class SamplePlugin extends Plugin {
    async onload() {
      this.app.notify('sample-plugin loaded');
      await this.saveData({ loadedAt: 'test' });
      this.addCommand({
        id: 'say-hello',
        name: 'Say hello',
        callback: () => this.app.notify('hello from sample-plugin'),
      });
    }
    onunload() {
      this.app.notify('sample-plugin unloaded');
    }
  };
`;

/**
 * Boots the built app into a fresh temp vault seeded with a single real
 * plugin (manifest.json + main.js under .geode/plugins/) that is already
 * enabled via .geode/plugins.json, mirroring how PluginManager persists
 * enabled state. Verifies the full plugin-layer wiring end to end: discovery,
 * CJS-style `require('geode')` loading, onload() running against the real
 * `App`/`Plugin` API surface, and data.json persistence.
 */
test("discovers, enables, and runs a real plugin from disk on vault open", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-plugin-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-plugin-e2e-"));

  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "sample-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["sample-plugin"])
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const consoleErrors: string[] = [];
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    // onload() ran against the real App instance and called app.notify().
    await expect(window.locator(".notice", { hasText: "sample-plugin loaded" })).toBeVisible();

    // saveData() persisted to the plugin's own data.json on disk.
    await expect
      .poll(() => fs.existsSync(path.join(pluginDir, "data.json")))
      .toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(pluginDir, "data.json"), "utf8"));
    expect(data).toEqual({ loadedAt: "test" });

    // addCommand() registered into the shared command registry, prefixed
    // with the plugin id, and is actually invokable end to end.
    const ran = await window.evaluate(() =>
      (window as any).app.commands.execute("sample-plugin:say-hello")
    );
    expect(ran).toBe(true);
    await expect(window.locator(".notice", { hasText: "hello from sample-plugin" })).toBeVisible();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
