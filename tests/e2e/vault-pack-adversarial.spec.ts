import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildPackZip } from "../unit/helpers/vault-pack-fixtures";
import { writeZip } from "../../src/main/vault-pack-zip";

/**
 * ADR 0050 adversarial QA against the real built app: hostile packs are
 * refused with a readable error and nothing is written under Documents.
 */
const repoRoot = path.resolve(__dirname, "..", "..");

interface Ctx { app: ElectronApplication; window: Page; userDataDir: string; documentsDir: string; fixtureDir: string; packPath: string }

async function launch(zip: Buffer, extra: { args?: string[]; recents?: string[] } = {}): Promise<Ctx> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vp-adv-ud-"));
  const documentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vp-adv-docs-"));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vp-adv-fx-"));
  const packPath = path.join(fixtureDir, "pack.vault");
  fs.writeFileSync(packPath, zip);
  if (extra.recents) fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: extra.recents, lastVault: extra.recents[0] }));
  const env: NodeJS.ProcessEnv = { ...process.env, GEODE_DOCUMENTS_DIR: documentsDir, GEODE_TEST_VAULT_PACK_PICK: packPath };
  delete env.GEODE_POLICY_PATH;
  delete env.GEODE_PACK_DIR;
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`, ...(extra.args ?? []).map((a) => (a === "<pack>" ? packPath : a))],
    cwd: repoRoot,
    colorScheme: "light",
    env,
  });
  return { app, window: await app.firstWindow(), userDataDir, documentsDir, fixtureDir, packPath };
}
async function cleanup(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  for (const dir of [ctx.userDataDir, ctx.documentsDir, ctx.fixtureDir]) fs.rmSync(dir, { recursive: true, force: true });
}

const hostile: Array<[string, () => Buffer, RegExp]> = [
  ["zip-slip entry", () => buildPackZip({ extraEntries: [{ name: "vault/../../escape.md", data: Buffer.from("x") }] }), /Not a valid vault pack/],
  ["symlink entry", () => buildPackZip({ extraEntries: [{ name: "vault/link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }] }), /symbolic link/],
  ["upper-case .GEODE", () => buildPackZip({ extraEntries: [{ name: "vault/.GEODE/app.json", data: Buffer.from("{}") }] }), /.+/],
  ["missing manifest", () => buildPackZip({ omitManifest: true }), /vault-pack\.json/],
  ["manifest that is not JSON", () => writeZip([{ name: "vault-pack.json", data: Buffer.from("{nope") }]), /.+/],
  ["bundled plugin hash mismatch", () => buildPackZip({ bundled: [{ id: "p", recordedSha256: "0".repeat(64) }] }), /sha256|hash|match/i],
  ["not a zip at all", () => Buffer.from("this is not a zip"), /.+/],
  ["zero-byte file", () => Buffer.alloc(0), /.+/],
];

for (const [label, make, message] of hostile) {
  test(`hub refuses a hostile pack (${label}) with a readable error and writes nothing`, async () => {
    const ctx = await launch(make());
    try {
      const { window } = ctx;
      await window.getByRole("button", { name: "Create vault from pack…" }).click();
      await expect(window.locator(".vault-picker-error")).toContainText(message);
      await expect(window.locator(".vault-pack-modal")).toHaveCount(0);
      expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
      // The hub is still usable afterwards.
      await expect(window.getByRole("button", { name: "Create vault from pack…" })).toBeEnabled();
    } finally {
      await cleanup(ctx);
    }
  });
}

test("creating into a name that already exists shows an error in the consent dialog and leaves the folder untouched", async () => {
  const ctx = await launch(buildPackZip({ files: { "Start here.md": "# hi\n" } }));
  try {
    const { window } = ctx;
    const existing = path.join(ctx.documentsDir, "Acme Onboarding");
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "mine.md"), "keep");
    await window.getByRole("button", { name: "Create vault from pack…" }).click();
    const dialog = window.locator(".vault-pack-modal");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create vault" }).click();
    await expect(dialog.locator(".vault-create-error")).toContainText(/already exists/);
    await expect(dialog).toBeVisible();
    expect(fs.readdirSync(existing)).toEqual(["mine.md"]);

    // Editing the name clears the error and the retry succeeds (the token survives a name collision only if retained;
    // otherwise the dialog must say so rather than hang).
    await dialog.locator("#vault-pack-name-input").fill("Acme Two");
    await dialog.getByRole("button", { name: "Create vault" }).click();
    await expect(dialog.locator(".vault-create-error")).toHaveText("", { timeout: 5_000 }); // DEFECT QA-2 if this fails: token was consumed by the failed attempt
    await expect.poll(() => fs.existsSync(path.join(ctx.documentsDir, "Acme Two", "Start here.md")) || "pending", { timeout: 10_000 }).toBe(true);
  } finally {
    await cleanup(ctx);
  }
});

test("a consent token is single use: replaying create from the renderer is refused and writes nothing more", async () => {
  const ctx = await launch(buildPackZip());
  try {
    const { window } = ctx;
    const result = await window.evaluate(async (packPath) => {
      const api = (window as any).geode.vaultPack;
      const out: Record<string, string> = {};
      const parent = (await (window as any).geode.createVault?.getDefaultLocation?.())?.path;
      out.parent = String(parent);
      // A path main never handed to this window is refused.
      out.ungranted = await api.inspect(packPath).then(() => "ok", (e: Error) => e.message);
      // A forged token is refused.
      out.forged = await api.create({ token: "f".repeat(32), parent: String(parent), name: "Forged" }).then(() => "ok", (e: Error) => e.message);
      // Relative / UNC / URL drops are refused.
      out.relative = await api.inspectDropped("relative/a.vault").then(() => "ok", (e: Error) => e.message);
      out.unc = await api.inspectDropped("\\\\evil\\share\\a.vault").then(() => "ok", (e: Error) => e.message);
      out.url = await api.inspectDropped("file:///tmp/a.vault").then(() => "ok", (e: Error) => e.message);
      out.notVault = await api.inspectDropped("/etc/hosts").then(() => "ok", (e: Error) => e.message);
      return out;
    }, ctx.packPath);
    expect(result.ungranted).toMatch(/not chosen in this window/);
    expect(result.forged).toMatch(/no longer waiting/);
    expect(result.relative).toMatch(/Choose a vault pack/);
    expect(result.unc).toMatch(/Choose a vault pack/);
    expect(result.url).toMatch(/Choose a vault pack/);
    expect(result.notVault).toMatch(/not a \.vault/);
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});

test("--vault-pack --yes with a hostile pack creates nothing and the app still starts on the hub", async () => {
  const ctx = await launch(buildPackZip({ extraEntries: [{ name: "vault/../../x.md", data: Buffer.from("x") }] }), { args: ["--vault-pack", "<pack>", "--yes"] });
  try {
    await expect(ctx.window.locator(".vault-picker")).toBeVisible();
    await expect(ctx.window.locator(".vault-pack-modal")).toHaveCount(0);
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});

test("--vault-pack with a hostile pack and no --yes tells the user why instead of silently ignoring it", async () => {
  const ctx = await launch(buildPackZip({ extraEntries: [{ name: "vault/link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }] }), { args: ["--vault-pack", "<pack>"] });
  try {
    await expect(ctx.window.locator(".vault-picker")).toBeVisible();
    await expect(ctx.window.locator(".vault-picker-error, .vault-pack-modal")).toHaveCount(1, { timeout: 5_000 });
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});

test("--vault-pack pointing at a missing file with --yes does not crash and creates nothing", async () => {
  const ctx = await launch(buildPackZip(), { args: ["--vault-pack", "/nonexistent/nope.vault", "--yes"] });
  try {
    await expect(ctx.window.locator(".vault-picker")).toBeVisible();
    expect(fs.readdirSync(ctx.documentsDir)).toEqual([]);
  } finally {
    await cleanup(ctx);
  }
});

test("--vault-pack --yes twice into the same Documents picks a fresh folder name instead of overwriting", async () => {
  const ctx = await launch(buildPackZip());
  try {
    await ctx.app.close();
    const first = await electron.launch({
      args: [repoRoot, `--user-data-dir=${ctx.userDataDir}`, "--vault-pack", ctx.packPath, "--yes"],
      cwd: repoRoot,
      env: { ...process.env, GEODE_DOCUMENTS_DIR: ctx.documentsDir },
    });
    await expect.poll(() => fs.existsSync(path.join(ctx.documentsDir, "Acme Onboarding", "Welcome.md")), { timeout: 15_000 }).toBe(true);
    await first.close();
    fs.rmSync(path.join(ctx.userDataDir, "geode.json"), { force: true });
    const second = await electron.launch({
      args: [repoRoot, `--user-data-dir=${ctx.userDataDir}`, "--vault-pack", ctx.packPath, "--yes"],
      cwd: repoRoot,
      env: { ...process.env, GEODE_DOCUMENTS_DIR: ctx.documentsDir },
    });
    await expect.poll(() => fs.existsSync(path.join(ctx.documentsDir, "Acme Onboarding 2", "Welcome.md")), { timeout: 15_000 }).toBe(true);
    await second.close();
    expect(fs.readdirSync(ctx.documentsDir).sort()).toEqual(["Acme Onboarding", "Acme Onboarding 2"]);
  } finally {
    fs.rmSync(ctx.userDataDir, { recursive: true, force: true });
    fs.rmSync(ctx.documentsDir, { recursive: true, force: true });
    fs.rmSync(ctx.fixtureDir, { recursive: true, force: true });
  }
});
