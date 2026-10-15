import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Drives Settings -> iCloud Drive of the geode-icloud-sync plugin in a real (hidden) Geode.
 * The plugin is pointed at a temp "iCloud Drive" through GEODE_ICLOUD_BASE, so the user's real
 * iCloud is never read or written. The plugin registers nothing off macOS, so this is mac-only.
 */
test.skip(process.platform !== "darwin", "iCloud Drive sync plugin is macOS-only");
test.describe.configure({ mode: "serial" });

const repoRoot = path.resolve(__dirname, "..", "..");
const pluginSrc = path.join(repoRoot, "packages", "geode-icloud-sync", "dist");
const shotDir = process.env.GEODE_QA_SHOTS;

let app: ElectronApplication;
let win: Page;
let vaultDir: string;
let userDataDir: string;
let base: string;
let dataJson: string;
const realGeodeDir = path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "Geode");
const statSig = (p: string) => {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${fs.readdirSync(p).sort().join(",")}`;
  } catch {
    return "absent";
  }
};
let realBefore = "";
let modal: ReturnType<Page["locator"]>;

const geodeDir = (name: string) => path.join(base, "Geode", name);
const readChosen = (): string[] => {
  try {
    return Object.values(JSON.parse(fs.readFileSync(dataJson, "utf8")).folders ?? {});
  } catch {
    return [];
  }
};
async function shot(name: string, testInfo: { outputPath: (n: string) => string }) {
  await win.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await win.screenshot({ path: path.join(shotDir, `${name}.png`) });
  }
}
async function openIcloudTab() {
  await win.evaluate(() => (window as any).app.setting.openTabById("geode-icloud-sync"));
  await expect(modal.getByRole("heading", { name: "iCloud Drive" })).toBeVisible();
  await expect(modal.getByText("Remote folder name")).toBeVisible();
}

test.beforeAll(async () => {
  realBefore = statSig(realGeodeDir);
  expect(fs.existsSync(path.join(pluginSrc, "main.js")), "run `npm run build:icloud-sync` first").toBe(true);
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-vault-"));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-user-"));
  base = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-base-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "hello");

  // Pre-seeded remotes: one created by "another Mac" (marked), one foreign (unmarked, non-empty).
  fs.mkdirSync(path.join(geodeDir("From Other Mac"), ".geode-sync"), { recursive: true });
  fs.writeFileSync(path.join(geodeDir("From Other Mac"), ".geode-sync", "marker.json"), "{}");
  fs.mkdirSync(geodeDir("Someones Photos"), { recursive: true });
  fs.writeFileSync(path.join(geodeDir("Someones Photos"), "holiday.jpg"), "not a geode folder");

  const pluginDir = path.join(vaultDir, ".geode", "plugins", "geode-icloud-sync");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(pluginSrc, "main.js"), path.join(pluginDir, "main.js"));
  fs.copyFileSync(path.join(pluginSrc, "manifest.json"), path.join(pluginDir, "manifest.json"));
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["geode-icloud-sync"]));
  dataJson = path.join(pluginDir, "data.json");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1", GEODE_ICLOUD_BASE: base },
  });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 800 });
  await win.waitForFunction(() => Boolean((window as any).app?.workspace));
  modal = win.locator('.modal.mod-settings[aria-label="Settings"]');
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of [vaultDir, userDataDir, base]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("plugin loads without error and registers the iCloud provider", async () => {
  expect(await win.evaluate(() => (window as any).app.pluginManager?.getLoadError("geode-icloud-sync") ?? null)).toBeNull();
  await expect.poll(() => win.evaluate(() => (window as any).app.sync.listProviders().map((p: any) => p.id))).toContain("icloud");
});

test("iCloud Drive settings tab renders with the vault-derived default folder name", async ({}, testInfo) => {
  await openIcloudTab();
  const field = modal.getByRole("textbox").first();
  await expect(field).toHaveValue(path.basename(vaultDir));
  await expect(modal.getByRole("button", { name: "Apply" })).toBeVisible();
  await expect(modal.getByText("Use an existing remote folder")).toBeVisible();
  // Status line points at the temp base, never the real iCloud Drive.
  await expect(modal).toContainText(`${path.basename(vaultDir)} (will be created on first sync)`);
  await shot("01-settings-tab-default", testInfo);
});

test("dropdown lists the marked folder and omits the unmarked one", async () => {
  await openIcloudTab();
  const dropdown = modal.getByRole("combobox").last();
  const options = await dropdown.locator("option").allTextContents();
  expect(options).toContain("From Other Mac");
  expect(options).not.toContain("Someones Photos");
});

test("typing a name and pressing Apply persists it to data.json", async ({}, testInfo) => {
  await openIcloudTab();
  const field = modal.getByRole("textbox").first();
  await field.fill("My Shared Vault");
  await modal.getByRole("button", { name: "Apply" }).click();
  await expect(win.locator(".notice", { hasText: 'Remote folder set to "My Shared Vault"' }).last()).toBeVisible();
  await expect.poll(readChosen).toEqual(["My Shared Vault"]);
  // The tab re-renders showing the saved name.
  await expect(modal.getByRole("textbox").first()).toHaveValue("My Shared Vault");
  await shot("02-after-apply", testInfo);
});

test("unsafe characters are sanitised and the user is told", async () => {
  await openIcloudTab();
  await modal.getByRole("textbox").first().fill("a/b");
  await modal.getByRole("button", { name: "Apply" }).click();
  await expect(win.locator(".notice", { hasText: "name was adjusted" }).last()).toBeVisible();
  await expect.poll(readChosen).toEqual(["a_b"]);
});

test("choosing a marked folder from the dropdown applies it", async ({}, testInfo) => {
  await openIcloudTab();
  await modal.getByRole("combobox").last().selectOption("From Other Mac");
  await expect.poll(readChosen).toEqual(["From Other Mac"]);
  await openIcloudTab();
  await expect(modal.getByRole("textbox").first()).toHaveValue("From Other Mac");
  await shot("03-after-dropdown-pick", testInfo);
});

test("a non-empty folder without the Geode marker is refused and nothing is saved", async ({}, testInfo) => {
  await openIcloudTab();
  await modal.getByRole("textbox").first().fill("Someones Photos");
  await modal.getByRole("button", { name: "Apply" }).click();
  await expect(win.locator(".notice", { hasText: "not a Geode sync folder" }).last()).toBeVisible();
  expect(readChosen()).toEqual(["From Other Mac"]);
  // The foreign folder was left untouched (no marker written into it).
  expect(fs.existsSync(path.join(geodeDir("Someones Photos"), ".geode-sync"))).toBe(false);
  await shot("04-refused-unmarked", testInfo);
});

test("changing the folder is refused while iCloud is the active sync provider", async ({}, testInfo) => {
  await win.evaluate(() => (window as any).app.setting.openTabById("sync"));
  await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("icloud");
  await expect.poll(() => win.evaluate(() => (window as any).app.sync.getActiveProvider()?.id)).toBe("icloud");

  await openIcloudTab();
  await modal.getByRole("textbox").first().fill("Another Name");
  await modal.getByRole("button", { name: "Apply" }).click();
  await expect(win.locator(".notice", { hasText: "Disconnect iCloud sync in Settings → Sync" }).last()).toBeVisible();
  expect(readChosen()).toEqual(["From Other Mac"]);
  await shot("05-refused-while-active", testInfo);
});

test("the real iCloud Drive was never touched", async () => {
  // Only stats the real folder (read-only); it must be exactly as it was before the app launched.
  expect(statSig(realGeodeDir)).toBe(realBefore);
  expect(fs.existsSync(path.join(base, "Geode"))).toBe(true);
});
