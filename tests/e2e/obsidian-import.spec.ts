import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Verifies the "Import from an existing .obsidian/ vault" flow end to end
 * (roadmap item 87c6f0de). Seeds a vault with an Obsidian `.obsidian/` folder —
 * an enabled community plugin, an active theme, plus Obsidian's
 * community-plugins.json / appearance.json — then runs the import command and
 * asserts the plugin + theme land in `.geode/`, the plugin is enabled, and the
 * theme is applied. No network: this is a pure local copy.
 */

const PLUGIN_MANIFEST = {
  id: "sample-plugin",
  name: "Sample Imported Plugin",
  version: "1.2.3",
  minAppVersion: "0.0.1",
  description: "A sample plugin imported from an Obsidian vault in an e2e test.",
  author: "geode-tests",
};
const PLUGIN_MAIN_JS = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  onload() { console.log("obsidian-import sample plugin loaded"); }
};
`;
const THEME_MANIFEST = { name: "Sample Theme", version: "1.0.0", author: "geode-tests" };
const THEME_CSS = ":root { --sample-import-marker: 1; }\n";

function seedObsidianVault(): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-obsidian-import-"));
  const obs = path.join(vaultPath, ".obsidian");

  const pluginDir = path.join(obs, "plugins", "sample-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(PLUGIN_MANIFEST));
  fs.writeFileSync(path.join(pluginDir, "main.js"), PLUGIN_MAIN_JS);
  fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({ hello: "world" }));

  const themeDir = path.join(obs, "themes", "Sample Theme");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, "theme.css"), THEME_CSS);
  fs.writeFileSync(path.join(themeDir, "manifest.json"), JSON.stringify(THEME_MANIFEST));

  // Obsidian's own enabled-plugins list + active-theme selection.
  fs.writeFileSync(path.join(obs, "community-plugins.json"), JSON.stringify(["sample-plugin"]));
  fs.writeFileSync(path.join(obs, "appearance.json"), JSON.stringify({ cssTheme: "Sample Theme" }));

  return vaultPath;
}

async function launchApp(vaultPath: string): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath })
  );
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  return { app, window, userDataDir, consoleErrors };
}

test("imports plugins & themes from an existing .obsidian/ folder", async () => {
  const vaultPath = seedObsidianVault();
  const { app, window, userDataDir, consoleErrors } = await launchApp(vaultPath);

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    await window.evaluate(() =>
      (window as unknown as { app: any }).app.commands.execute("community-import-obsidian")
    );

    // Plugin files copied into .geode/plugins/ (including data.json).
    const pluginDir = path.join(vaultPath, ".geode", "plugins", "sample-plugin");
    await expect
      .poll(() => fs.existsSync(path.join(pluginDir, "main.js")), { timeout: 5000 })
      .toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "data.json"))).toBe(true);

    // Theme files copied into .geode/themes/<name>/.
    const themeDir = path.join(vaultPath, ".geode", "themes", "Sample Theme");
    expect(fs.existsSync(path.join(themeDir, "theme.css"))).toBe(true);
    expect(fs.existsSync(path.join(themeDir, "manifest.json"))).toBe(true);

    // The plugin is enabled and persisted to .geode/plugins.json.
    await expect
      .poll(
        () =>
          window.evaluate(() =>
            (window as unknown as { app: any }).app.pluginManager.isEnabled("sample-plugin")
          ),
        { timeout: 5000 }
      )
      .toBe(true);
    const enabled = JSON.parse(
      fs.readFileSync(path.join(vaultPath, ".geode", "plugins.json"), "utf8")
    );
    expect(enabled).toContain("sample-plugin");

    // The theme Obsidian had active is applied.
    const active = await window.evaluate(() =>
      (window as unknown as { app: any }).app.themeManager.activeTheme
    );
    expect(active).toBe("Sample Theme");
    await expect(window.locator("style#geode-community-theme")).toHaveCount(1);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
