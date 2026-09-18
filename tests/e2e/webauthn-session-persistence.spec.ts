import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Covers the build package's fourth deliverable: verify that an
 * authenticated Web Viewer session (the outcome of either the in-webview or
 * top-level-escalation WebAuthn path) persists across tab close and app
 * restart, within the existing `persist:webviewer` session-partition model —
 * the same partition src/main/chrome-cookies.ts already relies on for
 * "Import cookies from Chrome" to survive relaunch. Compass task
 * `bf1f3d51-467b-4682-aaa8-dc7bac35c58b`.
 *
 * Sets the cookie directly through `session.cookies.set` (the same API
 * chrome-cookies.ts uses) rather than re-running a full WebAuthn ceremony:
 * this test's subject is the session-partition's own persistence guarantee,
 * which is independent of how the cookie was obtained — that "how" is
 * already covered by webauthn-webview.spec.ts (in-webview) and
 * webauthn-escalation.spec.ts (top-level-window escalation).
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");
const AUTH_COOKIE = "geode_e2e_persist_auth";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind to TCP");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function createFixtureServer(): http.Server {
  return http.createServer((request, response) => {
    const signedIn = (request.headers.cookie ?? "").includes(`${AUTH_COOKIE}=1`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><title>${signedIn ? "Signed in" : "Signed out"}</title></head><body>${signedIn ? "Signed in" : "Signed out"}</body></html>`
    );
  });
}

async function readGuestTitle(app: Awaited<ReturnType<typeof electron.launch>>, url: string) {
  return app.evaluate(({ webContents }, targetUrl) => {
    const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.getURL() === targetUrl);
    return guest ? guest.executeJavaScript("document.title") : null;
  }, url);
}

test("an authenticated Web Viewer session survives tab close and app restart", async () => {
  const server = createFixtureServer();
  const port = await listen(server);
  const fixtureUrl = `http://127.0.0.1:${port}/`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webauthn-persist-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
  );
  const launch = () => electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });

  try {
    // --- First launch: open the tab, authenticate, close the tab ---
    let app = await launch();
    let window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);

    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__persistLeaf = leaf;
    }, fixtureUrl);

    await expect.poll(() => readGuestTitle(app, fixtureUrl)).toBe("Signed out");

    // Set the auth cookie directly on the shared partition — the same API
    // (`session.cookies.set`) src/main/chrome-cookies.ts already uses, and
    // the same partition both the in-webview and escalation-window WebAuthn
    // paths write into.
    await app.evaluate(
      async ({ session }, { url, name }) => {
        const target = session.fromPartition("persist:webviewer");
        // A real identity provider's auth cookie sets an expiry so the user
        // stays signed in — without one, `cookies.set` creates a SESSION
        // cookie, which browsers (correctly) discard when the session ends,
        // regardless of the partition's own on-disk durability. Omitting
        // this is what made this test fail on its first pass, model this
        // faithfully rather than "fixing" the assertion around it.
        await target.cookies.set({
          url,
          name,
          value: "1",
          path: "/",
          expirationDate: Math.floor(Date.now() / 1000) + 86400,
        });
        // Same durability step src/main/chrome-cookies.ts and
        // webauthn-escalation-window.ts's `finish()` both take: force the
        // persistent cookie store to disk rather than trusting it was
        // already flushed before the process later exits.
        await target.cookies.flushStore();
      },
      { url: fixtureUrl, name: AUTH_COOKIE }
    );

    // Reload so the guest's next request actually carries the new cookie,
    // then close the tab entirely — the first half of "survives tab close".
    await window.evaluate(async () => {
      await (window as any).__persistLeaf.view.reload();
    });
    await expect.poll(() => readGuestTitle(app, fixtureUrl)).toBe("Signed in");

    // Same primitive the tab header's own close (x) button uses
    // (workspace.ts's `leaf.detach()`) — the real "close this tab" path.
    // Closing the last leaf in the last group replaces it with a fresh,
    // unrelated Web Viewer guest (Geode's default empty-tab content) rather
    // than leaving zero webview guests, so the assertion checks that THIS
    // specific guest (matching the fixture URL) is gone — not "no webviews
    // at all".
    await window.evaluate(async () => {
      await (window as any).__persistLeaf.detach();
    });
    await expect.poll(
      () =>
        app.evaluate(({ webContents }, url) =>
          webContents.getAllWebContents().some((c) => c.getType() === "webview" && c.getURL() === url),
        fixtureUrl),
      { timeout: 10000 }
    ).toBe(false);

    await app.close();

    // --- Second launch: relaunch on the SAME user-data-dir (same disk-
    // backed persist:webviewer session) and reopen the tab from cold ---
    app = await launch();
    window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);

    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__persistLeafAfterRestart = leaf;
    }, fixtureUrl);

    // No new authentication happened this launch — if this reads "Signed
    // in", the cookie truly survived a full process restart on disk, not
    // just an in-memory session that happened to still be warm.
    await expect.poll(() => readGuestTitle(app, fixtureUrl)).toBe("Signed in");

    await app.close();
  } finally {
    await close(server);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
