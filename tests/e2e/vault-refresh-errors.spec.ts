import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("refresh explains real unsupported paths, redacts copied diagnostics and retries safely", async ({}, testInfo) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-refresh-"));
  const vault = path.join(root, "vault");
  const userData = path.join(root, "user-data");
  fs.mkdirSync(vault); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(vault, "Welcome.md"), "# Welcome\nExisting note bytes");
  fs.mkdirSync(path.join(vault, ".geode", "worktrees", "dev"), { recursive: true });
  fs.symlinkSync("missing", path.join(vault, ".geode", "worktrees", "dev", "node_modules"));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const repo = path.resolve(__dirname, "../..");
  const app = await electron.launch({ args: [repo, `--user-data-dir=${userData}`], cwd: repo });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
    await page.evaluate(() => (window as any).app.reconcileVault("manual"));
    await expect(page.locator(".vault-reconcile-state")).toHaveCount(0);
    fs.symlinkSync("missing", path.join(vault, "Unsupported.md"));
    await page.evaluate(() => (window as any).app.reconcileVault("manual"));
    const banner = page.locator(".vault-reconcile-state");
    await expect(banner).toContainText("Vault refresh failed. Your previous file list is unchanged.");
    await expect(banner.getByRole("button")).toHaveCount(2);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.screenshot({ path: testInfo.outputPath("refresh-banner.png") });
    expect((await banner.boundingBox())!.height).toBeLessThan(70);
    await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
    const detailsButton = banner.getByRole("button", { name: "Details…" });
    await detailsButton.click();
    const dialog = page.getByRole("dialog", { name: "Vault refresh couldn’t finish" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("SYMLINK_UNSUPPORTED");
    await expect(dialog).toContainText("Unsupported.md");
    await expect(dialog).toContainText("symbolic link");
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(502);
    await dialog.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close details" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(detailsButton).toBeFocused();
    await detailsButton.click();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedReport = text; } } });
    });
    await dialog.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(dialog).toContainText("Copied");
    const report = await page.evaluate(() => (window as any).__copiedReport);
    expect(report).toContain("SYMLINK_UNSUPPORTED");
    expect(report).not.toContain(vault);
    expect(report).not.toContain("Unsupported.md");
    expect(report).not.toContain("Existing note bytes");
    fs.writeFileSync(testInfo.outputPath("refresh-desktop-context.json"), JSON.stringify(await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, devicePixelRatio, capturedAt: new Date().toISOString(),
    }))));
    await page.screenshot({ path: testInfo.outputPath("refresh-desktop.png") });
    await page.setViewportSize({ width: 600, height: 700 });
    const narrowBox = (await dialog.boundingBox())!;
    expect(narrowBox.x).toBeGreaterThanOrEqual(16);
    expect(narrowBox.y).toBeGreaterThanOrEqual(16);
    expect(narrowBox.y + narrowBox.height).toBeLessThanOrEqual(684);
    fs.writeFileSync(testInfo.outputPath("refresh-narrow-context.json"), JSON.stringify(await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, devicePixelRatio, capturedAt: new Date().toISOString(),
    }))));
    await page.screenshot({ path: testInfo.outputPath("refresh-narrow.png") });
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
    await dialog.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(dialog).toContainText("Could not copy");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await detailsButton.click();
    await expect(dialog).not.toContainText("Could not copy");
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
    await dialog.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(dialog).toContainText("Could not copy");
    fs.unlinkSync(path.join(vault, "Unsupported.md"));
    await page.evaluate(() => (window as any).app.reconcileVault("manual"));
    await expect(banner).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    fs.symlinkSync("missing", path.join(vault, "Unsupported.md"));
    await page.evaluate(() => (window as any).app.reconcileVault("manual"));
    fs.unlinkSync(path.join(vault, "Unsupported.md"));
    await banner.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(banner).toHaveCount(0);
    // Presentation phases can also fail after scanning or after the manifest commits.
    await page.evaluate(() => (window as any).app.showReconcileState("unavailable", { operation: "refresh-editors", code: "EIO" }, true, false));
    await expect(banner).toContainText("Saving is paused—keep Geode open.");
    await expect(dialog).toHaveCount(0);
    await detailsButton.click();
    await expect(dialog).toContainText("Saving is paused.");
    await expect(dialog).toContainText("does not confirm that unsaved edits are on disk");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(detailsButton).toBeFocused();
    await page.evaluate(() => (window as any).app.showReconcileState("unavailable", { operation: "finish-refresh", code: "EIO" }, false, true));
    await expect(banner).toHaveText(/File list refreshed; a follow-up step failed/);
    await expect(banner).not.toContainText("previous file list");
    await detailsButton.click();
    await expect(dialog).toContainText("The file list was refreshed");
    // Vault-session disposal must remove any old-vault details immediately.
    await page.evaluate(() => (window as any).app.disposeVaultSession());
    await expect(dialog).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    expect(fs.readFileSync(path.join(vault, "Welcome.md"), "utf8")).toBe("# Welcome\nExisting note bytes");
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
