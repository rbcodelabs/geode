import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Drives Settings -> Core plugins -> iCloud sync in a real (hidden) Geode. iCloud sync is a core plugin that
 * talks to Geode's iCloud container through main-process IPC; here the container's Documents/ directory is
 * replaced by a temp directory through GEODE_ICLOUD_BASE, so the user's real iCloud is never read or written.
 * The bridge is exposed on macOS only, so this is mac-only (the Linux CI job skips it).
 */
test.skip(process.platform !== "darwin", "iCloud sync is available on macOS (and iOS) only");
test.describe.configure({ mode: "serial" });

const repoRoot = path.resolve(__dirname, "..", "..");
const shotDir = process.env.GEODE_QA_SHOTS;
const realContainer = path.join(os.homedir(), "Library", "Mobile Documents", "iCloud~com~rbcodelabs~geode");
const FOLDERS_KEY = "plugin/icloud-sync/folders";

const statSig = (p: string) => {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${fs.readdirSync(p).sort().join(",")}`;
  } catch {
    return "absent";
  }
};

async function launch(env: Record<string, string>): Promise<{ app: ElectronApplication; win: Page; vaultDir: string; userDataDir: string }> {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-user-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "hello");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1", ...env },
  });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 800 });
  await win.waitForFunction(() => Boolean((window as any).app?.workspace));
  return { app, win, vaultDir, userDataDir };
}

async function shot(win: Page, name: string, testInfo: { outputPath: (n: string) => string }) {
  await win.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await win.screenshot({ path: path.join(shotDir, `${name}.png`) });
  }
}

test.describe("with a temp iCloud container", () => {
  let app: ElectronApplication;
  let win: Page;
  let vaultDir: string;
  let userDataDir: string;
  let base: string;
  let modal: ReturnType<Page["locator"]>;
  let realBefore = "";

  const readChosen = async (): Promise<string[]> =>
    Object.values((await win.evaluate((key) => (window as any).app.host.deviceState.read(key), FOLDERS_KEY))?.folders ?? {});
  const providers = () => win.evaluate(() => (window as any).app.sync.listProviders().map((p: any) => p.id));
  const section = () => modal.locator(".icloud-sync-settings");
  const nameField = () => modal.getByRole("textbox", { name: "Remote folder name" });

  async function openCoreTab() {
    await win.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await expect(modal.getByRole("heading", { name: "iCloud sync" })).toBeVisible();
  }
  async function openConfiguredTab() {
    await openCoreTab();
    await expect(nameField()).toBeVisible();
  }

  test.beforeAll(async () => {
    realBefore = statSig(realContainer);
    base = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-docs-"));
    // Pre-seeded remotes: one created by "another device" (marked), one foreign (unmarked, non-empty).
    fs.mkdirSync(path.join(base, "From Other Device", ".geode-sync"), { recursive: true });
    fs.writeFileSync(path.join(base, "From Other Device", ".geode-sync", "marker.json"), "{}");
    fs.mkdirSync(path.join(base, "Someones Photos"), { recursive: true });
    fs.writeFileSync(path.join(base, "Someones Photos", "holiday.jpg"), "not a geode folder");
    ({ app, win, vaultDir, userDataDir } = await launch({ GEODE_ICLOUD_BASE: base }));
    modal = win.locator('.modal.mod-settings[aria-label="Settings"]');
  });

  test.afterAll(async () => {
    await app?.close();
    for (const dir of [vaultDir, userDataDir, base]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("is off by default: the section is offered, the toggle is unchecked and no provider is registered", async ({}, testInfo) => {
    await openCoreTab();
    await expect(modal.getByRole("checkbox", { name: "Enable iCloud sync" })).not.toBeChecked();
    await expect(nameField()).toHaveCount(0);
    expect(await providers()).not.toContain("icloud");
    expect(await win.evaluate(() => (window as any).app.host.capabilities.icloudContainer)).toBe(true);
    await shot(win, "01-core-plugins-icloud-off", testInfo);
  });

  test("enabling the core plugin registers the iCloud provider and shows the default remote folder", async ({}, testInfo) => {
    await openCoreTab();
    await modal.getByRole("checkbox", { name: "Enable iCloud sync" }).check();
    await expect(nameField()).toHaveValue(path.basename(vaultDir));
    await expect.poll(providers).toContain("icloud");
    // The status line points at the temp container, never the real iCloud.
    await expect(section()).toContainText(`Remote: iCloud container / ${path.basename(vaultDir)} (will be created on first sync)`);
    await expect(modal.getByRole("button", { name: "Apply" })).toBeVisible();
    await expect(modal.getByText("Use an existing remote folder")).toBeVisible();
    await shot(win, "02-core-plugins-icloud-on", testInfo);
  });

  test("dropdown lists the marked folder and omits the unmarked one", async () => {
    await openConfiguredTab();
    const options = await modal.getByRole("combobox", { name: "Existing remote folder" }).locator("option").allTextContents();
    expect(options).toContain("From Other Device");
    expect(options).not.toContain("Someones Photos");
  });

  test("typing a name and pressing Apply persists it per vault in device state", async ({}, testInfo) => {
    await openConfiguredTab();
    await nameField().fill("My Shared Vault");
    await modal.getByRole("button", { name: "Apply" }).click();
    await expect(win.locator(".notice", { hasText: 'Remote folder set to "My Shared Vault"' }).last()).toBeVisible();
    await expect.poll(readChosen).toEqual(["My Shared Vault"]);
    await expect(nameField()).toHaveValue("My Shared Vault");
    await shot(win, "03-after-apply", testInfo);
  });

  test("unsafe characters are sanitised and the user is told", async () => {
    await openConfiguredTab();
    await nameField().fill("a/b");
    await modal.getByRole("button", { name: "Apply" }).click();
    await expect(win.locator(".notice", { hasText: "name was adjusted" }).last()).toBeVisible();
    await expect.poll(readChosen).toEqual(["a_b"]);
  });

  test("choosing a marked folder from the dropdown applies it", async ({}, testInfo) => {
    await openConfiguredTab();
    await modal.getByRole("combobox", { name: "Existing remote folder" }).selectOption("From Other Device");
    await expect.poll(readChosen).toEqual(["From Other Device"]);
    await openConfiguredTab();
    await expect(nameField()).toHaveValue("From Other Device");
    await expect(section()).toContainText("(existing Geode folder)");
    await shot(win, "04-after-dropdown-pick", testInfo);
  });

  test("a non-empty folder without the Geode marker is refused and nothing is saved", async ({}, testInfo) => {
    await openConfiguredTab();
    await nameField().fill("Someones Photos");
    await modal.getByRole("button", { name: "Apply" }).click();
    await expect(win.locator(".notice", { hasText: "not a Geode sync folder" }).last()).toBeVisible();
    expect(await readChosen()).toEqual(["From Other Device"]);
    // The foreign folder was left untouched (no marker written into it).
    expect(fs.existsSync(path.join(base, "Someones Photos", ".geode-sync"))).toBe(false);
    await shot(win, "05-refused-unmarked", testInfo);
  });

  test("activating iCloud syncs through the real IPC bridge into the temp container, and the folder is then locked", async ({}, testInfo) => {
    await win.evaluate(() => (window as any).app.setting.openTabById("sync"));
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("icloud");
    await expect.poll(() => win.evaluate(() => (window as any).app.sync.getActiveProvider()?.id)).toBe("icloud");
    // Connecting scans the remote, which creates the chosen folder and its marker inside the temp container.
    await expect.poll(() => fs.existsSync(path.join(base, "From Other Device", ".geode-sync", "marker.json"))).toBe(true);

    await openConfiguredTab();
    await nameField().fill("Another Name");
    await modal.getByRole("button", { name: "Apply" }).click();
    await expect(win.locator(".notice", { hasText: "Disconnect iCloud sync in Settings → Sync" }).last()).toBeVisible();
    expect(await readChosen()).toEqual(["From Other Device"]);
    await shot(win, "06-refused-while-active", testInfo);
  });

  test("turning the core plugin off unregisters the provider", async () => {
    await openConfiguredTab();
    await modal.getByRole("checkbox", { name: "Enable iCloud sync" }).uncheck();
    await expect.poll(providers).not.toContain("icloud");
    await expect(nameField()).toHaveCount(0);
  });

  test("the real iCloud container was never touched", async () => {
    // Only stats the real folder (read-only); it must be exactly as it was before the app launched.
    expect(statSig(realContainer)).toBe(realBefore);
    expect(fs.existsSync(path.join(base, "From Other Device"))).toBe(true);
  });
});

test.describe("when the container is unavailable", () => {
  let app: ElectronApplication;
  let win: Page;
  let vaultDir: string;
  let userDataDir: string;
  let missing: string;
  let parent: string;

  test.beforeAll(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "geode-icloud-missing-"));
    missing = path.join(parent, "no-such-documents");
    ({ app, win, vaultDir, userDataDir } = await launch({ GEODE_ICLOUD_BASE: missing }));
  });
  test.afterAll(async () => {
    await app?.close();
    for (const dir of [vaultDir, userDataDir, parent]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("shows a clear message, offers no folder controls, and creates nothing", async ({}, testInfo) => {
    const modal = win.locator('.modal.mod-settings[aria-label="Settings"]');
    await win.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await modal.getByRole("checkbox", { name: "Enable iCloud sync" }).check();
    await expect(modal.locator(".icloud-sync-status")).toContainText("iCloud container unavailable");
    await expect(modal.locator(".icloud-sync-status")).toContainText("does not exist");
    await expect(modal.getByRole("textbox", { name: "Remote folder name" })).toHaveCount(0);
    await shot(win, "07-container-unavailable", testInfo);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test("a sync scan reports the provider as unavailable rather than an empty remote", async () => {
    const outcome = await win.evaluate(async () => {
      const app = (window as any).app;
      await app.sync.activate("icloud");
      try {
        await app.sync.preview();
        return { threw: false, message: "" };
      } catch (error) {
        return { threw: true, message: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(outcome.threw).toBe(true);
    expect(outcome.message).toMatch(/unavailable/);
    expect(fs.existsSync(missing)).toBe(false);
  });
});
