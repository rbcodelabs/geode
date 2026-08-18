import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");
const isMac = process.platform === "darwin";

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  const consoleErrors: string[] = [];
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  await expect(window.locator(".workspace")).toBeVisible();
  return { app, window, userDataDir, consoleErrors };
}

async function runCommand(window: import("@playwright/test").Page, name: string) {
  await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
  await window.locator(".prompt-input").fill(name);
  await window.getByText(name, { exact: true }).click();
}

test("Open web viewer mounts a <webview> tab in its own persist:webviewer session, loads the home URL, and tracks the page title", async () => {
  const { app, window, userDataDir, consoleErrors } = await launch();

  try {
    await runCommand(window, "Open web viewer");

    const webView = window.locator(".web-view");
    await expect(webView).toBeVisible();

    const frame = webView.locator(".web-view-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("partition", "persist:webviewer");

    // The address bar reflects the loaded URL once the webview navigates.
    await expect(webView.locator(".web-view-address")).toHaveValue(/duckduckgo\.com/, {
      timeout: 20000,
    });

    // The tab title tracks the page's <title> once it loads, not staying on
    // the initial URL-derived fallback text forever.
    await expect(
      window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")
    ).not.toHaveText("", { timeout: 20000 });

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Search the web opens a viewer tab with the query appended to the configured search engine", async () => {
  const { app, window, userDataDir, consoleErrors } = await launch();

  try {
    await runCommand(window, "Search the web");
    await expect(window.locator(".prompt-input")).toBeVisible();
    await window.locator(".prompt-input").fill("geode markdown editor");
    await window.keyboard.press("Enter");

    const addressBar = window.locator(".web-view .web-view-address");
    await expect(addressBar).toHaveValue(/duckduckgo\.com\/\?q=geode(%20|\+)markdown(%20|\+)editor/, {
      timeout: 20000,
    });

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Opening vault HTML uses the Web Viewer and loads relative CSS, JavaScript, and images", async () => {
  const { app, window, userDataDir, consoleErrors } = await launch();

  try {
    const initialTabCount = await window.locator(".workspace-split.mod-root .workspace-tab-header").count();
    await window.locator('.nav-file-title[data-path="Local page.html"]').click();

    const webView = window.locator(".web-view");
    const frame = webView.locator(".web-view-frame");
    await expect(webView).toBeVisible();
    await expect(frame).toHaveAttribute("partition", "persist:webviewer");
    await expect(webView.locator(".web-view-address")).toHaveValue(/^file:\/\/.*Local%20page\.html$/);
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header")).toHaveCount(initialTabCount);

    await expect
      .poll(() =>
        frame.evaluate((guest) =>
          (guest as unknown as { executeJavaScript(script: string): Promise<unknown> }).executeJavaScript(`({
            title: document.title,
            scriptRan: document.body.dataset.scriptRan,
            color: getComputedStyle(document.querySelector('h1')).color,
            imageLoaded: document.querySelector('img').complete && document.querySelector('img').naturalWidth > 0
          })`)
        )
      )
      .toEqual({
        title: "Local vault page",
        scriptRan: "yes",
        color: "rgb(35, 131, 226)",
        imageLoaded: true,
      });

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
