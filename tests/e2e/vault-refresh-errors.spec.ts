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
    await expect(banner).toContainText("symbolic link");
    await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
    await banner.getByText("Show details", { exact: true }).click();
    await expect(banner).toContainText("SYMLINK_UNSUPPORTED");
    await expect(banner).toContainText("Unsupported.md");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedReport = text; } } });
    });
    await banner.getByRole("button", { name: "Copy diagnostic report" }).click();
    await expect(banner).toContainText("Copied");
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
    fs.writeFileSync(testInfo.outputPath("refresh-narrow-context.json"), JSON.stringify(await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, devicePixelRatio, capturedAt: new Date().toISOString(),
    }))));
    await page.screenshot({ path: testInfo.outputPath("refresh-narrow.png") });
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
    await banner.getByRole("button", { name: "Copy diagnostic report" }).click();
    await expect(banner).toContainText("Could not copy");
    fs.unlinkSync(path.join(vault, "Unsupported.md"));
    await banner.getByRole("button", { name: "Retry refresh" }).click();
    await expect(banner).toHaveCount(0);
    expect(fs.readFileSync(path.join(vault, "Welcome.md"), "utf8")).toBe("# Welcome\nExisting note bytes");
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
