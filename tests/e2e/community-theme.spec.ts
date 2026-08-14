import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

// A tiny but real community-theme layout: <name>/theme.css + manifest.json,
// overriding a couple of the shared CSS variables under .theme-dark.
const THEME_CSS = `
.theme-dark {
  --accent-h: 12;
  --interactive-accent: #ff5a3c;
  --background-primary: #101418;
}
/* Real community themes (Minimal, AnuPpuccin, …) restyle the tab bar by
   targeting Obsidian's real tab-header class names directly. This proves
   Geode's tab DOM now matches: this rule has zero effect on any
   Geode-invented class name, only on the real one. */
.workspace-tab-header-inner {
  background-color: rgb(17, 34, 51);
}
`;

test("discovers, applies, persists, and clears a community theme", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-theme-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-theme-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const themeDir = path.join(vaultDir, ".geode", "themes", "Sunset");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, "theme.css"), THEME_CSS);
  fs.writeFileSync(
    path.join(themeDir, "manifest.json"),
    JSON.stringify({ name: "Sunset", version: "1.0.0", minAppVersion: "0.1.0", author: "test" })
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    let window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    // Discovered by the theme manager.
    const listed = await window.evaluate(() => (window as any).app.themeManager.list());
    expect(listed).toContain("Sunset");

    const bgVar = () =>
      window.evaluate(() => getComputedStyle(document.body).getPropertyValue("--background-primary").trim());
    const defaultBg = await bgVar();

    // Apply → theme CSS is injected and overrides the shared variables.
    await window.evaluate(async () => {
      const a = (window as any).app;
      a.settings.cssTheme = "Sunset";
      await a.themeManager.apply("Sunset");
      a.saveSettings();
    });
    await expect(window.locator("style#geode-community-theme")).toHaveCount(1);
    expect(await bgVar()).toBe("#101418");
    expect(await bgVar()).not.toBe(defaultBg);
    const accent = await window.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim()
    );
    expect(accent).toBe("#ff5a3c");

    // The real proof the tab-header DOM/class rename worked: a theme that
    // targets Obsidian's actual `.workspace-tab-header-inner` class name
    // (not a Geode invention) visibly restyles the tab bar once applied.
    const tabHeaderInnerBg = () =>
      window
        .locator(".workspace-tab-header-container .workspace-tab-header-inner")
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(window.locator(".workspace-tab-header-inner").first()).toBeVisible();
    expect(await tabHeaderInnerBg()).toBe("rgb(17, 34, 51)");

    // Clear → back to the default; style element removed, tab bar reverts.
    await window.evaluate(async () => {
      await (window as any).app.themeManager.apply("");
    });
    await expect(window.locator("style#geode-community-theme")).toHaveCount(0);
    expect(await bgVar()).toBe(defaultBg);
    expect(await tabHeaderInnerBg()).not.toBe("rgb(17, 34, 51)");

    // Persistence: re-select, relaunch, and the theme is applied on boot.
    await window.evaluate(async () => {
      const a = (window as any).app;
      a.settings.cssTheme = "Sunset";
      await a.themeManager.apply("Sunset");
      a.saveSettings();
    });
    await window.waitForTimeout(300); // let settings save flush
    await app.close();

    const app2 = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    const win2 = await app2.firstWindow();
    await expect(win2.locator(".workspace")).toBeVisible();
    await expect(win2.locator("style#geode-community-theme")).toHaveCount(1);
    expect(
      await win2.evaluate(() => getComputedStyle(document.body).getPropertyValue("--background-primary").trim())
    ).toBe("#101418");
    await app2.close();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
