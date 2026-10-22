import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * pluginInstall managed policy (docs/adr/0052). Drives the real main-process
 * IPC handlers through `window.geode`, against a fake GitHub (the ADR 0001
 * GEODE_GITHUB_API_BASE / _RAW_BASE seam) that counts requests, so "refused
 * before any network fetch" is observed rather than assumed.
 */
const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "e2e-installed",
  name: "E2E Installed Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Installed from a fake GitHub during e2e.",
  author: "geode-tests",
};
const MAIN_JS = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin { onload() {} };
`;

interface FakeGithub {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

async function startFakeGithub(): Promise<FakeGithub> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    if (url === "/repos/geode-tests/sample-plugin/releases") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{
        tag_name: "1.0.0",
        prerelease: false,
        published_at: "2026-06-01T00:00:00Z",
        assets: [
          { name: "manifest.json", browser_download_url: `${base}/dl/manifest.json` },
          { name: "main.js", browser_download_url: `${base}/dl/main.js` },
        ],
      }]));
      return;
    }
    if (url === "/dl/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MANIFEST));
      return;
    }
    if (url === "/dl/main.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(MAIN_JS);
      return;
    }
    if (url === "/supported-plugins/v1.json") {
      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, plugins: [{
        id: MANIFEST.id,
        name: MANIFEST.name,
        description: MANIFEST.description,
        github: { owner: "geode-tests", repo: "sample-plugin" },
        manifest: { version: MANIFEST.version, releaseTag: MANIFEST.version, minAppVersion: MANIFEST.minAppVersion },
        platforms: ["desktop"],
        minimumGeodeVersion: "0.1.0",
        certifiedWithGeodeVersion: "0.13.4",
        artifactHashes: { "manifest.json": hash(JSON.stringify(MANIFEST)), "main.js": hash(MAIN_JS) },
        evidenceUrl: `https://github.com/rbcodelabs/geode/blob/${"c".repeat(40)}/tests/e2e/plugin-install-policy.spec.ts`,
        status: "active",
      }] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Launched {
  app: ElectronApplication;
  window: Page;
  vaultPath: string;
  cleanup: () => void;
}

/** `policy` is the machine policy document, or undefined for the no-policy baseline. */
async function launch(github: FakeGithub, policy: unknown, vaultPolicy?: unknown): Promise<Launched> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-"));
  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-"));
  const policyPath = path.join(policyDir, "managed-policy.json");
  if (policy !== undefined) fs.writeFileSync(policyPath, JSON.stringify({ policyVersion: 1, ...(policy as object) }));
  if (vaultPolicy !== undefined) {
    fs.mkdirSync(path.join(vaultPath, ".geode"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".geode", "policy.json"), JSON.stringify({ policyVersion: 1, ...(vaultPolicy as object) }));
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      GEODE_POLICY_PATH: policyPath,
      GEODE_GITHUB_API_BASE: github.url,
      GEODE_GITHUB_RAW_BASE: github.url,
      GEODE_TEST_SUPPORTED_PLUGIN_CATALOG_URL: `${github.url}/supported-plugins/v1.json`,
    },
  });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => Boolean((window as unknown as { app?: { setting?: unknown } }).app?.setting));
  return {
    app,
    window,
    vaultPath,
    cleanup: () => {
      for (const d of [userDataDir, vaultPath, policyDir]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

const pluginsDir = (vault: string) => path.join(vault, ".geode", "plugins");
const installedPluginFiles = (vault: string) => (fs.existsSync(pluginsDir(vault)) ? fs.readdirSync(pluginsDir(vault)) : []);

type GeodeApi = {
  installCommunity(spec: string): Promise<unknown>;
  resolveCommunity(spec: string): Promise<unknown>;
  getSupportedPluginCatalog(): Promise<{ status: string }>;
  installSupportedPlugin(id: string, release: "tested" | "latest"): Promise<unknown>;
  importFromObsidian(): Promise<unknown>;
  replacePluginFiles(id: string, expected: string, files: { manifest: string; main: string; styles: string | null }): Promise<void>;
};
const call = <T>(window: Page, fn: (g: GeodeApi) => Promise<T>) =>
  window.evaluate(
    async ({ src }) => {
      const g = (window as unknown as { geode: GeodeApi }).geode;
      try {
        // eslint-disable-next-line no-new-func
        const result = await new Function("g", `return (${src})(g)`)(g);
        return { ok: true as const, result };
      } catch (err) {
        return { ok: false as const, message: String((err as Error).message ?? err) };
      }
    },
    { src: fn.toString() },
  );

const BLOCKED = /blocked by administrator policy: pluginInstall/;

test.describe("pluginInstall policy", () => {
  test("baseline: no policy file leaves installs unchanged", async () => {
    const github = await startFakeGithub();
    const { app, window, vaultPath, cleanup } = await launch(github, undefined);
    try {
      const out = await call(window, (g) => g.installCommunity("geode-tests/sample-plugin"));
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(installedPluginFiles(vaultPath)).toEqual(["e2e-installed"]);
      expect(fs.existsSync(path.join(pluginsDir(vaultPath), "e2e-installed", "main.js"))).toBe(true);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }
  });

  test("disabled: every entry point is refused in main, nothing is fetched or written", async () => {
    const github = await startFakeGithub();
    const { app, window, vaultPath, cleanup } = await launch(github, { pluginInstall: { mode: "disabled" } });
    try {
      const results = {
        install: await call(window, (g) => g.installCommunity("geode-tests/sample-plugin")),
        resolve: await call(window, (g) => g.resolveCommunity("geode-tests/sample-plugin")),
        catalog: await call(window, (g) => g.getSupportedPluginCatalog()),
        supported: await call(window, (g) => g.installSupportedPlugin("e2e-installed", "tested")),
        obsidian: await call(window, (g) => g.importFromObsidian()),
        replace: await call(window, (g) => g.replacePluginFiles("e2e-installed", "{}", { manifest: "{}", main: "", styles: null })),
      };
      for (const [name, out] of Object.entries(results)) {
        expect(out.ok, `${name} should be refused`).toBe(false);
        expect(out.ok ? "" : out.message, name).toMatch(BLOCKED);
      }
      expect(installedPluginFiles(vaultPath)).toEqual([]);
      expect(fs.existsSync(path.join(vaultPath, ".geode", "community.json"))).toBe(false);
      // Refused before any network fetch: not even the catalog or a release listing was requested.
      expect(github.requests).toEqual([]);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }
  });

  test("disabled: Settings shows the controls disabled with a managed-by-administrator note", async () => {
    const github = await startFakeGithub();
    const { app, window, cleanup } = await launch(github, { pluginInstall: { mode: "disabled" } });
    try {
      await window.evaluate(() => (window as unknown as { app: any }).app.setting.openTabById("community-plugins"));
      await expect(window.locator(".managed-policy-note-host")).toContainText("Managed by your administrator");
      await expect(window.getByRole("button", { name: "Add…" })).toBeDisabled();
      await expect(window.getByRole("button", { name: /Import from \.obsidian/ })).toBeDisabled();
      await expect(window.locator(".supported-plugin-catalog .managed-policy-note")).toContainText("Managed by your administrator");
      expect(github.requests).toEqual([]);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }
  });

  test("catalog-only: catalog install works, free-form GitHub install and import are refused", async () => {
    const github = await startFakeGithub();
    const { app, window, vaultPath, cleanup } = await launch(github, { pluginInstall: { mode: "catalog-only" } });
    try {
      const refused = await call(window, (g) => g.installCommunity("geode-tests/sample-plugin"));
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.message).toMatch(BLOCKED);
      const resolveRefused = await call(window, (g) => g.resolveCommunity("geode-tests/sample-plugin"));
      expect(resolveRefused.ok).toBe(false);
      const importRefused = await call(window, (g) => g.importFromObsidian());
      expect(importRefused.ok).toBe(false);
      expect(installedPluginFiles(vaultPath)).toEqual([]);

      const catalog = await call(window, (g) => g.getSupportedPluginCatalog());
      expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
      const installed = await call(window, (g) => g.installSupportedPlugin("e2e-installed", "tested"));
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      expect(fs.existsSync(path.join(pluginsDir(vaultPath), "e2e-installed", "main.js"))).toBe(true);

      await window.evaluate(() => (window as unknown as { app: any }).app.setting.openTabById("community-plugins"));
      await expect(window.getByRole("button", { name: "Add…" })).toBeDisabled();
      await expect(window.locator(".supported-plugin-catalog .supported-plugin-item")).toHaveCount(1);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }
  });

  test("allowed + sources: a non-matching repo is refused before any fetch, a matching one installs", async () => {
    const github = await startFakeGithub();
    const { app, window, vaultPath, cleanup } = await launch(github, {
      pluginInstall: { mode: "allowed", sources: ["github.com/approved-org/*"] },
    });
    try {
      const refused = await call(window, (g) => g.installCommunity("https://github.com/geode-tests/sample-plugin"));
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.message).toMatch(/pluginInstall.sources/);
      expect((await call(window, (g) => g.resolveCommunity("geode-tests/sample-plugin"))).ok).toBe(false);
      expect(github.requests).toEqual([]);
      expect(installedPluginFiles(vaultPath)).toEqual([]);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }

    const github2 = await startFakeGithub();
    const second = await launch(github2, { pluginInstall: { mode: "allowed", sources: ["github.com/geode-tests/*"] } });
    try {
      const ok = await call(second.window, (g) => g.installCommunity("geode-tests/sample-plugin"));
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      expect(installedPluginFiles(second.vaultPath)).toEqual(["e2e-installed"]);
    } finally {
      await second.app.close();
      await github2.close();
      second.cleanup();
    }
  });

  test("the vault policy can narrow but not widen", async () => {
    const github = await startFakeGithub();
    const { app, window, vaultPath, cleanup } = await launch(
      github,
      { pluginInstall: { mode: "allowed" } },
      { pluginInstall: { mode: "disabled" } },
    );
    try {
      const out = await call(window, (g) => g.installCommunity("geode-tests/sample-plugin"));
      expect(out.ok).toBe(false);
      expect(out.ok ? "" : out.message).toMatch(BLOCKED);
      expect(installedPluginFiles(vaultPath)).toEqual([]);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }
  });

  test("composes with `plugins`: install allowed, execution still gated", async () => {
    const github = await startFakeGithub();
    const { app, window, vaultPath, cleanup } = await launch(github, {
      plugins: { mode: "allowlist", ids: [] },
      pluginInstall: { mode: "allowed" },
    });
    try {
      const installed = await call(window, (g) => g.installCommunity("geode-tests/sample-plugin"));
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      expect(installedPluginFiles(vaultPath)).toEqual(["e2e-installed"]);
      await window.evaluate(() => (window as unknown as { app: any }).app.pluginManager.rescan());
      const enable = await window.evaluate(async () => {
        try {
          await (window as unknown as { app: any }).app.pluginManager.enable("e2e-installed");
          return "enabled";
        } catch (err) {
          return String((err as Error).message);
        }
      });
      expect(enable).toMatch(/blocked by administrator policy/);
      // Nothing was deleted by the policy: the installed files remain.
      expect(fs.existsSync(path.join(pluginsDir(vaultPath), "e2e-installed", "main.js"))).toBe(true);
    } finally {
      await app.close();
      await github.close();
      cleanup();
    }
  });
});
