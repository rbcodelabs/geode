import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Serves a page that calls `window.__geode?.postEvent('decision.approved', {
 * decisionId: 'test-1' })` on load, once the bridge global exists (the
 * preload runs before the page script, but poll defensively rather than
 * assuming ordering nuances hold across Electron versions).
 */
function startFixtureServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<title>connector fixture</title>
<body>
<script>
  function tryPost() {
    if (window.__geode && typeof window.__geode.postEvent === "function") {
      window.__geode.postEvent("decision.approved", { decisionId: "test-1" });
    } else {
      setTimeout(tryPost, 20);
    }
  }
  tryPost();
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

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function launch(extraArgs: string[] = []) {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-bridge-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-bridge-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`, ...extraArgs],
    cwd: repoRoot,
  });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  const cleanup = () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, cleanup };
}

/** Registers the test-only listener before the page's postEvent call can race it. */
async function armListener(window: import("@playwright/test").Page, url: string) {
  await window.evaluate(async (u) => {
    (window as any).__lastWebViewerEvent = null;
    const geodeApp = (window as any).app;
    geodeApp.workspace.on("web-viewer:event", (ev: unknown) => {
      (window as any).__lastWebViewerEvent = ev;
    });
    const leaf = geodeApp.workspace.getLeaf(true);
    await leaf.setViewState({ type: "webviewer", active: true, state: { url: u } });
  }, url);
  await window.waitForSelector(".web-view-frame");
}

test("a connector event posted from an allowlisted origin reaches the workspace bus, normalized", async () => {
  const { server, port } = await startFixtureServer();
  const { app, window, cleanup } = await launch([
    `--host-resolver-rules=MAP compass.rbcodelabs.com 127.0.0.1:${port}`,
  ]);

  try {
    const url = `http://compass.rbcodelabs.com:${port}/`;
    await armListener(window, url);

    await expect.poll(() => window.evaluate(() => (window as any).__lastWebViewerEvent)).not.toBeNull();
    const event = await window.evaluate(() => (window as any).__lastWebViewerEvent);
    expect(event).toMatchObject({
      source: "compass",
      type: "decision.approved",
      payload: { decisionId: "test-1" },
    });
    expect((event as { url: string }).url).toContain("compass.rbcodelabs.com");
    expect(typeof (event as { timestamp: unknown }).timestamp).toBe("number");
  } finally {
    await app.close();
    cleanup();
    await closeServer(server);
  }
});

test("a connector event posted from a non-allowlisted origin never reaches the workspace bus", async () => {
  const { server, port } = await startFixtureServer();
  // Deliberately no --host-resolver-rules mapping: this is a plain 127.0.0.1
  // origin, which is not in WEB_VIEWER_CONNECTORS. Proves the origin check
  // itself is the security gate, not merely bridge/preload presence.
  const { app, window, cleanup } = await launch();

  try {
    const url = `http://127.0.0.1:${port}/`;
    await armListener(window, url);

    // Give the page's postEvent call (and any bridge round-trip, if it were
    // wrongly permitted) ample time to land before asserting it did not.
    await window.waitForTimeout(1000);
    const event = await window.evaluate(() => (window as any).__lastWebViewerEvent);
    expect(event).toBeNull();
  } finally {
    await app.close();
    cleanup();
    await closeServer(server);
  }
});
