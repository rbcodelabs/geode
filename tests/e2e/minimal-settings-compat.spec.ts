import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "minimal-settings-compat");

function installFixture(vaultDir: string, id: string, sourceDir: string) {
  const dest = path.join(vaultDir, ".geode", "plugins", id);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(dest, file));
  }
}

test("certified Minimal Settings slice renders, persists, and drives theme/font state", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-minimal-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-minimal-user-"));
  installFixture(vaultDir, "obsidian-minimal-settings", fixtureDir);
  const blockedDir = path.join(vaultDir, ".geode", "plugins", "untested-modern");
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, "manifest.json"), JSON.stringify({
    id: "untested-modern", name: "Untested Modern", version: "1.0.0", minAppVersion: "1.13.0",
    description: "Must remain blocked", author: "tests",
  }));
  fs.writeFileSync(path.join(blockedDir, "main.js"), "throw new Error('must not execute')");
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([
    "obsidian-minimal-settings", "untested-modern",
  ]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  let app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const consoleErrors: string[] = [];
  try {
    const window = await app.firstWindow();
    window.on("console", (msg) => { if (msg.type() === "error" && !msg.text().includes("untested-modern")) consoleErrors.push(msg.text()); });
    window.on("pageerror", (error) => consoleErrors.push(String(error)));
    await expect(window.locator("body.minimal-theme")).toHaveCount(1, { timeout: 15_000 });
    const state = await window.evaluate(() => {
      const app = (window as any).app;
      return {
        enabled: app.pluginManager.isEnabled("obsidian-minimal-settings"),
        error: app.pluginManager.getLoadError("obsidian-minimal-settings"),
        blocked: app.pluginManager.isEnabled("untested-modern"),
        blockedError: app.pluginManager.getLoadError("untested-modern"),
      };
    });
    expect(state).toMatchObject({ enabled: true, error: undefined, blocked: false });
    expect(state.blockedError).toContain("requires Geode 1.13.0+");

    await window.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await window.locator(".vertical-tab-nav-item", { hasText: "Minimal Theme Settings" }).click();
    await expect(window.locator(".setting-item-group-heading", { hasText: "Features" })).toBeVisible();
    const toggleRow = window.locator(".setting-item", { hasText: "Text labels for primary navigation" });
    await toggleRow.locator('[role="switch"]').click();
    await expect(window.locator("body.labeled-nav")).toHaveCount(1);

    const dropdownRow = window.locator(".setting-item", { hasText: "Light mode background contrast" });
    await dropdownRow.locator("select.dropdown").selectOption("minimal-light-tonal");
    await expect(window.locator("body.minimal-light-tonal")).toHaveCount(1);

    const slider = window.locator('.setting-item:has-text("Small font size") input.slider');
    await slider.fill("17");
    await slider.dispatchEvent("input");
    await expect(window.locator('.setting-item:has-text("Small font size") .slider-value')).toHaveText("17");
    await expect.poll(() => window.evaluate(() => getComputedStyle(document.body).getPropertyValue("--font-ui-small").trim())).toBe("17px");

    await window.evaluate(() => {
      const app = (window as any).app;
      app.commands.execute("obsidian-minimal-settings:toggle-minimal-light-white");
    });
    await expect(window.locator("body.theme-light.minimal-light-white")).toHaveCount(1);
    await expect.poll(() => window.evaluate(() => (window as any).app.vault.getConfig("theme"))).toBe("moonstone");

    await window.evaluate(() => {
      const app = (window as any).app;
      app.commands.execute("obsidian-minimal-settings:toggle-minimal-dark-black");
      app.commands.execute("obsidian-minimal-settings:increase-body-font-size");
    });
    await expect(window.locator("body.theme-dark.minimal-dark-black")).toHaveCount(1);
    await expect.poll(() => window.evaluate(() => (window as any).app.vault.getConfig("theme"))).toBe("obsidian");
    await expect.poll(() => window.evaluate(() => getComputedStyle(document.body).getPropertyValue("--font-text-size").trim())).toBe("16.5px");
    await expect.poll(() => window.evaluate(() => (window as any).app.vault.getConfig("baseFontSize"))).toBe(16.5);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "plugins", "obsidian-minimal-settings", "data.json"), "utf8")).textSmall).toBe(17);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "plugins", "obsidian-minimal-settings", "data.json"), "utf8")).textNormal).toBe(16.5);

    await window.locator(".mod-settings").screenshot({ path: path.join(repoRoot, "docs", "screenshots", "minimal-settings-compat.png") });

    // Persist a non-default theme so a restart that silently restores defaults fails.
    await window.evaluate(() => (window as any).app.commands.execute("obsidian-minimal-settings:toggle-minimal-light-white"));
    await expect(window.locator("body.theme-light.minimal-light-white")).toHaveCount(1);
    await dropdownRow.locator("select.dropdown").selectOption("minimal-light-tonal");
    await expect(window.locator("body.minimal-light-tonal")).toHaveCount(1);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "plugins", "obsidian-minimal-settings", "data.json"), "utf8"))).toMatchObject({
      labeledNav: true, lightStyle: "minimal-light-tonal", darkStyle: "minimal-dark-black", textSmall: 17, textNormal: 16.5,
    });
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "app.json"), "utf8"))).toMatchObject({
      theme: "light", baseFontSize: 16.5,
    });

    await app.close();
    app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    const restoredWindow = await app.firstWindow();
    restoredWindow.on("console", (msg) => { if (msg.type() === "error" && !msg.text().includes("untested-modern")) consoleErrors.push(msg.text()); });
    restoredWindow.on("pageerror", (error) => consoleErrors.push(String(error)));
    await expect(restoredWindow.locator("body.minimal-theme.theme-light.labeled-nav.minimal-light-tonal")).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => restoredWindow.evaluate(() => {
      const app = (window as any).app;
      return {
        enabled: app.pluginManager.isEnabled("obsidian-minimal-settings"),
        theme: app.vault.getConfig("theme"),
        baseFontSize: app.vault.getConfig("baseFontSize"),
        fontSize: getComputedStyle(document.body).getPropertyValue("--font-text-size").trim(),
        smallFontSize: getComputedStyle(document.body).getPropertyValue("--font-ui-small").trim(),
      };
    })).toEqual({ enabled: true, theme: "moonstone", baseFontSize: 16.5, fontSize: "16.5px", smallFontSize: "17px" });

    await restoredWindow.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await restoredWindow.locator(".vertical-tab-nav-item", { hasText: "Minimal Theme Settings" }).click();
    await expect(restoredWindow.locator('.setting-item:has-text("Text labels for primary navigation") [role="switch"]')).toHaveAttribute("aria-checked", "true");
    await expect(restoredWindow.locator('.setting-item:has-text("Light mode background contrast") select.dropdown')).toHaveValue("minimal-light-tonal");
    await expect(restoredWindow.locator('.setting-item:has-text("Dark mode background contrast") select.dropdown')).toHaveValue("minimal-dark-black");
    await expect(restoredWindow.locator('.setting-item:has-text("Small font size") input.slider')).toHaveValue("17");
    await expect(restoredWindow.locator('.setting-item:has-text("Small font size") .slider-value')).toHaveText("17");
    await restoredWindow.locator('.setting-item:has-text("Text labels for primary navigation")').scrollIntoViewIfNeeded();
    await restoredWindow.locator(".mod-settings").screenshot({ path: path.join(repoRoot, "docs", "screenshots", "minimal-settings-compat-restart.png") });
    await restoredWindow.locator('.setting-item:has-text("Small font size")').scrollIntoViewIfNeeded();
    await restoredWindow.locator(".mod-settings").screenshot({ path: path.join(repoRoot, "docs", "screenshots", "minimal-settings-compat-restart-typography.png") });
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
