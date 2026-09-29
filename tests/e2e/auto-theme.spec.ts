import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/** Base color scheme "Auto" follows the OS live, persists, and stops following once explicit. */
test("Auto base color scheme follows OS appearance, persists, and stops on explicit Light", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-auto-theme-ud-"));
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-auto-theme-vault-"));
  fs.mkdirSync(path.join(vaultDir, ".geode"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(vaultDir, ".geode", "app.json"), JSON.stringify({ theme: "auto" }));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  const launch = () =>
    electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: { ...process.env, GEODE_HEADLESS: "1" },
    });

  let app = await launch();
  try {
    let window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    await window.emulateMedia({ colorScheme: "light" });
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    await window.emulateMedia({ colorScheme: "dark" });
    await expect(window.locator("body.theme-dark")).toHaveCount(1);
    await window.emulateMedia({ colorScheme: "light" });
    await expect(window.locator("body.theme-light")).toHaveCount(1);

    // Round-trip: Auto was read from app.json and is selected in Settings.
    await window.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await window.locator(".vertical-tab-nav-item", { hasText: "Appearance" }).click();
    await expect(window.getByLabel("Base color scheme")).toHaveValue("auto");

    // Explicit Light (via the dropdown) stops following the OS.
    await window.getByLabel("Base color scheme").selectOption("light");
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    await window.emulateMedia({ colorScheme: "dark" });
    await window.waitForTimeout(500);
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "app.json"), "utf8")).theme).toBe("light");

    // Back to Auto through the dropdown, then persist and reload.
    await window.getByLabel("Base color scheme").selectOption("auto");
    await expect(window.locator("body.theme-dark")).toHaveCount(1);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "app.json"), "utf8")).theme).toBe("auto");
    await app.close();

    app = await launch();
    window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.emulateMedia({ colorScheme: "light" });
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    expect(await window.evaluate(() => (window as any).app.settings.theme)).toBe("auto");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
