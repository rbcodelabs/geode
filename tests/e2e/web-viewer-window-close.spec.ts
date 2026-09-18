import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { inGuest, openWebViewerTab, waitForGuest, webViewerLeafCount } from "./helpers/web-viewer-guest";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * A real HTTP origin, not a data: URL: `window.close()` is only interesting on
 * a page Chromium treats as a normal document, and the rest of the Web Viewer
 * E2E suite stands up a local server for the same reason.
 */
function startFixtureServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<title>self-closing fixture</title>
<body><button id="go">close me</button>
<script>document.getElementById("go").addEventListener("click", function () { window.close(); });</script>
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

test("a page that calls window.close() closes its Web Viewer tab", async () => {
  const { server, port } = await startFixtureServer();
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-close-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-close-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();

  try {
    const url = `http://127.0.0.1:${port}/close-me`;
    await openWebViewerTab(window, url);
    // Deliberately not `waitForSelector(".web-view-frame")`: that resolves
    // while the guest is still on about:blank, and the click below then fails
    // with GUEST_VIEW_MANAGER_CALL. See waitForGuest.
    await waitForGuest(window, "/close-me");
    expect(await webViewerLeafCount(window)).toBe(1);

    await inGuest(window, "/close-me", "document.getElementById('go').click()", true);

    await expect.poll(() => webViewerLeafCount(window), { timeout: 15_000 }).toBe(0);
    // The app itself must survive: closing the last web tab is a tab close,
    // not an application quit.
    expect(await window.evaluate(() => !!(window as unknown as { app: unknown }).app)).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});
