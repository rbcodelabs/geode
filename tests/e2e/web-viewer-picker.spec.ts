import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CTA_BOX = { x: 80, y: 140, width: 160, height: 48 };
const CTA_CENTER = { x: 160, y: 164 };

function startFixtureServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (urlPath === "/hang") {
      // Never completes headers so client stays in pre-commit state until navigated away
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Web Viewer Picker Fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: #f8fafc; font-family: sans-serif; }
    #cta {
      position: fixed;
      left: ${CTA_BOX.x}px;
      top: ${CTA_BOX.y}px;
      width: ${CTA_BOX.width}px;
      height: ${CTA_BOX.height}px;
      box-sizing: border-box;
      border: 0;
      border-radius: 8px;
      background: rgb(37, 99, 235);
      color: rgb(255, 255, 255);
      font-size: 16px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main aria-label="Hero section">
    <button id="cta" type="button">Ship preview</button>
  </main>
  <script>
    window.__pageClicks = 0;
    document.getElementById("cta").addEventListener("click", () => {
      window.__pageClicks += 1;
    });
  </script>
</body>
</html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture server did not bind to TCP");
      }
      resolve({ server, port: address.port });
    });
  });
}

async function getClosedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("failed to allocate port");
  const port = addr.port;
  await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function launch(extraArgs: string[] = []) {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-wv-picker-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-wv-picker-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`, ...extraArgs],
    cwd: repoRoot,
  });
  const window = await app.firstWindow();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any) => win.setSize(1280, 900));
  const cleanup = async () => {
    await app.close().catch(() => {});
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, cleanup };
}

async function sendGuestInput(
  app: ElectronApplication,
  urlPrefix: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, { prefix, ev }) => {
      const guest = webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && !w.isDestroyed() && w.getURL().startsWith(prefix));
      if (!guest) return false;
      guest.sendInputEvent(ev as any);
      return true;
    },
    { prefix: urlPrefix, ev: event },
  );
}

async function moveGuestMouse(app: ElectronApplication, urlPrefix: string, x: number, y: number): Promise<void> {
  expect(await sendGuestInput(app, urlPrefix, { type: "mouseMove", x, y })).toBe(true);
}

async function clickGuestAt(app: ElectronApplication, urlPrefix: string, x: number, y: number): Promise<void> {
  await moveGuestMouse(app, urlPrefix, x, y);
  expect(await sendGuestInput(app, urlPrefix, { type: "mouseDown", x, y, button: "left", clickCount: 1 })).toBe(true);
  expect(await sendGuestInput(app, urlPrefix, { type: "mouseUp", x, y, button: "left", clickCount: 1 })).toBe(true);
}

async function installFeedbackProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    const geodeApp = (window as any).app;
    const probeState = {
      requests: [] as any[],
      listCalls: [] as any[],
      reg: null as { status: string; dispose(): void } | null,
      register() {
        this.reg = geodeApp.webViewerFeedbackService.register(
          { pluginId: "agent-threads", displayName: "Agent Threads" },
          {
            contractVersion: 1,
            listThreads: async (target: unknown) => {
              this.listCalls.push(target);
              return {
                threads: [
                  {
                    id: "thread-active",
                    title: "Fix checkout styles",
                    subtitle: "storefront",
                    active: true,
                    busy: false,
                    planMode: false,
                  },
                  {
                    id: "thread-busy",
                    title: "Audit a11y",
                    active: false,
                    busy: true,
                    planMode: true,
                  },
                ],
                allowNewThread: true,
              };
            },
            submit: async (request: any) => {
              this.requests.push({
                frozenRoot: Object.isFrozen(request),
                frozenSelection: Object.isFrozen(request.selection),
                frozenPage: Object.isFrozen(request.page),
                contractVersion: request.contractVersion,
                page: request.page,
                threadId: request.threadId,
                comment: request.comment,
                stale: request.stale,
                selection: request.selection,
                screenshotOmitted: request.screenshotOmitted,
                screenshotMeta: request.screenshot
                  ? {
                      mimeType: request.screenshot.mimeType,
                      byteLength: request.screenshot.bytes.byteLength,
                      header: Array.from(request.screenshot.bytes.slice(0, 8)),
                      width: request.screenshot.width,
                      height: request.screenshot.height,
                      cssRect: request.screenshot.cssRect,
                    }
                  : null,
              });
              return {
                status: "accepted",
                delivery: request.threadId === "thread-busy" ? "queued" : "sent",
                threadId: request.threadId === "__new__" ? "thread-created-99" : request.threadId,
              };
            },
          },
        );
        return this.reg.status;
      },
      dispose() {
        this.reg?.dispose();
        this.reg = null;
      },
    };
    (window as any).__wvProbe = probeState;
  });
}

test.describe("Web Viewer viewport presets and element pick-to-thread", () => {
  test.setTimeout(120_000);

  test("viewport presets resize <webview> and preserve { url } in Fill vs { url, viewport } in Mobile", async () => {
    const { server, port } = await startFixtureServer();
    const { window, cleanup } = await launch();

    try {
      const url = `http://127.0.0.1:${port}/`;
      await window.evaluate(async (u) => {
        const geodeApp = (window as any).app;
        const leaf = geodeApp.workspace.getLeaf(true);
        (window as any).__wvLeaf = leaf;
        await leaf.setViewState({ type: "webviewer", active: true, state: { url: u } });
      }, url);

      const webView = window.locator(".web-view");
      const frame = webView.locator(".web-view-frame");
      await expect(webView.locator(".web-view-address")).toHaveValue(url);

      // Default Fill mode preserves exact { url } state shape
      const fillState = await window.evaluate(() => (window as any).__wvLeaf.getViewState().state);
      expect(fillState).toEqual({ url });
      expect(Object.keys(fillState)).toEqual(["url"]);
      await expect(webView.locator('[data-viewport-preset="fill"]')).toHaveAttribute("aria-pressed", "true");

      // Desktop 1440x900
      await webView.locator('[data-viewport-preset="desktop"]').click();
      await expect(webView.locator('[data-viewport-preset="desktop"]')).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(1440, 0);
      await expect.poll(async () => (await frame.boundingBox())?.height).toBeCloseTo(900, 0);

      // Tablet 768x1024
      await webView.locator('[data-viewport-preset="tablet"]').click();
      await expect(webView.locator('[data-viewport-preset="tablet"]')).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(768, 0);
      await expect.poll(async () => (await frame.boundingBox())?.height).toBeCloseTo(1024, 0);

      // Mobile 390x844 persists viewport in leaf state
      await webView.locator('[data-viewport-preset="mobile"]').click();
      await expect(webView.locator('[data-viewport-preset="mobile"]')).toHaveAttribute("aria-pressed", "true");
      // Account for 1px border on each side of non-fill .web-view-frame (390 content + 2 border = 392 border-box, or style width 390px)
      const mobileStyle = await frame.evaluate((el: HTMLElement) => ({
        width: el.style.width,
        height: el.style.height,
      }));
      expect(mobileStyle).toEqual({ width: "390px", height: "844px" });

      const mobileState = await window.evaluate(() => (window as any).__wvLeaf.getViewState().state);
      expect(mobileState).toEqual({
        url,
        viewport: { preset: "mobile", width: 390, height: 844 },
      });

      // Returning to Fill drops viewport key from state
      await webView.locator('[data-viewport-preset="fill"]').click();
      const restoredFillState = await window.evaluate(() => (window as any).__wvLeaf.getViewState().state);
      expect(restoredFillState).toEqual({ url });
    } finally {
      await cleanup();
      await closeServer(server);
    }
  });

  test("Pick button is unavailable on about:blank and did-fail-load, then picks element and sends frozen request with screenshot and threadId", async () => {
    const { server, port } = await startFixtureServer();
    const closedPort = await getClosedPort();
    const { app, window, cleanup } = await launch();

    try {
      await installFeedbackProbe(window);

      // Read-only public registry surface check
      const publicKeys = await window.evaluate(() => Object.keys((window as any).app.webViewerFeedback).sort());
      expect(publicKeys).toEqual(["contractVersions", "has", "onDidChange"]);

      expect(await window.evaluate(() => (window as any).__wvProbe.register())).toBe("registered");

      // Open on about:blank -> Pick button must remain unavailable
      await window.evaluate(async () => {
        const geodeApp = (window as any).app;
        const leaf = geodeApp.workspace.getLeaf(true);
        (window as any).__wvLeaf = leaf;
        await leaf.setViewState({ type: "webviewer", active: true, state: { url: "about:blank" } });
      });

      const pickBtn = window.locator('[data-testid="web-view-pick-btn"]');
      await expect(pickBtn).toBeHidden();
      await expect(pickBtn).toBeDisabled();

      // Navigate to closed port -> did-fail-load error overlay shown, Pick still unavailable
      const deadUrl = `http://127.0.0.1:${closedPort}/`;
      await window.evaluate(async (u) => {
        await (window as any).__wvLeaf.setViewState({ type: "webviewer", active: true, state: { url: u } });
      }, deadUrl);
      await expect(window.locator(".web-view-error")).toBeVisible();
      await expect(pickBtn).toBeHidden();
      await expect(pickBtn).toBeDisabled();

      // Navigate to healthy local fixture -> Pick becomes visible & enabled
      const liveUrl = `http://127.0.0.1:${port}/`;
      await window.evaluate(async (u) => {
        await (window as any).__wvLeaf.setViewState({ type: "webviewer", active: true, state: { url: u } });
      }, liveUrl);
      await expect(window.locator(".web-view-error")).toBeHidden();
      await expect(pickBtn).toBeVisible();
      await expect(pickBtn).toBeEnabled();

      // Switch to Mobile preset so viewportPreset is recorded on selection
      await window.locator('[data-viewport-preset="mobile"]').click();

      // Enter Pick mode, hover & click #cta via trusted sendInputEvent
      await pickBtn.click();
      await expect(pickBtn).toHaveAttribute("aria-pressed", "true");
      await moveGuestMouse(app, liveUrl, CTA_CENTER.x, CTA_CENTER.y);
      await expect(window.locator(".web-view-hover")).toContainText("<button>");

      await clickGuestAt(app, liveUrl, CTA_CENTER.x, CTA_CENTER.y);

      const popover = window.locator(".pick-popover");
      await expect(popover).toBeVisible();
      await expect(popover.locator('[data-testid="pick-popover-origin"]')).toHaveText(`http://127.0.0.1:${port}`);
      await expect(popover.locator('[data-testid="pick-popover-external-origin"]')).toBeHidden();

      // Guest page click handler was never triggered by the pick click
      const guestClicks = await window
        .locator(".web-view-frame")
        .evaluate((guest: any) => guest.executeJavaScript("window.__pageClicks"));
      expect(guestClicks).toBe(0);

      // Selection box overlay is visible and non-interactive
      await expect(window.locator(".web-view-selection-box")).toBeVisible();
      await expect(window.locator(".web-view-selection-box")).toHaveCSS("pointer-events", "none");

      // Thread switcher defaults to active thread ("thread-active") and includes "+ New thread"
      const threadSelect = popover.locator('[data-testid="pick-popover-thread-select"]');
      await expect(threadSelect).toHaveValue("thread-active");
      await threadSelect.selectOption("__new__");
      await expect(threadSelect).toHaveValue("__new__");

      await popover.getByRole("textbox", { name: "Comment on the selected element" }).fill(
        "Increase horizontal padding and contrast on mobile.",
      );
      await popover.getByRole("button", { name: "Send" }).click();
      await expect(popover.locator(".pick-popover-status")).toHaveText("Sent.");

      const requests = await window.evaluate(() => (window as any).__wvProbe.requests);
      expect(requests).toHaveLength(1);
      const req = requests[0]!;
      expect(req.frozenRoot).toBe(true);
      expect(req.frozenSelection).toBe(true);
      expect(req.frozenPage).toBe(true);
      expect(req.contractVersion).toBe(1);
      expect(req.threadId).toBe("__new__");
      expect(req.comment).toBe("Increase horizontal padding and contrast on mobile.");
      expect(req.stale).toBe(false);
      expect(req.page).toEqual({
        url: liveUrl,
        origin: `http://127.0.0.1:${port}`,
        title: "Web Viewer Picker Fixture",
      });
      expect(req.selection.tag).toBe("button");
      expect(req.selection.selector).toBe("#cta");
      expect(req.selection.viewportPreset).toBe("mobile");
      expect(req.selection.computedStyles["background-color"]).toBe("rgb(37, 99, 235)");
      expect(req.screenshotOmitted).toBeNull();
      expect(req.screenshotMeta).not.toBeNull();
      expect(req.screenshotMeta.mimeType).toBe("image/png");
      expect(req.screenshotMeta.header).toEqual(PNG_SIGNATURE);
      expect(req.screenshotMeta.width).toBeGreaterThan(0);
      expect(req.screenshotMeta.height).toBeGreaterThan(0);
    } finally {
      await cleanup();
      await closeServer(server);
    }
  });

  test("ignores untrusted synthetic clicks & postMessage spoofing, shows External origin badge, and preserves __geode.postEvent bridge", async () => {
    const { server, port } = await startFixtureServer();
    const { app, window, cleanup } = await launch([
      `--host-resolver-rules=MAP compass.rbcodelabs.com 127.0.0.1:${port}`,
    ]);

    try {
      await installFeedbackProbe(window);
      expect(await window.evaluate(() => (window as any).__wvProbe.register())).toBe("registered");

      const externalUrl = `http://compass.rbcodelabs.com:${port}/`;
      await window.evaluate(async (u) => {
        const geodeApp = (window as any).app;
        (window as any).__lastBridgeEvent = null;
        geodeApp.workspace.on("web-viewer:event", (ev: unknown) => {
          (window as any).__lastBridgeEvent = ev;
        });
        const leaf = geodeApp.workspace.getLeaf(true);
        await leaf.setViewState({ type: "webviewer", active: true, state: { url: u } });
      }, externalUrl);

      const pickBtn = window.locator('[data-testid="web-view-pick-btn"]');
      await expect(pickBtn).toBeVisible();

      // Verify webviewer-bridge-preload.js (`window.__geode.postEvent`) still works alongside inspector preload!
      await window
        .locator(".web-view-frame")
        .evaluate((guest: any) =>
          guest.executeJavaScript(`window.__geode.postEvent("decision.approved", { decisionId: "coexist-42" })`),
        );
      await expect.poll(() => window.evaluate(() => (window as any).__lastBridgeEvent)).toMatchObject({
        source: "compass",
        type: "decision.approved",
        payload: { decisionId: "coexist-42" },
      });

      // Enter Pick mode and attempt hostile untrusted click + postMessage spoofing from guest
      await pickBtn.click();
      await expect(pickBtn).toHaveAttribute("aria-pressed", "true");

      await window.locator(".web-view-frame").evaluate((guest: any) =>
        guest.executeJavaScript(`
          document.getElementById("cta").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          window.postMessage({ channel: "geode:inspect:select", tag: "button", selector: "#cta" }, "*");
        `),
      );
      await window.waitForTimeout(300);
      await expect(window.locator(".pick-popover")).toBeHidden();

      // Now perform a real trusted click -> popover opens AND shows External origin badge!
      await clickGuestAt(app, externalUrl, CTA_CENTER.x, CTA_CENTER.y);
      const popover = window.locator(".pick-popover");
      await expect(popover).toBeVisible();
      await expect(popover.locator('[data-testid="pick-popover-origin"]')).toHaveText(
        `http://compass.rbcodelabs.com:${port}`,
      );
      await expect(popover.locator('[data-testid="pick-popover-external-origin"]')).toBeVisible();
      await expect(popover.locator('[data-testid="pick-popover-external-origin"]')).toHaveText("External origin");
    } finally {
      await cleanup();
      await closeServer(server);
    }
  });
});
