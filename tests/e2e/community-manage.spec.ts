import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "e2e-managed",
  name: "E2E Managed Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Managed plugin for e2e.",
  author: "geode-tests",
};
const MAIN_JS = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin { onload(){ console.log("managed loaded"); } };`;

async function startFakeGithub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    if (req.url === "/repos/geode-tests/managed/releases") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          {
            tag_name: "1.0.0",
            prerelease: false,
            published_at: "2026-06-01T00:00:00Z",
            assets: [
              { name: "manifest.json", browser_download_url: `${base}/dl/manifest.json` },
              { name: "main.js", browser_download_url: `${base}/dl/main.js` },
            ],
          },
        ])
      );
    } else if (req.url === "/dl/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MANIFEST));
    } else if (req.url === "/dl/main.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(MAIN_JS);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchApp(githubUrl: string): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  vaultPath: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath })
  );
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_GITHUB_API_BASE: githubUrl, GEODE_GITHUB_RAW_BASE: githubUrl },
  });
  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  return { app, window, userDataDir, vaultPath, consoleErrors };
}

test("manages a tracked plugin from Settings: toggle auto-update, then uninstall", async () => {
  const github = await startFakeGithub();
  const { app, window, userDataDir, vaultPath, consoleErrors } = await launchApp(github.url);
  const pluginDir = path.join(vaultPath, ".geode", "plugins", "e2e-managed");
  const communityPath = path.join(vaultPath, ".geode", "community.json");

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    // Install + enable via the modal.
    await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("community-add"));
    const modal = window.locator(".mod-community-install");
    await expect(modal).toBeVisible();
    await modal.locator(".community-repo-input").fill("geode-tests/managed");
    await modal.locator(".community-enable-checkbox").check();
    await modal.locator(".community-install-btn").click();
    await expect(modal).toBeHidden();
    await expect.poll(() => fs.existsSync(pluginDir), { timeout: 5000 }).toBe(true);

    // Open Settings → Community tab → the managed item shows in the list.
    // Settings now opens on Appearance; the community list lives behind its
    // own vertical-tab, so click into it the way a user would.
    await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("open-settings"));
    await window
      .locator(".vertical-tab-nav-item", { hasText: "Community plugins & themes" })
      .click();
    const rowLoc = window.locator('.community-item[data-repo="geode-tests/managed"]');
    await expect(rowLoc).toBeVisible();
    await expect(rowLoc.locator(".community-item-sub")).toContainText("v1.0.0");

    // Toggle auto-update on — persists to community.json.
    await rowLoc.locator(".community-item-toggle input").first().check();
    await expect
      .poll(() => JSON.parse(fs.readFileSync(communityPath, "utf8")).items[0].autoUpdate, {
        timeout: 5000,
      })
      .toBe(true);

    // Uninstall — files removed, plugin disabled, item untracked.
    await rowLoc.getByText("Uninstall", { exact: true }).click();
    await expect
      .poll(() => fs.existsSync(path.join(pluginDir, "manifest.json")), { timeout: 5000 })
      .toBe(false);
    await expect
      .poll(() => JSON.parse(fs.readFileSync(communityPath, "utf8")).items.length, { timeout: 5000 })
      .toBe(0);
    expect(
      await window.evaluate(() =>
        (window as unknown as { app: any }).app.pluginManager.isEnabled("e2e-managed")
      )
    ).toBe(false);
    await expect(window.locator(".community-empty")).toBeVisible();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await github.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
