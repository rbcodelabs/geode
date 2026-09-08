import * as fs from "node:fs";
import * as http from "node:http";
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

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Web Viewer popup fixture did not bind to TCP");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

for (const popup of [
  { name: "target=_blank", selector: "#target-blank", targetPath: "/target-blank" },
  { name: "window.open", selector: "#window-open", targetPath: "/window-open" },
]) {
  test(`${popup.name} creates a Web Viewer tab instead of a BrowserWindow`, async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (request.url === "/source") {
        response.end(`<!doctype html><html><head><title>Popup source</title></head><body>
          <a id="target-blank" href="/target-blank" target="_blank">Target blank</a>
          <button id="window-open" onclick="window.open('/window-open', '_blank')">Window open</button>
        </body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>${request.url}</title></head><body>${request.url}</body></html>`);
    });
    const port = await listen(server);
    const sourceUrl = `http://127.0.0.1:${port}/source`;
    const targetUrl = `http://127.0.0.1:${port}${popup.targetPath}`;
    const { app, window, userDataDir } = await launch();

    try {
      await window.evaluate(async (url) => {
        const geodeApp = (window as any).app;
        const sourceGroup = geodeApp.workspace.addGroup(geodeApp.workspace.activeGroup);
        const sourceLeaf = sourceGroup.createLeaf();
        await sourceLeaf.setViewState({ type: "webviewer", active: true, state: { url } });
      }, sourceUrl);

      const frame = window.locator('.web-view-frame[src="' + sourceUrl + '"]');
      await expect(frame).toBeVisible();
      await expect.poll(() => frame.evaluate((guest) =>
        (guest as unknown as { executeJavaScript(script: string): Promise<unknown> }).executeJavaScript("document.title")
      )).toBe("Popup source");

      const initialWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      const sourceGroupIndex = await window.evaluate((url) => {
        const geodeApp = (window as any).app;
        return geodeApp.workspace.groups.findIndex((group: any) =>
          group.leaves.some((leaf: any) => leaf.view?.getState?.().url === url));
      }, sourceUrl);
      await app.evaluate(({ webContents }, { url, selector }) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL() === url);
        if (!guest) throw new Error(`Missing source guest for ${url}`);
        void guest.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`).catch(() => {});
      }, { url: sourceUrl, selector: popup.selector });

      await expect.poll(() => window.evaluate(({ index, url }) => {
        const group = (window as any).app.workspace.groups[index];
        return group.leaves.filter((leaf: any) => leaf.view?.getState?.().url === url).length;
      }, { index: sourceGroupIndex, url: targetUrl })).toBe(1);
      expect(await window.evaluate(({ index, url }) => {
        const group = (window as any).app.workspace.groups[index];
        return group.active?.view?.getState?.().url === url;
      }, { index: sourceGroupIndex, url: targetUrl })).toBe(true);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(initialWindows);
    } finally {
      await close(server);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((browserWindow) => browserWindow.destroy()));
      await app.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
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

test("A main-frame load failure shows the recoverable error overlay instead of a silent gray screen, and reloading recovers", async () => {
  const { app, window, userDataDir, consoleErrors } = await launch();

  try {
    await runCommand(window, "Open web viewer");

    const webView = window.locator(".web-view");
    await expect(webView).toBeVisible();

    // Wait for the normal home page to load first, so the failure below is a
    // real navigation away from a healthy guest, not a cold-start artifact.
    const addressBar = webView.locator(".web-view-address");
    await expect(addressBar).toHaveValue(/duckduckgo\.com/, { timeout: 20000 });

    const overlay = webView.locator(".web-view-error");
    await expect(overlay).toBeHidden();

    // Drive the address bar to a guaranteed-fail URL (nothing listens on
    // localhost:1). This exercises the did-fail-load path deterministically.
    await addressBar.fill("http://localhost:1/");
    await addressBar.press("Enter");

    // The overlay appears with a non-empty, human-readable reason — the whole
    // point of the fix: a visible error state instead of a dead gray surface.
    await expect(overlay).toBeVisible({ timeout: 20000 });
    await expect(webView.locator(".web-view-error-title")).toHaveText(/failed to load/i);
    await expect(webView.locator(".web-view-error-detail")).not.toHaveText("");

    // The toolbar stays interactive (the overlay covers only the frame), so the
    // user can navigate to a working page and recover.
    await addressBar.fill("duckduckgo.com");
    await addressBar.press("Enter");

    // Recovery: overlay clears and a real page loads again (title tracks the
    // page's <title>, which only happens after a successful load).
    await expect(overlay).toBeHidden({ timeout: 20000 });
    await expect(addressBar).toHaveValue(/duckduckgo\.com/, { timeout: 20000 });
    await expect(
      window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")
    ).not.toHaveText("", { timeout: 20000 });

    // This test intentionally triggers a load failure, so the guest emits
    // expected connection/navigation console noise. Tolerate that known noise
    // (do NOT assert empty), but still fail on any UNEXPECTED console error.
    const expectedNoise = /localhost:1|ERR_|net::|Failed to load resource|Not allowed to load|GUEST_VIEW_MANAGER/i;
    const unexpected = consoleErrors.filter((msg) => !expectedNoise.test(msg));
    expect(unexpected, `Unexpected console errors: ${unexpected.join("\n")}`).toEqual([]);
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
