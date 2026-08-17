import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("sizes workspace tabs like Obsidian as the available space changes", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-responsive-tabs-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-responsive-tabs-ud-"));
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const names = Array.from({ length: 10 }, (_, index) => `Responsive tab title ${index + 1}`);
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
    await browserWindow.evaluate((win: any) => win.setSize(1280, 800));

    await window.evaluate(async (noteNames) => {
      const geode = (window as any).app;
      for (const name of noteNames.slice(0, 2)) {
        await geode.openFile(geode.vault.getFileByPath(`${name}.md`), true);
      }
    }, names);

    const mainBar = window.locator(".workspace-split.mod-root .workspace-tab-header-container").first();
    const mainTabs = mainBar.locator(".workspace-tab-header");
    await expect(mainTabs).toHaveCount(3);

    const tabToClose = mainTabs.nth(1);
    const tabToCloseTitle = await tabToClose.locator(".workspace-tab-header-inner-title").textContent();
    const closeButton = tabToClose.locator(".workspace-tab-header-inner-close-button");
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect(mainTabs).toHaveCount(2);
    await expect(mainTabs.locator(".workspace-tab-header-inner-title", { hasText: tabToCloseTitle! })).toHaveCount(0);

    await window.evaluate(async (noteName) => {
      const geode = (window as any).app;
      await geode.openFile(geode.vault.getFileByPath(`${noteName}.md`), true);
    }, names[0]);
    await expect(mainTabs).toHaveCount(3);
    const roomyWidths = await mainTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
    expect(Math.max(...roomyWidths)).toBeLessThanOrEqual(240);

    const sidebarTabs = window.locator(".workspace-sidebar .workspace-tab-header");
    expect(await sidebarTabs.count()).toBeGreaterThan(0);
    const sidebarWidths = await sidebarTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
    expect(Math.max(...sidebarWidths)).toBeLessThanOrEqual(48);

    const measureControl = async (controlSelector: string, containerSelector: string) =>
      window.evaluate(
        ({ controlSelector, containerSelector }) => {
          const control = document.querySelector<HTMLElement>(controlSelector)!;
          const container = document.querySelector<HTMLElement>(containerSelector)!;
          const icon = control.querySelector<SVGElement>("svg")!;
          const controlRect = control.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const iconRect = icon.getBoundingClientRect();
          return {
            width: controlRect.width,
            height: controlRect.height,
            iconWidth: iconRect.width,
            iconHeight: iconRect.height,
            topInset: controlRect.top - containerRect.top,
          };
        },
        { controlSelector, containerSelector }
      );

    const leftTabMetrics = await measureControl(
      ".workspace-sidebar.mod-left .workspace-tab-header",
      ".workspace-sidebar.mod-left .workspace-tab-header-container"
    );
    const rightTabMetrics = await measureControl(
      ".workspace-sidebar.mod-right .workspace-tab-header",
      ".workspace-sidebar.mod-right .workspace-tab-header-container"
    );
    const leftToggleMetrics = await measureControl(
      ".workspace-split.mod-root .sidebar-toggle-button.mod-left",
      ".workspace-split.mod-root .workspace-tab-header-container"
    );
    const rightToggleMetrics = await measureControl(
      ".workspace-split.mod-root .sidebar-toggle-button.mod-right",
      ".workspace-split.mod-root .workspace-tab-header-container"
    );
    for (const [toggleMetrics, tabMetrics] of [
      [leftToggleMetrics, leftTabMetrics],
      [rightToggleMetrics, rightTabMetrics],
    ]) {
      expect(toggleMetrics.width).toBe(tabMetrics.width);
      expect(toggleMetrics.height).toBe(tabMetrics.height);
      expect(toggleMetrics.iconWidth).toBe(tabMetrics.iconWidth);
      expect(toggleMetrics.iconHeight).toBe(tabMetrics.iconHeight);
      expect(Math.abs(toggleMetrics.topInset - tabMetrics.topInset)).toBeLessThanOrEqual(1);
    }
    if (screenshotDir) await window.screenshot({ path: path.join(screenshotDir, "responsive-tabs-roomy.png") });

    await browserWindow.evaluate((win: any) => win.setSize(900, 700));
    await window.evaluate(async (noteNames) => {
      const geode = (window as any).app;
      for (const name of noteNames.slice(2)) {
        await geode.openFile(geode.vault.getFileByPath(`${name}.md`), true);
      }
    }, names);

    await expect(mainTabs).toHaveCount(names.length + 1);
    await expect
      .poll(() =>
        mainTabs.evaluateAll(
          (tabs) => tabs.filter((tab) => tab.getBoundingClientRect().width > 0 && tab.getBoundingClientRect().height > 0).length
        )
      )
      .toBe(names.length + 1);
    const compactedTabs = await mainTabs.evaluateAll((tabs) =>
      tabs.filter((tab) => tab.getBoundingClientRect().width <= 48).length
    );
    expect(compactedTabs).toBeGreaterThan(0);
    const hiddenLabels = await mainTabs.locator(".workspace-tab-header-inner-title").evaluateAll((titles) =>
      titles.filter((title) => title.getBoundingClientRect().width === 0).length
    );
    expect(hiddenLabels).toBeGreaterThan(0);
    const compactedTabsWithoutIcons = await mainTabs.evaluateAll((tabs) =>
      tabs.filter((tab) => {
        if (tab.getBoundingClientRect().width > 48) return false;
        const icon = tab.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
        return !icon || icon.getBoundingClientRect().width === 0;
      }).length
    );
    expect(compactedTabsWithoutIcons).toBe(0);

    const rightToggle = mainBar.locator(".sidebar-toggle-button.mod-right");
    const toggleBox = await rightToggle.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(900);
    if (screenshotDir) await window.screenshot({ path: path.join(screenshotDir, "responsive-tabs-crowded.png") });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
