import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("macOS titlebar clearance follows native fullscreen", async () => {
  test.skip(process.platform !== "darwin", "macOS native window chrome only");

  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-window-chrome-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-window-chrome-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Window chrome\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "0" },
  });

  try {
    const window = await app.firstWindow();
    const leftHeader = window.locator(
      ".workspace-sidebar.mod-left > .workspace-tab-header-container",
    );
    const leftRibbon = window.locator(".workspace-ribbon.mod-left");
    await expect(leftHeader).toBeVisible();
    await expect(leftRibbon).toBeVisible();
    await expect(window.locator("body")).toHaveClass(/\bis-macos\b/);
    await expect(window.locator("body")).not.toHaveClass(/\bis-native-fullscreen\b/);
    await expect.poll(() => leftHeader.evaluate((el) => getComputedStyle(el).paddingLeft))
      .toBe("38px");
    await expect.poll(() => leftHeader.evaluate((el) => getComputedStyle(el).borderBottomWidth))
      .toBe("1px");
    await expect.poll(() => leftRibbon.evaluate((el) => getComputedStyle(el).marginTop))
      .toBe("40px");
    await expect.poll(() => leftRibbon.evaluate((el) => getComputedStyle(el).paddingTop))
      .toBe("8px");
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "titlebar-windowed.png") });
    }

    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((win: any) => win.setFullScreen(true));

    await expect(window.locator("body")).toHaveClass(/\bis-native-fullscreen\b/, {
      timeout: 15_000,
    });
    await expect.poll(() => leftHeader.evaluate((el) => getComputedStyle(el).paddingLeft))
      .toBe("8px");
    await expect.poll(() => leftHeader.evaluate((el) => getComputedStyle(el).borderBottomWidth))
      .toBe("1px");
    await expect.poll(() => leftRibbon.evaluate((el) => getComputedStyle(el).marginTop))
      .toBe("0px");
    await expect.poll(() => leftRibbon.evaluate((el) => getComputedStyle(el).paddingTop))
      .toBe("8px");
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "titlebar-fullscreen.png") });
    }

    await browserWindow.evaluate((win: any) => win.setFullScreen(false));
    await expect(window.locator("body")).not.toHaveClass(/\bis-native-fullscreen\b/, {
      timeout: 15_000,
    });
    await expect.poll(() => leftHeader.evaluate((el) => getComputedStyle(el).paddingLeft))
      .toBe("38px");
    await expect.poll(() => leftHeader.evaluate((el) => getComputedStyle(el).borderBottomWidth))
      .toBe("1px");
    await expect.poll(() => leftRibbon.evaluate((el) => getComputedStyle(el).marginTop))
      .toBe("40px");
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "titlebar-windowed-restored.png") });
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
