import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "policy-test-plugin",
  name: "Policy Test Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "A plugin used to exercise enterprise-managed plugin policy.",
  author: "geode-tests",
};

/** Real CommonJS-style main.js, mirroring plugin-smoke.spec.ts's sample plugin. */
const MAIN_JS = `
  const { Plugin } = require('geode');

  module.exports.default = class PolicyTestPlugin extends Plugin {
    onload() {
      this.addCommand({
        id: 'noop',
        name: 'Noop',
        callback: () => {},
      });
    }
  };
`;

/**
 * Seeds a fresh temp vault with `policy-test-plugin` already enabled (per
 * `.geode/plugins.json`, mirroring how PluginManager persists enabled
 * state), and a fresh temp userData dir pointing at it as the last-opened
 * vault. `GEODE_POLICY_PATH`, if given, is passed to the main process so it
 * reads the managed policy from a temp file instead of a real OS path — no
 * test here ever touches `/etc` or `/Library/Application Support`.
 */
async function launchAppWithPolicy(policyPath: string | undefined): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  vaultPath: string;
  consoleErrors: string[];
}> {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-e2e-"));

  const pluginDir = path.join(vaultPath, ".geode", "plugins", "policy-test-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(
    path.join(vaultPath, ".geode", "plugins.json"),
    JSON.stringify(["policy-test-plugin"])
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath })
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (policyPath) env.GEODE_POLICY_PATH = policyPath;
  else delete env.GEODE_POLICY_PATH;

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env,
  });

  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));

  return { app, window, userDataDir, vaultPath, consoleErrors };
}

function writePolicyFile(policyPath: string, policy: unknown) {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
}

async function cleanup(ctx: {
  app: ElectronApplication;
  userDataDir: string;
  vaultPath: string;
}) {
  await ctx.app.close();
  fs.rmSync(ctx.userDataDir, { recursive: true, force: true });
  fs.rmSync(ctx.vaultPath, { recursive: true, force: true });
}

test("blocklist policy: a blocked previously-enabled plugin fails to enable, shows a Notice, and its effects are absent", async () => {
  const policyPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-file-"))
    , "managed-policy.json"
  );
  writePolicyFile(policyPath, {
    policyVersion: 1,
    plugins: { mode: "blocklist", ids: ["policy-test-plugin"] },
  });

  const ctx = await launchAppWithPolicy(policyPath);
  try {
    await expect(ctx.window.locator(".workspace")).toBeVisible();
    await ctx.window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    // Blocked on startup ⇒ a visible Notice, not silent console.error.
    await expect(
      ctx.window.locator(".notice", { hasText: "disabled by your organization's policy" })
    ).toBeVisible();

    // The plugin never ran onload(), so its command never registered.
    const isEnabled = await ctx.window.evaluate(() =>
      (window as unknown as { app: any }).app.pluginManager.isEnabled("policy-test-plugin")
    );
    expect(isEnabled).toBe(false);
    const ran = await ctx.window.evaluate(() =>
      (window as unknown as { app: any }).app.commands.execute("policy-test-plugin:noop")
    );
    expect(ran).toBe(false);
  } finally {
    await cleanup(ctx);
  }
});

test("allowlist policy: a plugin not on the allowlist fails to enable, shows a Notice, and its effects are absent", async () => {
  const policyPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-file-"))
    , "managed-policy.json"
  );
  writePolicyFile(policyPath, {
    policyVersion: 1,
    plugins: { mode: "allowlist", ids: ["some-other-plugin"] },
  });

  const ctx = await launchAppWithPolicy(policyPath);
  try {
    await expect(ctx.window.locator(".workspace")).toBeVisible();
    await ctx.window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    await expect(
      ctx.window.locator(".notice", { hasText: "disabled by your organization's policy" })
    ).toBeVisible();

    const isEnabled = await ctx.window.evaluate(() =>
      (window as unknown as { app: any }).app.pluginManager.isEnabled("policy-test-plugin")
    );
    expect(isEnabled).toBe(false);
    const ran = await ctx.window.evaluate(() =>
      (window as unknown as { app: any }).app.commands.execute("policy-test-plugin:noop")
    );
    expect(ran).toBe(false);
  } finally {
    await cleanup(ctx);
  }
});

test("no policy file (baseline): the plugin loads normally — fail-open must not regress the default experience", async () => {
  // Point at a path that deliberately doesn't exist, exercising the same
  // fail-open code path a non-enterprise user hits (no managed-policy.json
  // anywhere on their machine).
  const missingPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "geode-policy-file-")),
    "does-not-exist.json"
  );

  const ctx = await launchAppWithPolicy(missingPath);
  try {
    await expect(ctx.window.locator(".workspace")).toBeVisible();
    await ctx.window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    const isEnabled = await ctx.window.evaluate(() =>
      (window as unknown as { app: any }).app.pluginManager.isEnabled("policy-test-plugin")
    );
    expect(isEnabled).toBe(true);
    const ran = await ctx.window.evaluate(() =>
      (window as unknown as { app: any }).app.commands.execute("policy-test-plugin:noop")
    );
    expect(ran).toBe(true);

    // No "blocked by administrator policy" style Notice should ever appear
    // for the default (non-enterprise) experience.
    await expect(ctx.window.locator(".notice", { hasText: "organization's policy" })).toHaveCount(0);

    expect(ctx.consoleErrors, `Console errors: ${ctx.consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});
