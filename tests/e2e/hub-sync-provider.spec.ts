import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
test.setTimeout(150_000);

interface Device { name: string; vault: string; profile: string; app?: ElectronApplication; page?: Page }

function device(base: string, name: string): Device {
  const vault = path.join(base, name, "vault"), profile = path.join(base, name, "profile");
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  return { name, vault, profile };
}

async function launch(d: Device): Promise<Page> {
  d.app = await electron.launch({ args: [repoRoot, `--user-data-dir=${d.profile}`], cwd: repoRoot, env: { ...process.env, GEODE_HEADLESS: "1" } });
  d.page = await d.app.firstWindow();
  await d.page.waitForFunction(() => (window as any).app?.sync?.listProviders().some((provider: any) => provider.id === "geode.hub"));
  return d.page;
}

async function openSyncTab(page: Page) {
  await page.evaluate(() => (window as any).app.setting.openTabById("sync"));
  const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
  await expect(modal.getByRole("heading", { name: "Sync" })).toBeVisible();
  return modal;
}

/** Screenshots go to the test output; set GEODE_SCREENSHOT_DIR (e.g. docs/screenshots/hub-sync-provider) to refresh the committed ones. */
const shotPath = (testInfo: import("@playwright/test").TestInfo, name: string) => {
  const dir = process.env.GEODE_SCREENSHOT_DIR;
  if (!dir) return testInfo.outputPath(name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};

/** True once a content record for `name` has been published to the hub. */
const hubHasNote = (hub: string, name: string) => {
  try {
    return fs.readdirSync(path.join(hub, "records")).some(file => {
      const record = JSON.parse(fs.readFileSync(path.join(hub, "records", file), "utf8"));
      return record.namespace === "content" && record.location?.name === name && record.deleted === false;
    });
  } catch { return false; }
};

const countRecords = (hub: string) => { try { return fs.readdirSync(path.join(hub, "records")).length; } catch { return 0; } };

test("two desktop app instances sync through a directory hub with the built-in Folder or SSH hub provider", async ({}, testInfo) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hub-e2e-"));
  const hub = path.join(base, "hub");
  const a = device(base, "a"), b = device(base, "b");
  fs.writeFileSync(path.join(a.vault, "Alpha.md"), "alpha from A");
  fs.mkdirSync(path.join(a.vault, "Notes"));
  fs.writeFileSync(path.join(a.vault, "Notes", "Deep.md"), "deep from A");
  try {
    // ---- Device A: select the provider, configure the hub, create it, confirm the first sync.
    let page = await launch(a);
    let modal = await openSyncTab(page);
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
    await expect(modal.getByRole("textbox", { name: "Hub store path" })).toBeVisible();
    await modal.getByRole("textbox", { name: "Hub store path" }).fill(hub);
    await modal.getByRole("checkbox", { name: "Create the hub if it is missing" }).check();
    await modal.getByRole("button", { name: "Save hub settings" }).click();
    await expect(modal.locator("[data-hub-result]")).toContainText("saved");
    await modal.getByRole("button", { name: "Test connection" }).click();
    await expect(modal.locator("[data-hub-result]")).toContainText("holds no vault yet");

    await modal.getByRole("textbox", { name: "Shared vault name" }).fill("E2E Hub");
    await modal.getByRole("button", { name: "Create shared vault" }).click();
    await expect(modal).toContainText('Bound to shared vault "E2E Hub"');
    // The generic one-click approval is not offered; Preview first.
    await expect(modal.getByRole("button", { name: "Approve & sync" })).toHaveCount(0);
    await modal.getByRole("button", { name: "Preview" }).click();
    const plan = modal.locator("[data-hub-plan]");
    await expect(plan).toContainText("First sync plan");
    await expect(plan).toContainText("deletion(s)");
    await expect(plan).toContainText(/[1-9]\d* upload\(s\) to the hub/);
    expect(countRecords(hub), "previewing publishes nothing").toBe(0);
    await page.screenshot({ path: shotPath(testInfo, "first-sync-plan.png") });
    await plan.getByRole("button", { name: "Confirm first sync" }).click();
    await expect.poll(() => countRecords(hub), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(modal.locator("[data-hub-plan]")).toHaveCount(0);
    await page.screenshot({ path: shotPath(testInfo, "synced.png") });
    await a.app!.close(); a.app = undefined;

    // ---- Device B: a different vault and profile joins the existing hub.
    page = await launch(b);
    modal = await openSyncTab(page);
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
    await modal.getByRole("textbox", { name: "Hub store path" }).fill(hub);
    await modal.getByRole("button", { name: "Save hub settings" }).click();
    await modal.getByRole("button", { name: "Find shared vaults" }).click();
    await modal.getByRole("button", { name: "Join E2E Hub" }).click();
    await modal.getByRole("button", { name: "Preview" }).click();
    await expect(modal.locator("[data-hub-plan]")).toContainText(/[1-9]\d* download\(s\)/);
    expect(fs.existsSync(path.join(b.vault, "Alpha.md")), "nothing is downloaded before confirmation").toBe(false);
    await modal.locator("[data-hub-plan]").getByRole("button", { name: "Confirm first sync" }).click();
    await expect.poll(() => fs.existsSync(path.join(b.vault, "Notes", "Deep.md")), { timeout: 30_000 }).toBe(true);
    expect(fs.readFileSync(path.join(b.vault, "Alpha.md"), "utf8")).toBe("alpha from A");
    expect(fs.readFileSync(path.join(b.vault, "Notes", "Deep.md"), "utf8")).toBe("deep from A");

    // B edits; the unattended path (debounce after the edit) publishes it without any click.
    fs.writeFileSync(path.join(b.vault, "FromB.md"), "written on B");
    await expect.poll(() => hubHasNote(hub, "FromB.md"), { timeout: 60_000 }).toBe(true);
    await b.app!.close(); b.app = undefined;

    // ---- A relaunches: the saved binding restores and pulls B's note by itself (no clicks).
    page = await launch(a);
    await expect.poll(() => fs.existsSync(path.join(a.vault, "FromB.md")), { timeout: 60_000 }).toBe(true);
    expect(fs.readFileSync(path.join(a.vault, "FromB.md"), "utf8")).toBe("written on B");
    expect(await page.evaluate(() => (window as any).app.sync.getActiveProvider())).toEqual({ id: "geode.hub", name: "Folder or SSH hub" });
  } finally {
    for (const d of [a, b]) await d.app?.close().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
