import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * A tiny fake GitHub that serves one plugin release + its assets, so the
 * install flow can be exercised end-to-end without hitting the network. The
 * main process is pointed at it via GEODE_GITHUB_API_BASE / _RAW_BASE (the
 * same env seam the resolver uses in production).
 */
const PLUGIN_MANIFEST = {
  id: "e2e-installed",
  name: "E2E Installed Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Installed from a fake GitHub during e2e.",
  author: "geode-tests",
};
const PLUGIN_MAIN_JS = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  onload() { console.log("e2e-installed plugin loaded"); }
};
`;

async function startFakeGithub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    if (url === "/repos/geode-tests/sample-plugin/releases") {
      const releases = [
        {
          tag_name: "1.0.0",
          prerelease: false,
          published_at: "2026-06-01T00:00:00Z",
          assets: [
            { name: "manifest.json", browser_download_url: `${base}/dl/manifest.json` },
            { name: "main.js", browser_download_url: `${base}/dl/main.js` },
          ],
        },
      ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(releases));
      return;
    }
    if (url === "/dl/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(PLUGIN_MANIFEST));
      return;
    }
    if (url === "/dl/main.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(PLUGIN_MAIN_JS);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchAppAgainstTempVault(githubUrl: string): Promise<{
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
    env: {
      ...process.env,
      GEODE_GITHUB_API_BASE: githubUrl,
      GEODE_GITHUB_RAW_BASE: githubUrl,
    },
  });
  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  return { app, window, userDataDir, vaultPath, consoleErrors };
}

test("installs a plugin from (fake) GitHub, records it, and enables it", async () => {
  const github = await startFakeGithub();
  const { app, window, userDataDir, vaultPath, consoleErrors } = await launchAppAgainstTempVault(
    github.url
  );

  try {
    // Wait for the app to finish booting the (empty) vault.
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    // Open the install modal via its registered command (exercises the command
    // wiring), then drive the modal UI.
    await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("community-add"));
    const modal = window.locator(".mod-community-install");
    await expect(modal).toBeVisible();

    await modal.locator(".community-repo-input").fill("geode-tests/sample-plugin");
    await modal.locator(".community-enable-checkbox").check();
    await modal.locator(".community-install-btn").click();

    // Modal closes on success.
    await expect(modal).toBeHidden();

    // Files landed in the vault's .geode/plugins/<id>/ dir.
    const pluginDir = path.join(vaultPath, ".geode", "plugins", "e2e-installed");
    await expect
      .poll(() => fs.existsSync(path.join(pluginDir, "manifest.json")), { timeout: 5000 })
      .toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "main.js"))).toBe(true);

    // community.json recorded the install.
    const communityCfg = JSON.parse(
      fs.readFileSync(path.join(vaultPath, ".geode", "community.json"), "utf8")
    );
    expect(communityCfg.items).toHaveLength(1);
    expect(communityCfg.items[0]).toMatchObject({
      repo: "geode-tests/sample-plugin",
      type: "plugin",
      id: "e2e-installed",
      installedVersion: "1.0.0",
      autoUpdate: false,
    });

    // The plugin is enabled (opt-in checkbox was checked) and running.
    const isEnabled = await window.evaluate(() =>
      (window as unknown as { app: any }).app.pluginManager.isEnabled("e2e-installed")
    );
    expect(isEnabled).toBe(true);

    // No stray console errors (the plugin's own onload log is type "log").
    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await github.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
