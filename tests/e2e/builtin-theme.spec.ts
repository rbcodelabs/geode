import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("an existing vault discovers, applies, and restores the built-in Ivory theme", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-builtin-theme-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-builtin-theme-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Existing vault\n");
  fs.mkdirSync(path.join(vaultDir, ".geode"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  let app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    let window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    await window.evaluate(() => (window as any).app.setting.openTabById("appearance"));
    const themePicker = window.locator('select[aria-label="Theme"]');
    await expect(themePicker).toBeVisible();
    await expect(themePicker.locator("option")).toHaveText(["Default", "Ivory"]);

    const defaultAccent = await window.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim(),
    );
    await themePicker.selectOption("Ivory");
    await expect(window.locator('style#geode-active-theme[data-theme="Ivory"]')).toHaveCount(1);
    expect(await window.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim(),
    )).toBe("hsl(143, 28%, 38%)");
    expect(await window.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim(),
    )).not.toBe(defaultAccent);

    await window.waitForTimeout(300);
    await app.close();

    app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await expect(window.locator('style#geode-active-theme[data-theme="Ivory"]')).toHaveCount(1);
    expect(await window.evaluate(() => (window as any).app.settings.cssTheme)).toBe("Ivory");
    expect(await window.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim(),
    )).toBe("hsl(143, 28%, 38%)");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
