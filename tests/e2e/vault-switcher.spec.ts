import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("Manage vaults opens and focuses isolated vault windows", async () => {
  const firstVault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-switch-first-"));
  const secondVault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-switch-second-"));
  const missingVault = path.join(os.tmpdir(), `geode-switch-missing-${Date.now()}`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-switch-ud-"));
  fs.writeFileSync(path.join(firstVault, "First.md"), "# First\n");
  fs.writeFileSync(path.join(secondVault, "Second.md"), "# Second\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [firstVault, missingVault, secondVault],
    lastVault: firstVault,
  }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const firstWindow = await app.firstWindow();
    await expect(firstWindow.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();
    const firstBrowserWindow = await app.browserWindow(firstWindow);
    await expect.poll(() => firstBrowserWindow.evaluate((win: any) => win.getTitle()))
      .toBe(`${path.basename(firstVault)} — Geode`);

    const manageButton = firstWindow.getByRole("button", { name: "Manage vaults" });
    await expect(manageButton).toBeVisible();
    await manageButton.click();

    const modal = firstWindow.locator(".modal.mod-manage-vaults");
    await expect(modal.getByRole("heading", { name: "Manage vaults" })).toBeVisible();
    const currentRow = modal.locator(".vault-switcher-row", { hasText: firstVault });
    await expect(currentRow).toContainText("Open in this window");
    await expect(modal).not.toContainText(missingVault);
    const openFolderButton = modal.getByRole("button", { name: "Open folder as vault" });
    await expect(openFolderButton).toBeVisible();

    // Native folder-picker cancellation is a no-op: keep this vault and modal intact.
    await firstWindow.evaluate(() => {
      const geode = window.geode;
      (window as any).__originalChooseVault = geode.chooseVault;
      geode.chooseVault = async () => null;
    });
    await openFolderButton.click();
    await expect(modal).toBeVisible();
    await expect.poll(() => app.windows().length).toBe(1);
    // Main-process validation rejects missing folders without changing this window.
    await expect(firstWindow.evaluate((vaultPath) => window.geode.openVaultWindow(vaultPath), missingVault))
      .rejects.toThrow("Not a folder");
    await expect(firstWindow.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();
    await expect.poll(() => app.windows().length).toBe(1);

    // A successful native selection uses the explicit launch target rather than
    // mutating recentVaults[0] and racing the new renderer's startup.
    await firstWindow.evaluate((vaultPath) => {
      window.geode.chooseVault = async () => vaultPath;
    }, secondVault);
    const pagePromise = app.waitForEvent("window");
    await openFolderButton.click();
    const secondWindow = await pagePromise;
    await expect(secondWindow.locator('.nav-file-title[data-path="Second.md"]')).toBeVisible();
    const secondBrowserWindow = await app.browserWindow(secondWindow);
    await expect.poll(() => secondBrowserWindow.evaluate((win: any) => win.getTitle()))
      .toBe(`${path.basename(secondVault)} — Geode`);
    await expect(firstWindow.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();

    await secondWindow.getByRole("button", { name: "Manage vaults" }).click();
    await secondWindow.locator(".vault-switcher-row", { hasText: firstVault }).click();
    await expect.poll(() => app.windows().length).toBe(2);

    await firstWindow.getByRole("button", { name: "Manage vaults" }).click();
    await firstWindow.locator(".vault-switcher-row", { hasText: firstVault }).click();
    await expect(firstWindow.locator(".modal.mod-manage-vaults")).toHaveCount(0);
    await expect.poll(() => app.windows().length).toBe(2);

    await firstWindow.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
    await firstWindow.locator(".prompt-input").fill("Open another vault");
    await expect(firstWindow.locator(".prompt-result", { hasText: "Open another vault" })).toBeVisible();
  } finally {
    await app.close();
    for (const scratchPath of [firstVault, secondVault, userDataDir]) {
      fs.rmSync(scratchPath, { recursive: true, force: true });
    }
  }
});
