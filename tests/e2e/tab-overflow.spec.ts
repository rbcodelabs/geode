import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("keeps sidebar controls reachable and moves excess main tabs into the tab-list menu", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-tab-overflow-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-tab-overflow-ud-"));
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const names = Array.from({ length: 10 }, (_, index) => `Long note title ${index + 1}`);
  for (const name of names) fs.writeFileSync(path.join(vaultDir, `${name}.md`), `# ${name}\n`);
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((win: any) => win.setSize(680, 700));

    await window.evaluate(async (noteNames) => {
      const geode = (window as any).app;
      for (const name of noteNames) {
        await geode.openFile(geode.vault.getFileByPath(`${name}.md`), true);
      }
    }, names);

    const mainBar = window.locator(".workspace-split.mod-root .workspace-tab-header-container").first();
    const rightToggle = mainBar.locator(".sidebar-toggle-button.mod-right");
    await expect(rightToggle).toBeVisible();
    const toggleBox = await rightToggle.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(680);

    const visibleTabs = mainBar.locator(".workspace-tab-header:not(.is-tab-overflow-hidden)");
    expect(await visibleTabs.count()).toBeLessThan(names.length);
    await expect(visibleTabs.locator(".workspace-tab-header-inner-title", { hasText: names.at(-1)! })).toBeVisible();
    const visibleTabWidths = await visibleTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
    expect(visibleTabWidths.every((width) => width >= 96)).toBe(true);
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "tab-overflow-narrow.png") });
    }

    await mainBar.locator(".workspace-tab-header-tab-list .clickable-icon").click();
    const overflowMenu = window.locator(".context-menu");
    await expect(overflowMenu).toBeVisible();
    expect(await overflowMenu.locator(".context-menu-item").count()).toBeGreaterThan(0);
    await expect(overflowMenu.locator(".context-menu-item", { hasText: names[0] })).toBeVisible();
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "tab-overflow-menu.png") });
      await window.locator(".workspace-tab-container").click({ position: { x: 20, y: 20 } });
      await expect(overflowMenu).toHaveCount(0);
      await browserWindow.evaluate((win: any) => win.setSize(1280, 800));
      await expect(rightToggle).toBeVisible();
      await window.screenshot({ path: path.join(screenshotDir, "tab-overflow-normal.png") });
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
