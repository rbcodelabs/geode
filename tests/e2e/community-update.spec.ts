import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Fake GitHub whose served plugin version is mutable, so a test can install
 * v1.0.0, bump the server to 1.1.0, and prove "Check for updates" re-downloads
 * and hot-reloads the plugin.
 */
function makePlugin(version: string) {
  return {
    manifest: {
      id: "e2e-updatable",
      name: "E2E Updatable Plugin",
      version,
      minAppVersion: "0.1.0",
      description: "Updatable plugin for e2e.",
      author: "geode-tests",
    },
    mainJs: `const { Plugin } = require("obsidian");
module.exports = class extends Plugin { onload(){ console.log("updatable ${version} loaded"); } };`,
  };
}

async function startFakeGithub(): Promise<{
  url: string;
  setVersion: (v: string) => void;
  close: () => Promise<void>;
}> {
  let current = makePlugin("1.0.0");
  const server = http.createServer((req, res) => {
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const url = req.url ?? "";
    if (url === "/repos/geode-tests/updatable/releases") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          {
            tag_name: current.manifest.version,
            prerelease: false,
            published_at: "2026-06-01T00:00:00Z",
            assets: [
              { name: "manifest.json", browser_download_url: `${base}/dl/manifest.json` },
              { name: "main.js", browser_download_url: `${base}/dl/main.js` },
            ],
          },
        ])
      );
    } else if (url === "/dl/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(current.manifest));
    } else if (url === "/dl/main.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(current.mainJs);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    setVersion: (v) => {
      current = makePlugin(v);
    },
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

test("checks for updates and hot-reloads a plugin to a newer version", async () => {
  const github = await startFakeGithub();
  const { app, window, userDataDir, vaultPath, consoleErrors } = await launchApp(github.url);
  const manifestPath = path.join(vaultPath, ".geode", "plugins", "e2e-updatable", "manifest.json");
  const communityPath = path.join(vaultPath, ".geode", "community.json");

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    // Install v1.0.0 and enable it.
    await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("community-add"));
    const modal = window.locator(".mod-community-install");
    await expect(modal).toBeVisible();
    await modal.locator(".community-repo-input").fill("geode-tests/updatable");
    await modal.locator(".community-enable-checkbox").check();
    await modal.locator(".community-install-btn").click();
    await expect(modal).toBeHidden();

    await expect.poll(() => fs.existsSync(manifestPath), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version).toBe("1.0.0");
    expect(
      await window.evaluate(() =>
        (window as unknown as { app: any }).app.pluginManager.isEnabled("e2e-updatable")
      )
    ).toBe(true);

    // Publish 1.1.0 upstream, then run the update check.
    github.setVersion("1.1.0");
    await window.evaluate(() =>
      (window as unknown as { app: any }).app.commands.execute("community-check-updates")
    );

    // On-disk manifest + community.json advanced to 1.1.0.
    await expect
      .poll(() => JSON.parse(fs.readFileSync(manifestPath, "utf8")).version, { timeout: 5000 })
      .toBe("1.1.0");
    const cfg = JSON.parse(fs.readFileSync(communityPath, "utf8"));
    expect(cfg.items[0].installedVersion).toBe("1.1.0");
    expect(typeof cfg.items[0].lastChecked).toBe("number");

    // Still enabled after the hot reload.
    expect(
      await window.evaluate(() =>
        (window as unknown as { app: any }).app.pluginManager.isEnabled("e2e-updatable")
      )
    ).toBe(true);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await github.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
