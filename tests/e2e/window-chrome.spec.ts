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
    const appMain = window.locator(".app-main");
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
    await expect.poll(() => appMain.evaluate((el) => {
      const style = getComputedStyle(el);
      const themedChrome = getComputedStyle(document.body)
        .getPropertyValue("--background-secondary")
        .trim();
      const probe = document.createElement("div");
      probe.style.color = themedChrome;
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return style.backgroundColor === expected;
    })).toBe(true);
    const browserWindow = await app.browserWindow(window);
    const themedChromeHex = await appMain.evaluate((el) => {
      const match = getComputedStyle(el).backgroundColor.match(/\d+/g);
      if (!match || match.length < 3) throw new Error("Workspace chrome did not resolve to RGB");
      return `#${match.slice(0, 3).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
    });
    await expect.poll(() => browserWindow.evaluate((win: any) => win.getBackgroundColor().toLowerCase()))
      .toBe(themedChromeHex);
    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "titlebar-windowed.png") });
    }

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

test("drawn mac-style chrome renders in screenshot mode off macOS", async () => {
  test.skip(process.platform === "darwin", "screenshot-mode chrome is the non-macOS path");

  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-window-chrome-drawn-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-window-chrome-drawn-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Window chrome\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "0", GEODE_SCREENSHOT_MODE: "1" },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator("body")).toHaveClass(/\bis-macos\b/);
    await expect(window.locator("body")).toHaveClass(/\bis-mac-chrome-drawn\b/);

    const dots = window.locator(".mac-chrome-drawn-dot");
    await expect(dots).toHaveCount(3);
    const close = window.locator(".mac-chrome-drawn-dot.mod-close");
    const minimize = window.locator(".mac-chrome-drawn-dot.mod-minimize");
    const maximize = window.locator(".mac-chrome-drawn-dot.mod-maximize");
    await expect(close).toBeVisible();
    await expect(minimize).toBeVisible();
    await expect(maximize).toBeVisible();

    const toRgb = (hex: string) => {
      const value = hex.replace("#", "");
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return `rgb(${r}, ${g}, ${b})`;
    };
    await expect.poll(() => close.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(toRgb("#ff5f57"));
    await expect.poll(() => minimize.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(toRgb("#febc2e"));
    await expect.poll(() => maximize.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(toRgb("#28c840"));

    if (screenshotDir) {
      await window.screenshot({ path: path.join(screenshotDir, "titlebar-drawn-chrome.png") });
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
