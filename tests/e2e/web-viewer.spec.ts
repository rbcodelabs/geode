import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");
const isMac = process.platform === "darwin";

async function launch(vaultPath = testVaultPath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath })
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  const consoleErrors: string[] = [];
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
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

test("setViewState preserves the Web Viewer guest and its back-forward history", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const page = request.url === "/second" ? "Second page" : "First page";
    response.end(`<!doctype html><html><head><title>${page}</title></head><body><h1>${page}</h1></body></html>`);
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-history-vault-"));
  const { app, window, userDataDir, consoleErrors } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__historyLeaf = leaf;
    }, firstUrl);
    expect(await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").length
    )).toBe(1);

    const webView = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view");
    const frame = webView.locator(".web-view-frame");
    const back = webView.locator('button[title="Back"]');
    const forward = webView.locator('button[title="Forward"]');
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);
    const guestId = await frame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
    );
    expect(await app.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)?.navigationHistory.getAllEntries().map((entry) => entry.url),
      guestId
    )).toEqual([firstUrl]);
    expect(await frame.evaluate((guest) =>
      (guest as unknown as { canGoBack(): boolean }).canGoBack()
    )).toBe(false);
    await expect(back).toHaveClass(/is-disabled/);

    await window.evaluate(async (url) => {
      await (window as any).__historyLeaf.setViewState({ type: "webviewer", active: true, state: { url } });
    }, secondUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(secondUrl);

    expect(await frame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
    )).toBe(guestId);
    await expect(back).toHaveCount(1);
    await expect(forward).toHaveCount(1);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { canGoBack(): boolean }).canGoBack()
    )).toBe(true);
    expect(await frame.evaluate((guest) =>
      (guest as unknown as { canGoForward(): boolean }).canGoForward()
    )).toBe(false);
    await expect(back).not.toHaveClass(/is-disabled/);
    await expect(forward).toHaveClass(/is-disabled/);

    await back.click();
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { canGoForward(): boolean }).canGoForward()
    )).toBe(true);
    await expect(webView.locator(".web-view-address")).toHaveValue(firstUrl);
    expect(await window.evaluate(() =>
      (window as any).__historyLeaf.getViewState().state.url
    )).toBe(firstUrl);
    await expect(forward).not.toHaveClass(/is-disabled/);

    await forward.click();
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(secondUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { canGoForward(): boolean }).canGoForward()
    )).toBe(false);
    await expect(webView.locator(".web-view-address")).toHaveValue(secondUrl);
    expect(await window.evaluate(() =>
      (window as any).__historyLeaf.getViewState().state.url
    )).toBe(secondUrl);
    await expect(forward).toHaveClass(/is-disabled/);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("same-leaf navigation remains usable after the Web Viewer guest crashes and recovers", async () => {
  let firstRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/first") firstRequests += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${request.url}</title></head><body>${request.url}</body></html>`);
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-crash-history-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__crashHistoryLeaf = leaf;
    }, firstUrl);

    const frame = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);
    await frame.evaluate((guest) => {
      Object.assign(guest, { __crashHistoryElement: true, __recoveryDomReadyCount: 0 });
      guest.addEventListener("dom-ready", () => {
        (guest as unknown as { __recoveryDomReadyCount: number }).__recoveryDomReadyCount += 1;
      });
    });

    await app.evaluate(({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) =>
        contents.getType() === "webview" && contents.getURL() === url
      );
      if (!guest) throw new Error(`Missing Web Viewer guest for ${url}`);
      guest.forcefullyCrashRenderer();
    }, firstUrl);

    await expect.poll(() => firstRequests, { timeout: 20_000 }).toBeGreaterThan(1);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { __recoveryDomReadyCount?: number }).__recoveryDomReadyCount ?? 0
    ), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);
    expect(await frame.evaluate((guest) =>
      (guest as unknown as { __crashHistoryElement?: boolean }).__crashHistoryElement
    )).toBe(true);

    await window.evaluate(async (url) => {
      await (window as any).__crashHistoryLeaf.setViewState({
        type: "webviewer",
        active: true,
        state: { url },
      });
    }, secondUrl);

    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    ), { timeout: 20_000 }).toBe(secondUrl);
    await expect(window.locator(".web-view-address")).toHaveValue(secondUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("the latest same-leaf setViewState wins before the prior guest navigation commits", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${request.url}</title></head><body>${request.url}</body></html>`);
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-latest-state-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async ({ firstUrl, secondUrl }) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url: firstUrl } });
      await leaf.setViewState({ type: "webviewer", active: true, state: { url: secondUrl } });
    }, { firstUrl, secondUrl });

    const frame = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(secondUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("a hanging guest navigation cannot strand a newer same-leaf setViewState", async () => {
  let markFirstRequested!: () => void;
  const firstRequested = new Promise<void>((resolve) => { markFirstRequested = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/first") {
      markFirstRequested();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Second page</title></head><body>Second page</body></html>");
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-hanging-state-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__hangingHistoryLeaf = leaf;
    }, firstUrl);
    await firstRequested;

    await window.evaluate(async (url) => {
      await (window as any).__hangingHistoryLeaf.setViewState({ type: "webviewer", active: true, state: { url } });
    }, secondUrl);

    const frame = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(secondUrl);
    expect(await window.evaluate(() =>
      (window as any).__hangingHistoryLeaf.getViewState().state.url
    )).toBe(secondUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("stale guest completion and failure cannot overwrite the latest requested state", async () => {
  let markSecondRequested!: () => void;
  const secondRequested = new Promise<void>((resolve) => { markSecondRequested = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/second") {
      markSecondRequested();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>First page</title></head><body>First page</body></html>");
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-stale-state-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__staleHistoryLeaf = leaf;
    }, firstUrl);
    const frame = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);

    await window.evaluate(async (url) => {
      await (window as any).__staleHistoryLeaf.setViewState({ type: "webviewer", active: true, state: { url } });
    }, secondUrl);
    await secondRequested;
    await window.evaluate((staleUrl) => {
      const frame = document.querySelector(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
      if (!frame) throw new Error("Missing Web Viewer frame");
      const completion = new Event("did-navigate");
      Object.defineProperty(completion, "url", { value: staleUrl });
      frame.dispatchEvent(completion);
      const failure = new Event("did-fail-load");
      Object.defineProperties(failure, {
        errorCode: { value: -105 },
        errorDescription: { value: "NAME_NOT_RESOLVED" },
        validatedURL: { value: "" },
        isMainFrame: { value: true },
      });
      frame.dispatchEvent(failure);
    }, firstUrl);

    await expect(window.locator(".web-view-address")).toHaveValue(secondUrl);
    await expect(window.locator(".web-view-error")).toBeHidden();
    expect(await window.evaluate(() =>
      (window as any).__staleHistoryLeaf.getViewState().state.url
    )).toBe(secondUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("a superseded redirect destination cannot overwrite the latest requested state", async () => {
  let markRedirectDestinationRequested!: () => void;
  const redirectDestinationRequested = new Promise<void>((resolve) => {
    markRedirectDestinationRequested = resolve;
  });
  let markLatestRequested!: () => void;
  const latestRequested = new Promise<void>((resolve) => {
    markLatestRequested = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/redirect-destination" });
      response.end();
      return;
    }
    if (request.url === "/redirect-destination") {
      markRedirectDestinationRequested();
      return;
    }
    if (request.url === "/latest") {
      markLatestRequested();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Latest page</title></head><body>Latest page</body></html>");
  });
  const port = await listen(server);
  const redirectUrl = `http://127.0.0.1:${port}/redirect`;
  const redirectDestinationUrl = `http://127.0.0.1:${port}/redirect-destination`;
  const latestUrl = `http://127.0.0.1:${port}/latest`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-stale-redirect-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__staleRedirectLeaf = leaf;
    }, redirectUrl);
    await redirectDestinationRequested;

    // The fixture proves Chromium followed the real redirect. Dispatch the
    // corresponding navigation lifecycle events explicitly so supersession is
    // deterministic even when Electron delivers its redirect event a tick
    // after the server observes the destination request.
    await window.evaluate(({ redirectUrl, redirectDestinationUrl }) => {
      const guest = document.querySelector(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
      if (!guest) throw new Error("Missing Web Viewer frame");
      const start = new Event("did-start-navigation");
      Object.defineProperties(start, {
        url: { value: redirectUrl },
        isInPlace: { value: false },
        isMainFrame: { value: true },
      });
      guest.dispatchEvent(start);
      const redirect = new Event("did-redirect-navigation");
      Object.defineProperties(redirect, {
        url: { value: redirectDestinationUrl },
        isInPlace: { value: false },
        isMainFrame: { value: true },
      });
      guest.dispatchEvent(redirect);
    }, { redirectUrl, redirectDestinationUrl });

    await window.evaluate(async (url) => {
      await (window as any).__staleRedirectLeaf.setViewState({
        type: "webviewer",
        active: true,
        state: { url },
      });
    }, latestUrl);
    await latestRequested;

    const webView = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view");

    await window.evaluate((staleUrl) => {
      const guest = document.querySelector(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
      if (!guest) throw new Error("Missing Web Viewer frame");
      const completion = new Event("did-navigate");
      Object.defineProperty(completion, "url", { value: staleUrl });
      guest.dispatchEvent(completion);
      const failure = new Event("did-fail-load");
      Object.defineProperties(failure, {
        errorCode: { value: -105 },
        errorDescription: { value: "NAME_NOT_RESOLVED" },
        validatedURL: { value: staleUrl },
        isMainFrame: { value: true },
      });
      guest.dispatchEvent(failure);
    }, redirectDestinationUrl);

    await expect(webView.locator(".web-view-address")).toHaveValue(latestUrl);
    await expect(webView.locator(".web-view-error")).toBeHidden();
    expect(await window.evaluate(() =>
      (window as any).__staleRedirectLeaf.getViewState().state.url
    )).toBe(latestUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("same-leaf navigation respawns a guest after a clean exit", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${request.url}</title></head><body>${request.url}</body></html>`);
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const thirdUrl = `http://127.0.0.1:${port}/third`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-clean-exit-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__cleanExitLeaf = leaf;
    }, firstUrl);
    const webView = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view");
    const frame = webView.locator(".web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);

    await frame.evaluate((guest) => {
      const gone = new Event("render-process-gone");
      Object.defineProperty(gone, "details", {
        value: { reason: "clean-exit", exitCode: 0 },
      });
      guest.dispatchEvent(gone);
    });
    await expect(webView.locator(".web-view-error")).toBeVisible();

    await window.evaluate(async (url) => {
      await (window as any).__cleanExitLeaf.setViewState({
        type: "webviewer",
        active: true,
        state: { url },
      });
    }, secondUrl);

    await expect(frame).toHaveAttribute("src", secondUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(secondUrl);
    await expect(webView.locator(".web-view-address")).toHaveValue(secondUrl);
    await expect(webView.locator(".web-view-error")).toBeHidden();
    expect(await window.evaluate(() =>
      (window as any).__cleanExitLeaf.getViewState().state.url
    )).toBe(secondUrl);

    const recoveredGuestId = await frame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
    );
    await frame.evaluate((guest) => {
      const typedGuest = guest as unknown as {
        loadURL(url: string): Promise<void>;
        __postRecoveryLoadUrlCalls?: number;
      };
      const loadURL = typedGuest.loadURL.bind(typedGuest);
      typedGuest.__postRecoveryLoadUrlCalls = 0;
      typedGuest.loadURL = (url: string) => {
        typedGuest.__postRecoveryLoadUrlCalls = (typedGuest.__postRecoveryLoadUrlCalls ?? 0) + 1;
        return loadURL(url);
      };
    });
    await window.evaluate(async (url) => {
      await (window as any).__cleanExitLeaf.setViewState({
        type: "webviewer",
        active: true,
        state: { url },
      });
    }, thirdUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(thirdUrl);
    expect(await frame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
    )).toBe(recoveredGuestId);
    // The respawn's dom-ready re-armed loadURL, so this follow-up navigation
    // reused the recovered guest through its live navigation API.
    expect(await frame.evaluate((guest) =>
      (guest as unknown as { __postRecoveryLoadUrlCalls?: number }).__postRecoveryLoadUrlCalls
    )).toBe(1);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("the latest navigation may redirect back to a previously superseded URL", async () => {
  let firstVisits = 0;
  let markRedirectCommitted!: () => void;
  const redirectCommitted = new Promise<void>((resolve) => { markRedirectCommitted = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/second") {
      response.writeHead(302, { Location: "/first" });
      response.end();
      return;
    }
    firstVisits += 1;
    if (firstVisits === 2) markRedirectCommitted();
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>First page</title></head><body>First page</body></html>");
  });
  const port = await listen(server);
  const firstUrl = `http://127.0.0.1:${port}/first`;
  const secondUrl = `http://127.0.0.1:${port}/second`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-redirect-state-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__redirectHistoryLeaf = leaf;
    }, firstUrl);
    const webView = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view");
    const frame = webView.locator(".web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);

    await window.evaluate(async (url) => {
      await (window as any).__redirectHistoryLeaf.setViewState({ type: "webviewer", active: true, state: { url } });
    }, secondUrl);
    await redirectCommitted;

    await expect(webView.locator(".web-view-address")).toHaveValue(firstUrl);
    await expect(webView.locator(".web-view-error")).toBeHidden();
    expect(await window.evaluate(() =>
      (window as any).__redirectHistoryLeaf.getViewState().state.url
    )).toBe(firstUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { canGoBack(): boolean }).canGoBack()
    )).toBe(true);
    expect(firstVisits).toBe(2);

    await webView.locator('button[title="Back"]').click();
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { canGoForward(): boolean }).canGoForward()
    )).toBe(true);
    expect(await frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(firstUrl);
    await expect(webView.locator(".web-view-address")).toHaveValue(firstUrl);
    expect(await window.evaluate(() =>
      (window as any).__redirectHistoryLeaf.getViewState().state.url
    )).toBe(firstUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("equivalent bare-origin URLs use Electron's canonical committed state", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Canonical page</title></head><body>Canonical page</body></html>");
  });
  const port = await listen(server);
  const rawUrl = `http://127.0.0.1:${port}`;
  const canonicalUrl = `${rawUrl}/`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-canonical-state-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__canonicalHistoryLeaf = leaf;
    }, rawUrl);
    const webView = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view");
    const frame = webView.locator(".web-view-frame");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(canonicalUrl);

    await window.evaluate(async (url) => {
      await (window as any).__canonicalHistoryLeaf.setViewState({ type: "webviewer", active: true, state: { url } });
    }, rawUrl);
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL()
    )).toBe(canonicalUrl);
    await expect(webView.locator(".web-view-address")).toHaveValue(canonicalUrl);
    expect(await window.evaluate(() =>
      (window as any).__canonicalHistoryLeaf.getViewState().state.url
    )).toBe(canonicalUrl);

    const historyState = await frame.evaluate((guest) => ({
      back: (guest as unknown as { canGoBack(): boolean }).canGoBack(),
      forward: (guest as unknown as { canGoForward(): boolean }).canGoForward(),
    }));
    await expect(webView.locator('button[title="Back"]')).toHaveCount(1);
    await expect(webView.locator('button[title="Forward"]')).toHaveCount(1);
    await expect(webView.locator('button[title="Back"]')).toHaveClass(
      historyState.back ? /^(?!.*is-disabled)/ : /is-disabled/
    );
    await expect(webView.locator('button[title="Forward"]')).toHaveClass(
      historyState.forward ? /^(?!.*is-disabled)/ : /is-disabled/
    );
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

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
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-popup-vault-"));
    const { app, window, userDataDir, consoleErrors } = await launch(vaultDir);

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
      expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
    } finally {
      await close(server);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((browserWindow) => browserWindow.destroy()));
      await app.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
}

test("a background popup does not override a tab the user selects while the destination opens", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-background-vault-"));
  const { app, window, userDataDir, consoleErrors } = await launch(vaultDir);
  try {
    await window.evaluate(async () => {
      const geodeApp = (window as any).app;
      const group = geodeApp.workspace.activeGroup;
      (window as any).__backgroundPopupUserChoice = group.active;
      const source = group.createLeaf();
      await source.setViewState({ type: "webviewer", active: true, state: { url: "https://example.com/source" } });
      const originalCreateLeaf = group.createLeaf.bind(group);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      (window as any).__releaseBackgroundPopup = release;
      group.createLeaf = () => {
        const leaf = originalCreateLeaf();
        const originalSetViewState = leaf.setViewState.bind(leaf);
        leaf.setViewState = async (state: any) => {
          if (state.state?.url === "https://example.com/background") await gate;
          return originalSetViewState(state);
        };
        return leaf;
      };
      (window as any).__backgroundPopupGroup = group;
      (window as any).__backgroundPopupSource = source;
    });
    const frame = window.locator('.web-view-frame[src="https://example.com/source"]');
    await expect(frame).toBeVisible();
    const guestId = await frame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
    );
    const leavesBefore = await window.evaluate(() => (window as any).__backgroundPopupGroup.leaves.length);

    await app.evaluate(({ BrowserWindow }, request) => {
      BrowserWindow.getAllWindows()[0].webContents.send("guest-window-open", request);
    }, { url: "https://example.com/background", guestId, disposition: "background-tab" });
    await expect.poll(() => window.evaluate(() => (window as any).__backgroundPopupGroup.leaves.length)).toBe(leavesBefore + 1);
    await window.evaluate(() => {
      const current = window as any;
      const group = current.__backgroundPopupGroup;
      group.setActiveLeaf(current.__backgroundPopupUserChoice);
      current.__releaseBackgroundPopup();
    });
    await expect.poll(() => window.evaluate(() =>
      (window as any).__backgroundPopupGroup.leaves.some((leaf: any) => leaf.view?.getState?.().url === "https://example.com/background")
    )).toBe(true);
    expect(await window.evaluate(() => {
      const current = window as any;
      return current.__backgroundPopupGroup.active === current.__backgroundPopupUserChoice;
    })).toBe(true);
    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

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
    // `launch()` only waits for `.workspace`; the restored session paints its
    // tab headers a frame or two later. A bare `.count()` here can therefore
    // read 0 under load and make the "reuses the tab, adds no new one"
    // assertion below compare against the wrong baseline — observed failing
    // with `Expected: 0, Received: 1`. Wait for the strip to exist first.
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header")).not.toHaveCount(0);
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
          (guest as unknown as { executeJavaScript(script: string): Promise<unknown> }).executeJavaScript(`(() => {
            // The address bar updates before the guest finishes navigating.
            // Poll incomplete documents without throwing on missing elements.
            const heading = document.querySelector('h1');
            const image = document.querySelector('img');
            if (location.protocol !== 'file:' || !location.pathname.endsWith('/Local%20page.html') ||
                !document.body || !heading || !image) return null;
            return {
              title: document.title,
              scriptRan: document.body.dataset.scriptRan,
              color: getComputedStyle(heading).color,
              imageLoaded: image.complete && image.naturalWidth > 0
            };
          })()`)
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
