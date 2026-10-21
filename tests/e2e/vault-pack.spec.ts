import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildPackZip } from "../unit/helpers/vault-pack-fixtures";

const repoRoot = path.resolve(__dirname, "..", "..");
const PLUGIN_ID = "acme-pack-plugin";

/** Real CommonJS-style main.js, mirroring plugin-policy.spec.ts's sample plugin. */
const MAIN_JS = `
  const { Plugin } = require('geode');
  module.exports.default = class AcmePackPlugin extends Plugin {
    onload() { this.addCommand({ id: 'noop', name: 'Noop', callback: () => {} }); }
  };
`;

/** ADR 0050 fixture: two notes, a bundled plugin (enabled), and runtime junk that must not be extracted. */
function writeFixturePack(dir: string): string {
  const packPath = path.join(dir, "acme.vault");
  fs.writeFileSync(packPath, buildPackZip({
    files: {
      "Start here.md": "# Welcome to Acme\n",
      "Policies/Handbook.md": "# Handbook\n",
      ".geode/app.json": JSON.stringify({ theme: "light" }),
      ".geode/workspace.json": "{\"junk\":true}",
    },
    bundled: [{ id: PLUGIN_ID, mainJs: MAIN_JS }],
  }));
  return packPath;
}

interface Ctx {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  documentsDir: string;
  fixtureDir: string;
  packPath: string;
}

async function launch(extra: { args?: string[]; env?: NodeJS.ProcessEnv; recents?: string[] } = {}): Promise<Ctx> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-ud-"));
  const documentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-docs-"));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-fx-"));
  const packPath = writeFixturePack(fixtureDir);
  if (extra.recents) {
    fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: extra.recents, lastVault: extra.recents[0] }));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEODE_DOCUMENTS_DIR: documentsDir,
    GEODE_TEST_VAULT_PACK_PICK: packPath,
    ...extra.env,
  };
  delete env.GEODE_POLICY_PATH;
  Object.assign(env, extra.env);
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`, ...(extra.args ?? []).map((a) => (a === "<pack>" ? packPath : a))],
    cwd: repoRoot,
    colorScheme: "light",
    env,
  });
  const window = await app.firstWindow();
  return { app, window, userDataDir, documentsDir, fixtureDir, packPath };
}

async function cleanup(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  for (const dir of [ctx.userDataDir, ctx.documentsDir, ctx.fixtureDir]) fs.rmSync(dir, { recursive: true, force: true });
}

test("create a vault from a pack: consent screen shows the contents, then notes and the bundled plugin are in place", async () => {
  const ctx = await launch();
  try {
    const { window } = ctx;
    await expect(window.locator(".vault-picker")).toBeVisible();
    await window.getByRole("button", { name: "Create vault from pack…" }).click();

    const dialog = window.locator(".vault-pack-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Acme Onboarding");
    await expect(dialog).toContainText("Version 2.0.0");
    // 2 notes + app.json + plugin manifest.json + main.js; workspace.json is runtime state and is not counted.
    await expect(dialog).toContainText("5 files will be added");
    await expect(dialog).toContainText(`Plugin ${PLUGIN_ID}`);
    await expect(dialog).toContainText("Bundled in this pack");
    await expect(dialog.locator(".vault-pack-plugin-hash")).toContainText("sha256 ");
    await expect(dialog.locator(".vault-pack-warning")).toContainText("full access to your computer");

    // Consent alone writes nothing.
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);

    await dialog.getByRole("button", { name: "Create vault" }).click();

    const vaultPath = path.join(ctx.documentsDir, "Acme Onboarding");
    await expect.poll(() => window.evaluate(() => (window as any).app.vault?.getFileByPath("Start here.md")?.path ?? null)).toBe("Start here.md");
    expect(await window.evaluate(() => (window as any).app.vault.getFileByPath("Policies/Handbook.md")?.path)).toBe("Policies/Handbook.md");
    expect(fs.readFileSync(path.join(vaultPath, "Policies", "Handbook.md"), "utf8")).toBe("# Handbook\n");
    expect(JSON.parse(fs.readFileSync(path.join(vaultPath, ".geode", "plugins.json"), "utf8"))).toEqual([PLUGIN_ID]);

    await expect.poll(() => window.evaluate((id) => (window as any).app.pluginManager?.isEnabled(id) ?? null, PLUGIN_ID)).toBe(true);
    expect(await window.evaluate((id) => (window as any).app.commands.execute(`${id}:noop`), PLUGIN_ID)).toBe(true);
    // No staging directory left next to the vault.
    expect(fs.readdirSync(ctx.documentsDir)).toEqual(["Acme Onboarding"]);
  } finally {
    await cleanup(ctx);
  }
});

test("declining the consent screen writes nothing", async () => {
  const ctx = await launch();
  try {
    const { window } = ctx;
    await window.getByRole("button", { name: "Create vault from pack…" }).click();
    const dialog = window.locator(".vault-pack-modal");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".vault-picker")).toBeVisible();
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);

    // Escape declines too.
    await window.getByRole("button", { name: "Create vault from pack…" }).click();
    await expect(dialog).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});

test("a policy-blocked bundled plugin is installed disabled and is not enabled", async () => {
  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-policy-"));
  const policyPath = path.join(policyDir, "managed-policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ policyVersion: 1, plugins: { mode: "blocklist", ids: [PLUGIN_ID] } }));
  const ctx = await launch({ env: { GEODE_POLICY_PATH: policyPath } });
  try {
    const { window } = ctx;
    await window.getByRole("button", { name: "Create vault from pack…" }).click();
    const dialog = window.locator(".vault-pack-modal");
    await expect(dialog).toContainText("Blocked by your administrator");
    await dialog.getByRole("button", { name: "Create vault" }).click();
    const vaultPath = path.join(ctx.documentsDir, "Acme Onboarding");
    await expect.poll(() => window.evaluate(() => (window as any).app.vault?.getFileByPath("Start here.md")?.path ?? null)).toBe("Start here.md");
    expect(fs.existsSync(path.join(vaultPath, ".geode", "plugins", PLUGIN_ID, "main.js"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(vaultPath, ".geode", "plugins.json"), "utf8"))).toEqual([]);
    await expect.poll(() => window.evaluate(() => Boolean((window as any).app.pluginManager))).toBe(true);
    expect(await window.evaluate((id) => (window as any).app.pluginManager.isEnabled(id), PLUGIN_ID)).toBe(false);
  } finally {
    await cleanup(ctx);
    fs.rmSync(policyDir, { recursive: true, force: true });
  }
});

test("--vault-pack without --yes still shows the consent screen, even when a recent vault exists", async () => {
  const recent = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-recent-"));
  fs.writeFileSync(path.join(recent, "existing.md"), "# existing\n");
  const ctx = await launch({ args: ["--vault-pack", "<pack>"], recents: [recent] });
  try {
    const dialog = ctx.window.locator(".vault-pack-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Acme Onboarding");
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
    fs.rmSync(recent, { recursive: true, force: true });
  }
});

test("--vault-pack with --yes creates and opens the vault without a prompt", async () => {
  const ctx = await launch({ args: ["--vault-pack", "<pack>", "--yes"] });
  try {
    const { window } = ctx;
    await expect.poll(() => window.evaluate(() => (window as any).app.vault?.getFileByPath("Start here.md")?.path ?? null)).toBe("Start here.md");
    await expect(window.locator(".vault-pack-modal")).toHaveCount(0);
    expect(fs.existsSync(path.join(ctx.documentsDir, "Acme Onboarding", "Policies", "Handbook.md"))).toBe(true);
    await expect.poll(() => window.evaluate((id) => (window as any).app.pluginManager?.isEnabled(id) ?? null, PLUGIN_ID)).toBe(true);
  } finally {
    await cleanup(ctx);
  }
});

test("organization pack directory is listed on the hub and opens the same consent flow", async () => {
  const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-org-"));
  writeFixturePack(orgDir);
  const ctx = await launch({ env: { GEODE_PACK_DIR: orgDir } });
  try {
    const { window } = ctx;
    await expect(window.getByText("Organization vaults")).toBeVisible();
    await window.locator(".vault-picker-org-pack", { hasText: "Acme Onboarding 2.0.0" }).click();
    await expect(window.locator(".vault-pack-modal")).toContainText("Acme Onboarding");
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
    fs.rmSync(orgDir, { recursive: true, force: true });
  }
});

test("Save vault as pack exports a vault that imports back", async () => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-pack-export-"));
  const target = path.join(exportDir, "out.vault");
  const ctx = await launch({ env: { GEODE_TEST_VAULT_PACK_SAVE: target } });
  try {
    const { window } = ctx;
    await window.getByRole("button", { name: "Create vault from pack…" }).click();
    await window.locator(".vault-pack-modal").getByRole("button", { name: "Create vault" }).click();
    await expect.poll(() => window.evaluate(() => (window as any).app.vault?.getFileByPath("Start here.md")?.path ?? null)).toBe("Start here.md");

    const result = await window.evaluate(() => (window as any).geode.vaultPack.exportCurrent());
    expect(result).toMatchObject({ path: target, pluginCount: 1 });
    expect(fs.statSync(target).size).toBeGreaterThan(0);
    const summary = await window.evaluate((p) => (window as any).geode.vaultPack.inspectDropped(p), target);
    expect(summary.summary.plugins.map((p: { id: string }) => p.id)).toEqual([PLUGIN_ID]);
  } finally {
    await cleanup(ctx);
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});
