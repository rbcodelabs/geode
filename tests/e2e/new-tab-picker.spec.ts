import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const isMac = process.platform === "darwin";
const MOD = isMac ? "Meta" : "Control";

/**
 * The New Tab universal picker (`NewTabPickerList` in app.ts) lets one input
 * either open a vault file (fuzzy search), open/search the web, or create a
 * new note — reusing the extracted `SuggestList` (fuzzy nav) and
 * `resolveWebInput`/`isUrlShaped` (URL-vs-search heuristic) machinery that
 * the Quick Switcher and Web Viewer address bar already use.
 *
 * A throwaway vault + user-data-dir per test, same pattern as
 * webview-hotkeys.spec.ts, so absolute tab/file counts don't depend on state
 * left behind by another spec.
 */
async function launch() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-new-tab-picker-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-new-tab-picker-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Daily Plan.md"), "# Daily Plan\n\nBody text.\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  const cleanup = () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, cleanup, vaultDir };
}

const rootTabs = (window: Page) => window.locator(".workspace-split.mod-root .workspace-tab-header");
const pickerInput = (window: Page) => window.locator(".new-tab-picker-input");
const pickerResults = (window: Page) => window.locator(".new-tab-picker-result");
const activeFilePath = (window: Page) =>
  window.evaluate(() => (window as any).app.workspace.activeLeaf?.view?.file?.path ?? null);

/** Opens a fresh New Tab (Mod+T) and returns its picker input, focused and empty. */
async function openNewTab(window: Page) {
  await window.keyboard.press(`${MOD}+T`);
  const input = pickerInput(window);
  await expect(input).toBeVisible();
  return input;
}

test("typing an existing note's name shows it, and Enter opens it in the same tab", async () => {
  const { app, window, cleanup } = await launch();
  try {
    const input = await openNewTab(window);
    const tabsBefore = await rootTabs(window).count();

    await input.fill("Daily Plan");
    await expect(pickerResults(window).first()).toContainText("Daily Plan");

    await input.press("Enter");

    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();
    expect(await activeFilePath(window)).toBe("Daily Plan.md");
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
  } finally {
    await app.close();
    cleanup();
  }
});

test("typing an existing note's name shows it, and clicking it opens it in the same tab", async () => {
  const { app, window, cleanup } = await launch();
  try {
    const input = await openNewTab(window);
    const tabsBefore = await rootTabs(window).count();

    await input.fill("Daily Plan");
    await pickerResults(window).first().click();

    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();
    expect(await activeFilePath(window)).toBe("Daily Plan.md");
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
  } finally {
    await app.close();
    cleanup();
  }
});

test("a bare domain pins an Open item first; choosing it opens a Web Viewer tab at the resolved URL", async () => {
  const { app, window, cleanup } = await launch();
  try {
    const input = await openNewTab(window);
    const tabsBefore = await rootTabs(window).count();

    await input.fill("example.com");
    const first = pickerResults(window).first();
    await expect(first).toHaveText("Open https://example.com");

    await first.click();

    await expect(window.locator(".web-view-frame")).toBeVisible();
    await expect(window.locator(".web-view-address")).toHaveValue("https://example.com");
    await expect(rootTabs(window)).toHaveCount(tabsBefore + 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test("a fully-qualified URL is pinned and passed through unchanged", async () => {
  const { app, window, cleanup } = await launch();
  try {
    const input = await openNewTab(window);
    const tabsBefore = await rootTabs(window).count();

    await input.fill("https://example.com/some/path");
    const first = pickerResults(window).first();
    await expect(first).toHaveText("Open https://example.com/some/path");

    await first.press("Enter"); // default selection is the pinned open-url item

    await expect(window.locator(".web-view-frame")).toBeVisible();
    await expect(window.locator(".web-view-address")).toHaveValue("https://example.com/some/path");
    await expect(rootTabs(window)).toHaveCount(tabsBefore + 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test("plain non-matching text shows New note and Search the web; New note creates and opens it in the same tab", async () => {
  const { app, window, cleanup } = await launch();
  try {
    const input = await openNewTab(window);
    const tabsBefore = await rootTabs(window).count();

    await input.fill("Totally New Idea");
    const results = pickerResults(window);
    await expect(results).toHaveCount(2);
    await expect(results.nth(0)).toHaveText('New note "Totally New Idea"');
    await expect(results.nth(1)).toHaveText('Search the web for "Totally New Idea"');

    await results.nth(0).click();

    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();
    expect(await activeFilePath(window)).toBe("Totally New Idea.md");
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
  } finally {
    await app.close();
    cleanup();
  }
});

test("Search the web opens a Web Viewer tab at the resolved search-engine URL", async () => {
  const { app, window, cleanup } = await launch();
  try {
    const input = await openNewTab(window);
    const tabsBefore = await rootTabs(window).count();

    await input.fill("release notes");
    await pickerResults(window).nth(1).click(); // "Search the web for ..."

    await expect(window.locator(".web-view-frame")).toBeVisible();
    await expect(window.locator(".web-view-address")).toHaveValue(
      `https://duckduckgo.com/?q=${encodeURIComponent("release notes")}`,
    );
    await expect(rootTabs(window)).toHaveCount(tabsBefore + 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test("the four existing New Tab action buttons are still present and functional", async () => {
  const { app, window, cleanup } = await launch();
  try {
    await openNewTab(window);
    const buttons = window.locator(".empty-state-action");
    await expect(buttons).toHaveCount(4);
    await expect(buttons.nth(0)).toHaveText(/Create new note/);
    await expect(buttons.nth(1)).toHaveText(/Open quick switcher/);
    await expect(buttons.nth(2)).toHaveText(/Open command palette/);
    await expect(buttons.nth(3)).toHaveText(/Open browser/);

    await buttons.nth(2).click();
    await expect(window.locator(".modal .prompt-input")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.locator(".modal .prompt-input")).toHaveCount(0);
  } finally {
    await app.close();
    cleanup();
  }
});
