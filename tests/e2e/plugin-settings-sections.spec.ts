import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const PLUGIN_ID = "sections-probe";
const PLUGIN_NAME = "Sections Probe";
const SECTIONS = Array.from({ length: 14 }, (_, i) => ({ id: `s${i + 1}`, name: `Section ${i + 1}` }));

test("plugin setting sections group under the plugin name, keep order, open by id and preserve nav scroll", async ({}, testInfo) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sections-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sections-user-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "hello");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "manifest.json"),
    JSON.stringify({ id: PLUGIN_ID, name: PLUGIN_NAME, version: "1.0.0", minAppVersion: "0.1.0", description: "Settings sections fixture", author: "Geode" })
  );
  // Sections are registered BEFORE addSettingTab to prove "General" still lists first.
  fs.writeFileSync(
    path.join(pluginDir, "main.js"),
    `
    const { Plugin, PluginSettingTab } = require('geode');
    const SECTIONS = ${JSON.stringify(SECTIONS)};
    const mk = (app, plugin, text) => {
      const t = new PluginSettingTab(app, plugin);
      t.display = function () { this.containerEl.empty(); const h = this.containerEl.createEl('h2', { text }); h.setAttribute('data-probe', text); };
      return t;
    };
    module.exports.default = class extends Plugin {
      onload() {
        for (const s of SECTIONS) this.addSettingSection({ id: s.id, name: s.name, tab: mk(this.app, this, 'Content of ' + s.name) });
        this.addSettingTab(mk(this.app, this, 'Content of General'));
      }
    };
  `
  );
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([PLUGIN_ID]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot, env: { ...process.env, GEODE_HEADLESS: "1" } });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => Boolean((window as any).app?.workspace));
    expect(await window.evaluate((id) => (window as any).app.pluginManager?.getLoadError(id) ?? null, PLUGIN_ID)).toBeNull();
    await window.setViewportSize({ width: 1280, height: 800 });

    await window.evaluate(() => (window as any).app.setting.open());
    const modal = window.locator('.modal.mod-settings[aria-label="Settings"]');
    await expect(modal).toBeVisible();
    const nav = modal.locator(".vertical-tab-header");

    // Group titled with the manifest name.
    const group = nav.locator(".vertical-tab-header-group", {
      has: window.locator(".vertical-tab-header-group-title", { hasText: new RegExp(`^${PLUGIN_NAME}$`) }),
    });
    await expect(group).toHaveCount(1);
    // Order: General first, then registration order.
    const labels = await group.locator(".vertical-tab-nav-item").allTextContents();
    expect(labels).toEqual(["General", ...SECTIONS.map((s) => s.name)]);
    // addSettingTab-only "Plugin options" group must not list this plugin.
    await expect(nav.locator(".vertical-tab-header-group-title", { hasText: "Plugin options" })).toHaveCount(0);

    // Clicking a section shows its content.
    await group.getByRole("tab", { name: "Section 2", exact: true }).click();
    await expect(modal.locator('[data-probe="Content of Section 2"]')).toBeVisible();
    await group.getByRole("tab", { name: "General", exact: true }).click();
    await expect(modal.locator('[data-probe="Content of General"]')).toBeVisible();

    // openTabById with the composite id.
    await window.evaluate((id) => (window as any).app.setting.openTabById(id), `${PLUGIN_ID}:s3`);
    await expect(modal.locator('[data-probe="Content of Section 3"]')).toBeVisible();
    await expect(group.getByRole("tab", { name: "Section 3", exact: true })).toHaveAttribute("aria-selected", "true");

    // Nav scroll is preserved across a section click. Shrink the nav so it must scroll.
    const metrics = async () => nav.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    await nav.evaluate((el) => {
      (el as HTMLElement).style.maxHeight = "260px";
      (el as HTMLElement).style.overflowY = "auto";
    });
    const before = await metrics();
    expect(before.max).toBeGreaterThan(100);
    await nav.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const scrolled = (await metrics()).top;
    expect(scrolled).toBeGreaterThan(100);
    await group.getByRole("tab", { name: "Section 14", exact: true }).click();
    await expect(modal.locator('[data-probe="Content of Section 14"]')).toBeVisible();
    expect((await metrics()).top).toBe(scrolled);
    await group.getByRole("tab", { name: "Section 13", exact: true }).click();
    await expect(modal.locator('[data-probe="Content of Section 13"]')).toBeVisible();
    expect((await metrics()).top).toBe(scrolled);

    // Screenshots: undo the artificial nav constraint, scroll plugin group into view.
    await nav.evaluate((el) => {
      (el as HTMLElement).style.maxHeight = "";
      (el as HTMLElement).style.overflowY = "";
    });
    await window.evaluate((id) => (window as any).app.setting.openTabById(id), `${PLUGIN_ID}:s2`);
    await group.locator(".vertical-tab-header-group-title").scrollIntoViewIfNeeded();
    await window.screenshot({ path: testInfo.outputPath("settings-sections-desktop.png") });
    await window.setViewportSize({ width: 390, height: 844 });
    await group.locator(".vertical-tab-header-group-title").scrollIntoViewIfNeeded();
    await window.screenshot({ path: testInfo.outputPath("settings-sections-mobile.png") });
    for (const f of ["desktop", "mobile"]) {
      fs.copyFileSync(testInfo.outputPath(`settings-sections-${f}.png`), path.join(os.tmpdir(), `settings-sections-${f}.png`));
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
