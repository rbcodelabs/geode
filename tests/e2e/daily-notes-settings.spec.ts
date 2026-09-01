import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const calendarFixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "calendar");

async function launch(vaultDir: string, userDataDir: string): Promise<ElectronApplication> {
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
}

test("Daily Notes settings persist lifecycle and keep plugin compatibility live", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-daily-settings-vault-"));
  const otherVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-daily-settings-other-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-daily-settings-user-"));
  let app = await launch(vaultDir, userDataDir);

  try {
    let window = await app.firstWindow();
    await window.waitForFunction(() => !!(window as any).app?.workspace);
    await window.evaluate(() => (window as any).app.setting.openTabById("daily-notes"));

    const modal = window.locator('.modal.mod-settings[aria-label="Settings"]');
    await expect(modal.getByRole("heading", { name: "Daily Notes" })).toBeVisible();
    const enabled = modal.getByRole("checkbox", { name: "Enable Daily Notes" });
    await expect(enabled).toBeChecked();

    const initial = await window.evaluate(() => {
      const ip = (window as any).app.internalPlugins;
      const descriptor = ip.getPluginById("daily-notes");
      (window as any).__dailyDescriptor = descriptor;
      (window as any).__dailyOptions = descriptor.instance.options;
      return {
        enabled: descriptor.enabled,
        enabledLookup: !!ip.getEnabledPluginById("daily-notes"),
        options: descriptor.instance.options,
      };
    });
    expect(initial).toEqual({
      enabled: true,
      enabledLookup: true,
      options: { folder: "", format: "YYYY-MM-DD", template: "" },
    });

    await window.evaluate(() => {
      const a = (window as any).app;
      a.__dailyOriginalWrite = a.host.config.write;
      a.host.config.write = async (name: string, value: unknown) => {
        if (name === "daily-notes") throw new Error("simulated persistence failure");
        return a.__dailyOriginalWrite(name, value);
      };
    });
    await enabled.click();
    await expect(window.locator(".notice")).toContainText("Could not save Daily Notes settings");
    await expect(enabled).toBeChecked();
    expect(await window.evaluate(() => (window as any).app.dailyNotes.enabled)).toBe(true);
    await window.evaluate(() => {
      const a = (window as any).app;
      a.host.config.write = a.__dailyOriginalWrite;
    });

    await window.evaluate(() => {
      const a = (window as any).app;
      a.host.config.write = async (name: string, value: any) => {
        if (name === "daily-notes" && value.folder === "Pending") {
          await new Promise<void>((resolve) => { a.__resolveDailyWrite = resolve; });
        }
        return a.__dailyOriginalWrite(name, value);
      };
    });
    await modal.getByRole("textbox", { name: "New file location" }).fill(" /Pending/ ");
    await modal.getByRole("textbox", { name: "New file location" }).press("Tab");
    await window.waitForFunction(() => typeof (window as any).app.__resolveDailyWrite === "function");
    const dateDraft = modal.getByRole("textbox", { name: "Date format" });
    await dateDraft.fill("draft-format");
    await dateDraft.focus();
    await window.evaluate(() => (window as any).app.__resolveDailyWrite());
    await expect(modal.getByRole("textbox", { name: "New file location" })).toHaveValue("Pending");
    await expect(dateDraft).toHaveValue("draft-format");
    await expect(dateDraft).toBeFocused();
    await window.evaluate(() => {
      const a = (window as any).app;
      a.host.config.write = a.__dailyOriginalWrite;
    });

    await enabled.uncheck();
    await expect.poll(() => {
      const file = path.join(vaultDir, ".geode", "daily-notes.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    }).toEqual({ enabled: false, folder: "Pending", format: "draft-format", template: "" });

    const disabled = await window.evaluate(() => {
      const a = (window as any).app;
      const ip = a.internalPlugins;
      return {
        descriptorEnabled: ip.getPluginById("daily-notes").enabled,
        propertyEnabled: ip.plugins["daily-notes"].enabled,
        enabledLookup: ip.getEnabledPluginById("daily-notes"),
        commandAvailable: a.commands.execute("daily-note"),
      };
    });
    expect(disabled).toEqual({
      descriptorEnabled: false,
      propertyEnabled: false,
      enabledLookup: null,
      commandAvailable: false,
    });

    await modal.getByRole("textbox", { name: "New file location" }).fill(" /Journal/Daily/ ");
    await modal.getByRole("textbox", { name: "New file location" }).press("Tab");
    await modal.getByRole("textbox", { name: "Date format" }).fill("   ");
    await modal.getByRole("textbox", { name: "Date format" }).press("Tab");
    await expect(modal.getByRole("textbox", { name: "Date format" })).toHaveValue("YYYY-MM-DD");
    await modal.getByRole("textbox", { name: "Date format" }).fill(" YYYY.MM.DD ");
    await modal.getByRole("textbox", { name: "Date format" }).press("Tab");
    await modal.getByRole("textbox", { name: "Template file location" }).fill(" Templates/Daily.md ");
    await modal.getByRole("textbox", { name: "Template file location" }).press("Tab");
    await enabled.check();

    await expect.poll(() => JSON.parse(
      fs.readFileSync(path.join(vaultDir, ".geode", "daily-notes.json"), "utf8")
    )).toEqual({
      enabled: true,
      folder: "Journal/Daily",
      format: "YYYY.MM.DD",
      template: "Templates/Daily.md",
    });
    await expect(modal.getByRole("textbox", { name: "New file location" })).toHaveValue("Journal/Daily");
    await expect(modal.getByRole("textbox", { name: "Date format" })).toHaveValue("YYYY.MM.DD");
    await expect(modal.getByRole("textbox", { name: "Template file location" })).toHaveValue("Templates/Daily.md");
    const live = await window.evaluate(() => {
      const a = window as any;
      const descriptor = a.app.internalPlugins.getPluginById("daily-notes");
      return {
        sameOptions: descriptor.instance.options === a.__dailyOptions,
        options: a.__dailyOptions,
        enabledLookup: !!a.app.internalPlugins.getEnabledPluginById("daily-notes"),
      };
    });
    expect(live).toEqual({
      sameOptions: true,
      options: { folder: "Journal/Daily", format: "YYYY.MM.DD", template: "Templates/Daily.md" },
      enabledLookup: true,
    });

    await app.close();
    app = await launch(otherVaultDir, userDataDir);
    window = await app.firstWindow();
    await window.waitForFunction(() => !!(window as any).app?.workspace);
    expect(await window.evaluate(() => {
      const descriptor = (window as any).app.internalPlugins.getPluginById("daily-notes");
      return { enabled: descriptor.enabled, options: descriptor.instance.options };
    })).toEqual({
      enabled: true,
      options: { folder: "", format: "YYYY-MM-DD", template: "" },
    });

    await app.close();
    app = await launch(vaultDir, userDataDir);
    window = await app.firstWindow();
    await window.waitForFunction(() => !!(window as any).app?.workspace);
    const restarted = await window.evaluate(() => {
      const descriptor = (window as any).app.internalPlugins.getPluginById("daily-notes");
      return { enabled: descriptor.enabled, options: descriptor.instance.options };
    });
    expect(restarted).toEqual({
      enabled: true,
      options: { folder: "Journal/Daily", format: "YYYY.MM.DD", template: "Templates/Daily.md" },
    });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(otherVaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Calendar sees a disabled Daily Notes lifecycle and shows its own warning", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-calendar-disabled-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-calendar-disabled-user-"));
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "calendar");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(calendarFixtureDir, "manifest.json"), path.join(pluginDir, "manifest.json"));
  fs.copyFileSync(path.join(calendarFixtureDir, "main.js"), path.join(pluginDir, "main.js"));
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["calendar"]));
  fs.writeFileSync(path.join(vaultDir, ".geode", "daily-notes.json"), JSON.stringify({
    enabled: false,
    folder: "Journal",
    format: "YYYY.MM.DD",
    template: "Templates/Daily.md",
  }));
  const app = await launch(vaultDir, userDataDir);

  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => !!(window as any).app?.pluginManager?.getPlugin("calendar"));
    await window.evaluate(() => (window as any).app.setting.openTabById("calendar"));
    await expect(window.getByText("⚠️ Daily Notes plugin not enabled", { exact: true })).toBeVisible();
    expect(await window.evaluate(() => {
      const ip = (window as any).app.internalPlugins;
      return {
        enabled: ip.plugins["daily-notes"].enabled,
        enabledLookup: ip.getEnabledPluginById("daily-notes"),
        options: ip.getPluginById("daily-notes").instance.options,
      };
    })).toEqual({
      enabled: false,
      enabledLookup: null,
      options: { folder: "Journal", format: "YYYY.MM.DD", template: "Templates/Daily.md" },
    });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
