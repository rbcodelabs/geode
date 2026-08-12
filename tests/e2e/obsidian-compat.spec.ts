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
      this.addRibbonIcon('dice', 'Open probe', async () => {
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

    // Its stylesheet was injected (Obsidian auto-loads plugin styles.css).
    await expect(
      window.locator('style[data-plugin-id="obsidian-compat-probe"]')
    ).toHaveCount(1);

    // Open the plugin's ItemView and verify it rendered via the DOM helpers,
    // that the Node builtin resolved, that instanceof TFile works against a
    // real vault file, and that secretStorage round-tripped synchronously.
    await window.evaluate(async () => {
      const leaf = await (window as any).app.workspace.openViewOfType("compat-probe-view", true);
      return !!leaf;
    });
    await expect(window.locator(".probe-wrap h2")).toHaveText("probe-ok");
    await expect(window.locator(".probe-instanceof")).toHaveText("isTFile:true");
    await expect(window.locator(".probe-secret")).toHaveText("secret:sekret");
    // os.hostname() returned a non-empty string via the real Node require.
    await expect(window.locator(".probe-host")).not.toHaveText("host:0");

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
