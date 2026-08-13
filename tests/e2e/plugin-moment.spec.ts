import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "moment-plugin",
  name: "Moment Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Reproduces GitHub issue #21: plugins that touch moment at module-instantiation time.",
  author: "geode",
};

/**
 * Mirrors the issue's exact repro (diagram-zoom-drag): `R.moment.locale()`
 * called at module scope — before onload() — where `R` is the
 * `require('obsidian')` shim, plus a direct `window.moment` module-scope
 * reference (the issue also flags `window.moment` as undefined). Before the
 * fix, either of these would throw `TypeError: Cannot read properties of
 * undefined (reading 'locale')` and the plugin would never enable.
 */
const MAIN_JS = `
  const R = require('obsidian');

  // Module-scope side effect, executed at require() time, before onload().
  if (typeof window.moment !== 'function') {
    throw new Error('window.moment is not a function at module scope');
  }
  R.moment.locale();

  module.exports.default = class MomentPlugin extends R.Plugin {
    async onload() {
      this.app.notify('moment-plugin loaded');
    }
  };
`;

test("enables a plugin that touches moment at module scope (require('obsidian').moment and window.moment)", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-moment-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-moment-e2e-"));

  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "moment-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["moment-plugin"])
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

    // The plugin's module-scope moment calls didn't throw during
    // instantiatePluginClass, so onload() ran and called app.notify().
    await expect(window.locator(".notice", { hasText: "moment-plugin loaded" })).toBeVisible();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
