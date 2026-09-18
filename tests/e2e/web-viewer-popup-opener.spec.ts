import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import {
  activateWebViewerTab,
  activeWebViewerUrl,
  inGuest,
  openWebViewerTab,
  waitForGuest,
  webViewerLeafCount,
} from "./helpers/web-viewer-guest";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * A real HTTP origin is required, not a data: or file: URL: main.ts's
 * window-open handler only forwards http/https targets, and the popup relay
 * refuses opaque origins outright (see `originOf`). Same reason
 * tests/e2e/web-viewer-bridge-event.spec.ts stands up a local server.
 *
 * `/opener` records everything it receives and opens a target from a click —
 * `?target=` chooses it, defaulting to `/popup`.
 * `/popup` captures `window.opener` in a top-of-body inline script — which is
 * also the assertion that the main-world shim lands before the page's own
 * scripts run, not merely before DOMContentLoaded.
 * `/redirect-start` 302s to `/popup` without ever committing a document of its
 * own, which is the OAuth shape `window.open('/auth/start')` produces.
 */
function startFixtureServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    if (pathname === "/redirect-start") {
      // No body at all: the requested URL never becomes a committed document,
      // so anything that pairs on the *committed* URL has nothing to match.
      res.writeHead(302, { Location: "/popup" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (pathname === "/popup") {
      res.end(`<!doctype html>
<title>popup fixture</title>
<body>
<script>
  window.__openerAtParse = typeof window.opener;
  window.__hasOpener = !!window.opener;
  window.__received = [];
  window.addEventListener("message", function (e) {
    window.__received.push({ data: e.data, origin: e.origin, fromOpener: e.source === window.opener });
  });
  window.__postToOpener = function (message, targetOrigin) {
    window.opener.postMessage(message, targetOrigin);
  };
</script>
</body>`);
      return;
    }
    const target = requestUrl.searchParams.get("target") ?? "/popup";
    res.end(`<!doctype html>
<title>opener fixture</title>
<body>
<!-- Full-bleed so a synthesized mouse event at any plausible coordinate lands
     on it: the background-tab case needs a real modified click, which can only
     be delivered by coordinate (see the test). -->
<style>html,body{margin:0;height:100%}#open{display:block;width:100%;height:100%}</style>
<button id="open">open</button>
<script>
  window.__popup = null;
  window.__openReturnedNull = null;
  window.__received = [];
  window.addEventListener("message", function (e) {
    window.__received.push({ data: e.data, origin: e.origin, fromPopup: e.source === window.__popup });
  });
  document.getElementById("open").addEventListener("click", function () {
    window.__popup = window.open(${JSON.stringify(target)});
    window.__openReturnedNull = window.__popup === null;
  });
</script>
</body>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server did not bind to TCP");
      resolve({ server, port: address.port });
    });
  });
}

async function launch() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-popup-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-popup-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  return {
    app,
    window: window as Page,
    cleanup: () => {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

test("a popup reparented into a tab keeps a working opener relationship", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch();
  const origin = `http://127.0.0.1:${port}`;

  try {
    await openWebViewerTab(window, `${origin}/opener`);
    await waitForGuest(window, "/opener");

    // --- window.open returns a usable handle, and opens a second tab --------
    await inGuest(window, "/opener", "document.getElementById('open').click()", true);
    await expect.poll(() => webViewerLeafCount(window), { timeout: 20_000 }).toBe(2);
    expect(await inGuest(window, "/opener", "window.__openReturnedNull")).toBe(false);
    expect(await inGuest(window, "/opener", "typeof window.__popup.postMessage")).toBe("function");

    await waitForGuest(window, "/popup");

    // --- window.opener exists in the popup, already at parse time -----------
    expect(await inGuest(window, "/popup", "window.__openerAtParse")).toBe("object");
    expect(await inGuest(window, "/popup", "window.__hasOpener")).toBe(true);
    expect(await inGuest(window, "/popup", "typeof window.opener.postMessage")).toBe("function");

    // --- popup -> opener: the OAuth handshake -------------------------------
    await inGuest(window, "/popup", `window.__postToOpener({ token: "abc123" }, ${JSON.stringify(origin)})`);
    await expect.poll(() => inGuest<unknown[]>(window, "/opener", "window.__received"), { timeout: 10_000 })
      .toEqual([{ data: { token: "abc123" }, origin, fromPopup: true }]);

    // --- opener -> popup ----------------------------------------------------
    await inGuest(window, "/opener", `window.__popup.postMessage({ ack: true }, ${JSON.stringify(origin)})`);
    await expect.poll(() => inGuest<unknown[]>(window, "/popup", "window.__received"), { timeout: 10_000 })
      .toEqual([{ data: { ack: true }, origin, fromOpener: true }]);

    // --- a mismatched targetOrigin is dropped, as a browser drops it ---------
    await inGuest(window, "/opener", `window.__popup.postMessage({ leaked: true }, "https://elsewhere.example")`);
    await window.waitForTimeout(750);
    expect(await inGuest<unknown[]>(window, "/popup", "window.__received")).toHaveLength(1);

    // --- window.close() in the popup closes its tab and flips handle.closed --
    expect(await inGuest(window, "/opener", "window.__popup.closed")).toBe(false);
    await inGuest(window, "/popup", "window.close()");
    await expect.poll(() => webViewerLeafCount(window), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => inGuest<boolean>(window, "/opener", "window.__popup.closed"), { timeout: 10_000 })
      .toBe(true);
  } finally {
    await app.close();
    cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("a popup that redirects before committing any document still gets its opener", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch();
  const origin = `http://127.0.0.1:${port}`;

  try {
    // `window.open('/auth/start')` where `/auth/start` immediately 302s to an
    // identity provider is the single most common real shape of this feature,
    // and the one a committed-URL match cannot see: the requested URL never
    // commits, so the popup guest's first document is already at the redirect
    // target. Pairing therefore happens at the guest's first *navigation
    // start*, which is still the requested URL.
    await openWebViewerTab(window, `${origin}/opener?target=${encodeURIComponent("/redirect-start")}`);
    await waitForGuest(window, "/opener");

    await inGuest(window, "/opener", "document.getElementById('open').click()", true);
    await expect.poll(() => webViewerLeafCount(window), { timeout: 20_000 }).toBe(2);
    await waitForGuest(window, "/popup");

    // The popup landed somewhere the opener never named, and is still paired.
    expect(await inGuest(window, "/popup", "location.pathname")).toBe("/popup");
    expect(await inGuest(window, "/popup", "window.__hasOpener")).toBe(true);

    await inGuest(window, "/popup", `window.__postToOpener({ token: "after-redirect" }, ${JSON.stringify(origin)})`);
    await expect.poll(() => inGuest<unknown[]>(window, "/opener", "window.__received"), { timeout: 10_000 })
      .toEqual([{ data: { token: "after-redirect" }, origin, fromPopup: true }]);
  } finally {
    await app.close();
    cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("a Web Viewer tab the user opened has no opener", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch();

  try {
    // The same page the popup case uses, opened the ordinary way. Sites branch
    // on `if (window.opener)` to detect popup-ness, so defining it here would
    // be a real behavior regression, not a harmless extra.
    await openWebViewerTab(window, `http://127.0.0.1:${port}/popup`);
    await waitForGuest(window, "/popup");

    expect(await inGuest(window, "/popup", "window.__hasOpener")).toBe(false);
    expect(await inGuest(window, "/popup", "window.opener === null")).toBe(true);
  } finally {
    await app.close();
    cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("focus() raises the popup's tab, and the popup can raise its opener's", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch();
  const origin = `http://127.0.0.1:${port}`;

  try {
    await openWebViewerTab(window, `${origin}/opener`);
    await waitForGuest(window, "/opener");
    await inGuest(window, "/opener", "document.getElementById('open').click()", true);
    await waitForGuest(window, "/popup");

    // `window.open` produces a foreground tab, so the popup starts in front.
    await expect.poll(() => activeWebViewerUrl(window), { timeout: 20_000 }).toContain("/popup");

    // Put the opener back in front by hand, so the next activation can only
    // have come from the shim.
    await activateWebViewerTab(window, "/opener");
    await expect.poll(() => activeWebViewerUrl(window), { timeout: 10_000 }).toContain("/opener");

    await inGuest(window, "/opener", "window.__popup.focus()");
    await expect.poll(() => activeWebViewerUrl(window), { timeout: 10_000 }).toContain("/popup");

    // The other direction, which a real browser also allows: a popup may raise
    // its opener even though it may not close it.
    await inGuest(window, "/popup", "window.opener.focus()");
    await expect.poll(() => activeWebViewerUrl(window), { timeout: 10_000 }).toContain("/opener");
  } finally {
    await app.close();
    cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("a popup opened into a background tab pairs without being activated", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch();
  const origin = `http://127.0.0.1:${port}`;

  try {
    await openWebViewerTab(window, `${origin}/opener`);
    await waitForGuest(window, "/opener");

    // Observe the disposition rather than assume it: `background-tab` is not
    // something a test can ask for, it is what Chromium decides when
    // `window.open` runs inside a ctrl/cmd-modified activation. Listening
    // alongside the app's own handler (an extra listener, not a replacement)
    // keeps the tab opening normally.
    await window.evaluate(() => {
      const state = window as unknown as { __dispositions: string[] };
      state.__dispositions = [];
      // The host renderer runs unisolated with node integration (see the
      // webPreferences comment in main.ts), so this is the same ipcRenderer
      // the preload's onGuestWindowOpen is listening on.
      const { ipcRenderer } = (window as unknown as { require(id: string): any }).require("electron");
      ipcRenderer.on("guest-window-open", (_event: unknown, request: { disposition: string }) => {
        state.__dispositions.push(request.disposition);
      });
    });

    // Delivered by coordinate into the guest, because only a real input event
    // carries modifiers: `executeJavaScript(code, userGesture)` grants user
    // activation but no modifier state, and Chromium reads the *current input
    // event* to decide the disposition. The fixture's button is full-bleed.
    await app.evaluate(async ({ webContents }, target) => {
      const guest = webContents.getAllWebContents()
        .find((contents) => contents.getType() === "webview" && contents.getURL().includes(target));
      if (!guest) throw new Error(`no guest at ${target}`);
      // macOS opens a background tab with cmd; every other platform with ctrl.
      const modifiers: ("meta" | "control")[] = process.platform === "darwin" ? ["meta"] : ["control"];
      guest.focus();
      for (const type of ["mouseDown", "mouseUp"] as const) {
        guest.sendInputEvent({ type, x: 60, y: 60, button: "left", clickCount: 1, modifiers });
      }
    }, "/opener");

    await expect.poll(() => webViewerLeafCount(window), { timeout: 20_000 }).toBe(2);
    expect(await window.evaluate(() => (window as unknown as { __dispositions: string[] }).__dispositions))
      .toEqual(["background-tab"]);

    // The point of the case: the new tab never comes to the front, and yet it
    // is fully alive behind the opener. That only holds because background
    // leaves stay mounted — an unmounted leaf has no guest to pair at all.
    expect(await activeWebViewerUrl(window)).toContain("/opener");
    await waitForGuest(window, "/popup");
    expect(await activeWebViewerUrl(window)).toContain("/opener");

    expect(await inGuest(window, "/popup", "window.__hasOpener")).toBe(true);
    await inGuest(window, "/popup", `window.__postToOpener({ token: "background" }, ${JSON.stringify(origin)})`);
    await expect.poll(() => inGuest<unknown[]>(window, "/opener", "window.__received"), { timeout: 10_000 })
      .toEqual([{ data: { token: "background" }, origin, fromPopup: true }]);
  } finally {
    await app.close();
    cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test("a pairing pending in one window cannot be claimed from another", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch();
  const origin = `http://127.0.0.1:${port}`;
  const secondVault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-popup-vault-b-"));

  try {
    const secondWindowReady = app.waitForEvent("window");
    await window.evaluate((vaultPath) => window.geode.openVaultWindow(vaultPath), secondVault);
    const secondWindow = await secondWindowReady;
    await expect(secondWindow.locator(".workspace")).toBeVisible();

    await openWebViewerTab(window, `${origin}/opener`);
    await waitForGuest(window, "/opener");

    // Stop the *first* window's renderer from reparenting the popup into a
    // tab. Main still records the request — that happens inside the
    // window-open handler, before the renderer is told anything — so this
    // leaves exactly the state the other window would have to exploit: a live,
    // unclaimed pairing for `/popup`, in window one, inside its TTL.
    await window.evaluate(() => {
      const { ipcRenderer } = (window as unknown as { require(id: string): any }).require("electron");
      ipcRenderer.removeAllListeners("guest-window-open");
    });
    await inGuest(window, "/opener", "document.getElementById('open').click()", true);
    expect(await inGuest(window, "/opener", "window.__openReturnedNull")).toBe(false);
    expect(await webViewerLeafCount(window)).toBe(1);

    // The second window opens the very same URL, in a guest that attached
    // after the request was recorded. Every rule except the window matches.
    await openWebViewerTab(secondWindow, `${origin}/popup`);
    await waitForGuest(secondWindow, "/popup");
    expect(await inGuest(secondWindow, "/popup", "window.__hasOpener")).toBe(false);
    expect(await inGuest(secondWindow, "/popup", "window.opener === null")).toBe(true);

    // The control: the request really was still there to take. Claiming it
    // from a fresh tab in the *owning* window is the residual heuristic ADR
    // 0021 documents, and here it is what proves the second window was turned
    // away on the window rule rather than on an expired or consumed entry.
    await openWebViewerTab(window, `${origin}/popup`);
    await waitForGuest(window, "/popup");
    expect(await inGuest(window, "/popup", "window.__hasOpener")).toBe(true);

    // And the second window is still unpaired after the fact.
    expect(await inGuest(secondWindow, "/popup", "window.__hasOpener")).toBe(false);
  } finally {
    await app.close();
    cleanup();
    fs.rmSync(secondVault, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});
