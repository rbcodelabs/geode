import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Covers Compass assumption `690ae6b7-e170-466e-b745-6161df6631ab` (top-level
 * -window escalation can hand a session back to the tab without breaking
 * continuity) end to end, plus the automatic rejection-signal path that
 * feeds it. See src/main/webauthn-escalation-window.ts and
 * src/renderer/views/web-view.ts's escalation banner / `escalateAuth()`.
 *
 * No real relying party genuinely rejected Geode's embedded `<webview>` in
 * live-code verification (webauthn.io and Google Sign-In both rendered and
 * completed ceremonies normally — see the PR description). There is also no
 * page-JS-observable signal that distinguishes an Electron `<webview>` guest
 * from a true top-level `BrowserWindow` (both report `window.top ===
 * window.self`), so a fixture cannot honestly simulate "denies the guest,
 * allows the real window" by branching on that. Instead, this suite verifies
 * the two mechanism halves independently against real, unmocked behavior:
 *   1. a page whose own restrictive `Permissions-Policy` header makes
 *      Chromium's real WebAuthn implementation throw a genuine
 *      SecurityError, proving the guest-side detection + banner work against
 *      a real API rejection (not a stubbed one);
 *   2. a real top-level `BrowserWindow`, opened on the Web Viewer's shared
 *      `persist:webviewer` partition, actually receiving a cookie set via a
 *      real HTTP round trip from inside that window — and that cookie
 *      actually reaching the original tab on reload — proving session
 *      continuity survives the escalation round trip.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");
const AUTH_COOKIE = "geode_e2e_auth";

async function launch(vaultPath = testVaultPath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webauthn-escalation-e2e-"));
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

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WebAuthn escalation fixture did not bind to TCP");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/**
 * Fixture: `/rejects` sets a Permissions-Policy header that makes a real
 * `navigator.credentials.create()` call throw a genuine SecurityError,
 * regardless of embedding. `/signin` reflects whether the auth cookie is
 * present. `POST /complete` sets it — called only from inside the real
 * escalation window in the merge-back test, to model "the ceremony
 * completed in the top-level window."
 */
function createFixtureServer(): http.Server {
  return http.createServer((request, response) => {
    if (request.url === "/rejects") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Permissions-Policy": "publickey-credentials-create=(), publickey-credentials-get=()",
      });
      response.end(`<!doctype html><html><head><title>Rejects</title></head><body>
        <script>
          window.__attemptCreate = () => navigator.credentials.create({
            publicKey: {
              challenge: new Uint8Array(32),
              rp: { name: "Geode E2E fixture" },
              user: { id: new Uint8Array(16), name: "e2e", displayName: "e2e" },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            },
          });
        </script>
      </body></html>`);
      return;
    }
    if (request.method === "POST" && request.url === "/complete") {
      response.writeHead(204, { "Set-Cookie": `${AUTH_COOKIE}=1; Path=/` });
      response.end();
      return;
    }
    if (request.url === "/signin") {
      const signedIn = (request.headers.cookie ?? "").includes(`${AUTH_COOKIE}=1`);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>${signedIn ? "Signed in" : "Signed out"}</title></head><body>${signedIn ? "Signed in" : "Signed out"}</body></html>`
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

test("a rejected in-webview WebAuthn ceremony surfaces the escalation banner", async () => {
  const server = createFixtureServer();
  const port = await listen(server);
  const rejectsUrl = `http://127.0.0.1:${port}/rejects`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webauthn-banner-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__escalationLeaf = leaf;
    }, rejectsUrl);

    const webView = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view");
    const frame = webView.locator(".web-view-frame");
    await expect.poll(() =>
      frame.evaluate((guest) => (guest as unknown as { getURL(): string }).getURL())
    ).toBe(rejectsUrl);

    const banner = webView.locator(".web-view-escalation-banner");
    await expect(banner).toBeHidden();

    // Trigger the real (unmocked) WebAuthn call; Chromium's own Permissions
    // Policy enforcement rejects it, and the guest's injected wrapper
    // (webviewer-bridge-preload.ts) reports the rejection to the host.
    await frame.evaluate((guest) =>
      (guest as unknown as { executeJavaScript(script: string): Promise<unknown> }).executeJavaScript(
        "window.__attemptCreate().catch(() => {})"
      )
    );

    await expect(banner).toBeVisible({ timeout: 10000 });
    // Chromium's real (unmocked) WebAuthn implementation names this
    // rejection NotAllowedError, not SecurityError, when a document's own
    // Permissions Policy disallows publickey-credentials-create — verified
    // empirically against this fixture rather than assumed from the spec.
    await expect(banner).toContainText("NotAllowedError");
    await expect(banner.locator(".web-view-escalation-continue")).toBeVisible();
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("escalating to a top-level window merges the session back into the original tab", async () => {
  const server = createFixtureServer();
  const port = await listen(server);
  const signinUrl = `http://127.0.0.1:${port}/signin`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webauthn-merge-vault-"));
  const { app, window, userDataDir } = await launch(vaultDir);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__mergeLeaf = leaf;
    }, signinUrl);

    // Read the guest's title through the main process (webContents API)
    // rather than a Playwright locator's `.evaluate()`: the latter attaches
    // Playwright's own CDP automation session to the guest's WebContents
    // target, and doing that immediately before a NEW top-level
    // BrowserWindow is created on the same session partition was observed
    // to intermittently tear down the whole Electron connection while
    // building this test (a driver-level interaction, not an application
    // bug — the underlying escalateAuth()/openEscalationWindow path was
    // separately verified crash-free via direct main-process scripting).
    // `app.evaluate` reads it via plain Electron IPC instead, with no extra
    // CDP target ever attached to the guest.
    const readGuestTitle = () =>
      app.evaluate(({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.getURL() === url);
        return guest ? guest.executeJavaScript("document.title") : null;
      }, signinUrl);
    await expect.poll(readGuestTitle).toBe("Signed out");

    const initialWindowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    // Driven directly against the WebView instance rather than through the
    // "Continue in a separate window" menu item: the menu's DOM path is
    // already covered by the tab-menu E2E suite, and this test's subject is
    // the session-merge outcome of escalateAuth() itself.
    //
    // Fired without awaiting its returned promise from inside window.evaluate:
    // escalateAuth() doesn't resolve until the escalation window closes,
    // seconds later. Holding Playwright's `Runtime.evaluate(awaitPromise:
    // true)` open across that whole span — while the test concurrently opens
    // a brand-new top-level window and drives it via app.evaluate — was
    // observed to intermittently tear down the entire Electron CDP
    // connection ("Target page, context or browser has been closed") while
    // building this test, even though the exact same call sequence run
    // outside the Playwright test runner (a plain script) never failed.
    // Stash completion in a page-global instead and poll it.
    await window.evaluate(() => {
      (window as any).__escalateDone = false;
      (window as any).__mergeLeaf.view.escalateAuth().then(() => {
        (window as any).__escalateDone = true;
      });
    });

    await expect.poll(async () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(initialWindowCount + 1);

    // Real top-level window, scoped to the sign-in origin, on the Web
    // Viewer's own shared session partition (not the guest's isolated
    // WebContents) — the escalation window's whole reason to exist. Polled:
    // the window exists as soon as `new BrowserWindow(...)` runs, but
    // `loadURL` hasn't necessarily committed yet, so `getURL()` can still be
    // empty on the first read.
    const readEscalationWindow = () =>
      app.evaluate(({ BrowserWindow, session }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().startsWith("file://"));
        if (!win) return null;
        return {
          title: win.getTitle(),
          url: win.webContents.getURL(),
          sharesWebViewerPartition: win.webContents.session === session.fromPartition("persist:webviewer"),
          webContentsId: win.webContents.id,
        };
      });
    await expect.poll(async () => (await readEscalationWindow())?.url).toBe(signinUrl);
    const escalationWindow = await readEscalationWindow();
    expect(escalationWindow).not.toBeNull();
    expect(escalationWindow?.sharesWebViewerPartition).toBe(true);
    expect(escalationWindow?.title).toContain("127.0.0.1");
    expect(escalationWindow?.url).toBe(signinUrl);

    // Model "the ceremony completed in the real top-level window": a real
    // fetch from inside THAT window's own WebContents, not the guest's.
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents) throw new Error("Escalation window WebContents not found");
      return contents.executeJavaScript("fetch('/complete', { method: 'POST' }).then(() => true)");
    }, escalationWindow!.webContentsId);

    await expect.poll(async () =>
      app.evaluate(async ({ session }) => {
        const cookies = await session.fromPartition("persist:webviewer").cookies.get({ name: "geode_e2e_auth" });
        return cookies.length;
      })
    ).toBeGreaterThan(0);

    // Simulate the user finishing and closing the real escalation window —
    // this is what resolves escalateAuth()'s promise (webauthn-escalation-
    // window.ts's `closed` handler).
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === id)?.close();
    }, escalationWindow!.webContentsId);

    await expect.poll(() => window.evaluate(() => (window as any).__escalateDone)).toBe(true);

    await expect.poll(async () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(initialWindowCount);

    // The original tab's guest reloaded itself (WebView.escalateAuth() ->
    // reload()) and, sharing the same session partition, now sends the
    // cookie the escalation window's own request set — so the SAME fixture
    // route that said "Signed out" before now says "Signed in", with no
    // navigation the user didn't ask for.
    await expect.poll(readGuestTitle, { timeout: 20000 }).toBe("Signed in");
    const guestUrl = await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview");
      return guest?.getURL() ?? null;
    });
    expect(guestUrl).toBe(signinUrl);
  } finally {
    await close(server);
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
