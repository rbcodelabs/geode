import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "vault-policy-plugin",
  name: "Vault Policy Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises the narrowing-only vault policy file.",
  author: "geode-tests",
};
const MAIN_JS = `
  const { Plugin } = require('geode');
  module.exports.default = class VaultPolicyPlugin extends Plugin {
    onload() { this.addCommand({ id: 'noop', name: 'Noop', callback: () => {} }); }
  };
`;

interface Ctx {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  vaultPath: string;
  consoleErrors: string[];
}

/**
 * Seeds a temp vault with `vault-policy-plugin` enabled, optionally writes
 * `<vault>/.geode/policy.json` and a machine policy file (`GEODE_POLICY_PATH`),
 * then launches the app on it. Nothing here touches a real OS policy path.
 */
async function launch(opts: { vaultPolicy?: unknown; machinePolicy?: unknown }): Promise<Ctx> {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vpolicy-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vpolicy-e2e-"));
  const pluginDir = path.join(vaultPath, ".geode", "plugins", MANIFEST.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify([MANIFEST.id]));
  if (opts.vaultPolicy !== undefined) {
    fs.writeFileSync(path.join(vaultPath, ".geode", "policy.json"), JSON.stringify(opts.vaultPolicy, null, 2));
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));

  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vpolicy-machine-"));
  const machinePath = path.join(policyDir, "managed-policy.json");
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Always point at a path we control so a real /etc or /Library file never leaks in.
  env.GEODE_POLICY_PATH = machinePath;
  if (opts.machinePolicy !== undefined) fs.writeFileSync(machinePath, JSON.stringify(opts.machinePolicy, null, 2));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot, env });
  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands));
  return { app, window, userDataDir, vaultPath, consoleErrors };
}

async function cleanup(ctx: Ctx) {
  await ctx.app.close();
  fs.rmSync(ctx.userDataDir, { recursive: true, force: true });
  fs.rmSync(ctx.vaultPath, { recursive: true, force: true });
}

const pluginState = (page: Page) =>
  page.evaluate(() => {
    const app = (window as unknown as { app: any }).app;
    return {
      enabled: app.pluginManager.isEnabled("vault-policy-plugin") as boolean,
      ran: app.commands.execute("vault-policy-plugin:noop") as boolean,
    };
  });

test("vault blocklist blocks a plugin and shows a one-time vault notice", async () => {
  const ctx = await launch({
    vaultPolicy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["vault-policy-plugin"] }, note: "Team vault rules" },
  });
  try {
    await expect(ctx.window.locator(".notice", { hasText: "This vault restricts: plugins." })).toBeVisible();
    await expect(ctx.window.locator(".notice", { hasText: "Team vault rules" })).toBeVisible();
    await expect(ctx.window.locator(".notice", { hasText: "disabled by your organization's policy" })).toBeVisible();
    expect(await pluginState(ctx.window)).toEqual({ enabled: false, ran: false });

    const result = await ctx.window.evaluate(() => (window as any).geode.getEffectivePolicy());
    expect(result.machine).toBeNull();
    expect(result.vault.plugins).toEqual({ mode: "blocklist", ids: ["vault-policy-plugin"] });
    expect(result.provenance.plugins).toEqual(["vault"]);
  } finally {
    await cleanup(ctx);
  }
});

test("machine vaultPolicy: ignore makes the app ignore the vault policy file", async () => {
  const ctx = await launch({
    machinePolicy: { policyVersion: 1, vaultPolicy: "ignore" },
    vaultPolicy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["vault-policy-plugin"] } },
  });
  try {
    expect(await pluginState(ctx.window)).toEqual({ enabled: true, ran: true });
    await expect(ctx.window.locator(".notice", { hasText: "This vault restricts" })).toHaveCount(0);
    const result = await ctx.window.evaluate(() => (window as any).geode.getEffectivePolicy());
    expect(result.vault).toBeNull();
    expect(result.effective.vaultPolicy).toBe("ignore");
  } finally {
    await cleanup(ctx);
  }
});

test("a vault policy cannot widen a machine blocklist", async () => {
  const ctx = await launch({
    machinePolicy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["vault-policy-plugin"] } },
    vaultPolicy: { policyVersion: 1, plugins: { mode: "allowlist", ids: ["vault-policy-plugin"] } },
  });
  try {
    expect(await pluginState(ctx.window)).toEqual({ enabled: false, ran: false });
  } finally {
    await cleanup(ctx);
  }
});

test("no policy files (baseline): the plugin loads, no policy notices, no console errors", async () => {
  const ctx = await launch({});
  try {
    expect(await pluginState(ctx.window)).toEqual({ enabled: true, ran: true });
    await expect(ctx.window.locator(".notice", { hasText: /This vault restricts|organization's policy/ })).toHaveCount(0);
    const result = await ctx.window.evaluate(() => (window as any).geode.getEffectivePolicy());
    expect(result.machine).toBeNull();
    expect(result.vault).toBeNull();
    expect(result.provenance).toEqual({});
    expect(ctx.consoleErrors, `Console errors: ${ctx.consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});

test("main-process write guards refuse .geode/policy.json through every renderer write path", async () => {
  const policy = { policyVersion: 1, sync: { enabled: false } };
  const ctx = await launch({ vaultPolicy: policy });
  try {
    const outcomes = await ctx.window.evaluate(async () => {
      const g = (window as any).geode;
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return "ok";
        } catch (e) {
          return String((e as Error).message);
        }
      };
      return {
        write: await attempt(() => g.write(".geode/policy.json", "{}")),
        writeCase: await attempt(() => g.write(".GEODE/Policy.JSON", "{}")),
        writeDots: await attempt(() => g.write("notes/../.geode/policy.json.", "{}")),
        writeBinary: await attempt(() => g.writeBinary(".geode/policy.json", new ArrayBuffer(2))),
        mkdir: await attempt(() => g.mkdir(".geode/policy.json")),
        rename: await attempt(() => g.rename(".geode/policy.json", "moved.json")),
        renameTo: await attempt(() => g.write("tmp.json", "{}").then(() => g.rename("tmp.json", ".geode/policy.json"))),
        trash: await attempt(() => g.trash(".geode/policy.json")),
        rmdir: await attempt(() => g.rmdir(".geode", true)),
        config: await attempt(() => g.writeConfig("policy", {})),
        configTraversal: await attempt(() => g.writeConfig("../.geode/policy", {})),
        control: await attempt(() => g.write("note.md", "hello")),
      };
    });
    for (const [name, outcome] of Object.entries(outcomes)) {
      if (name === "control") expect(outcome).toBe("ok");
      else expect(outcome, name).toMatch(/host-owned policy file/);
    }
    expect(JSON.parse(fs.readFileSync(path.join(ctx.vaultPath, ".geode", "policy.json"), "utf8"))).toEqual(policy);
  } finally {
    await cleanup(ctx);
  }
});
