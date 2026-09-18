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

async function launchApp(
  githubUrl: string,
  seedVault?: (vaultPath: string) => void,
): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  vaultPath: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-"));
  // Seed before launch so the plugin is on disk for the initial discovery pass.
  seedVault?.(vaultPath);
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

/** Open Settings and click into the community vertical-tab, the way a user does. */
async function openCommunitySettings(window: Page): Promise<void> {
  await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("open-settings"));
  await window
    .locator(".vertical-tab-nav-item", { hasText: "Community plugins & themes" })
    .click();
}

function isEnabled(window: Page, id: string): Promise<boolean> {
  return window.evaluate(
    (pluginId) => (window as unknown as { app: any }).app.pluginManager.isEnabled(pluginId),
    id,
  );
}

/** Contents of `.geode/plugins.json` — the persisted enabled set. */
function enabledIdsOnDisk(vaultPath: string): string[] {
  const file = path.join(vaultPath, ".geode", "plugins.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as string[];
}

test("enables and disables an already-installed plugin from the installed list", async () => {
  const github = await startFakeGithub();
  const { app, window, userDataDir, vaultPath, consoleErrors } = await launchApp(github.url);
  const pluginDir = path.join(vaultPath, ".geode", "plugins", "e2e-managed");

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    // Install WITHOUT ticking "enable after installing" — this is the state the
    // defect stranded users in: files on disk, id absent from plugins.json.
    await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("community-add"));
    const modal = window.locator(".mod-community-install");
    await expect(modal).toBeVisible();
    await modal.locator(".community-repo-input").fill("geode-tests/managed");
    await expect(modal.locator(".community-enable-checkbox")).not.toBeChecked();
    await modal.locator(".community-install-btn").click();
    await expect(modal).toBeHidden();
    await expect.poll(() => fs.existsSync(pluginDir), { timeout: 5000 }).toBe(true);
    expect(await isEnabled(window, "e2e-managed")).toBe(false);

    await openCommunitySettings(window);
    const rowLoc = window.locator('.community-item[data-repo="geode-tests/managed"]');
    await expect(rowLoc).toBeVisible();

    // The control that did not exist before: enable from the installed list.
    const toggle = rowLoc.locator(".community-item-enable");
    await expect(toggle).toHaveText("Enable");
    await toggle.click();

    await expect.poll(() => isEnabled(window, "e2e-managed"), { timeout: 5000 }).toBe(true);
    await expect
      .poll(() => enabledIdsOnDisk(vaultPath), { timeout: 5000 })
      .toContain("e2e-managed");
    // The row re-rendered into the disabled-able state.
    await expect(rowLoc.locator(".community-item-enable")).toHaveText("Disable");

    // …and back off again, persisted.
    await rowLoc.locator(".community-item-enable").click();
    await expect.poll(() => isEnabled(window, "e2e-managed"), { timeout: 5000 }).toBe(false);
    await expect
      .poll(() => enabledIdsOnDisk(vaultPath), { timeout: 5000 })
      .not.toContain("e2e-managed");
    await expect(rowLoc.locator(".community-item-enable")).toHaveText("Enable");

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await github.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test("lists and enables an installed plugin that community.json never recorded", async () => {
  const github = await startFakeGithub();
  // Stand in for "Import from Obsidian" / default-vault bootstrap: files land in
  // .geode/plugins/ with no community.json provenance at all.
  const { app, window, userDataDir, vaultPath, consoleErrors } = await launchApp(
    github.url,
    (vault) => {
      const dir = path.join(vault, ".geode", "plugins", "e2e-untracked");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ ...MANIFEST, id: "e2e-untracked", name: "E2E Untracked Plugin" })
      );
      fs.writeFileSync(path.join(dir, "main.js"), MAIN_JS);
    },
  );

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );
    expect(fs.existsSync(path.join(vaultPath, ".geode", "community.json"))).toBe(false);
    expect(await isEnabled(window, "e2e-untracked")).toBe(false);

    await openCommunitySettings(window);

    // Before the fix this row did not exist: the list was built from
    // community.json alone, so the plugin was unreachable from the UI.
    const rowLoc = window.locator('.installed-plugin-item[data-plugin-id="e2e-untracked"]');
    await expect(rowLoc).toBeVisible();
    await expect(rowLoc).toContainText("E2E Untracked Plugin");
    await expect(rowLoc).toContainText("not tracked for updates");

    await rowLoc.locator(".community-item-enable").click();
    await expect.poll(() => isEnabled(window, "e2e-untracked"), { timeout: 5000 }).toBe(true);
    await expect
      .poll(() => enabledIdsOnDisk(vaultPath), { timeout: 5000 })
      .toContain("e2e-untracked");

    await expect(rowLoc.locator(".community-item-enable")).toHaveText("Disable");
    await rowLoc.locator(".community-item-enable").click();
    await expect.poll(() => isEnabled(window, "e2e-untracked"), { timeout: 5000 }).toBe(false);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await github.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

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
