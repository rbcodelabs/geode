import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function launch(vaultDir: string, userDataDir: string) {
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await window.waitForFunction(() => !!(window as any).app?.workspace);
  return { app, window };
}

test("Web Viewer live lifecycle defers/restores tabs and refreshes all availability surfaces", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-settings-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-settings-user-"));
  fs.writeFileSync(path.join(vaultDir, "Local.html"), "<!doctype html><h1>local</h1>");
  const { app, window } = await launch(vaultDir, userDataDir);
  try {
    await window.evaluate(async () => {
      const a = (window as any).app;
      (window as any).__webDescriptor = a.internalPlugins.getPluginById("webviewer");
      (window as any).__webOptions = (window as any).__webDescriptor.instance.options;
      await a.openWebViewer("https://example.com/");
      a.openEmptyTab(a.workspace.activeGroup);
      a.setting.openTabById("core-plugins");
    });
    const modal = window.locator('.modal.mod-settings[aria-label="Settings"]');
    const enabled = modal.getByRole("checkbox", { name: "Enable Web Viewer" });
    await expect(enabled).toBeChecked();
    await expect(window.getByRole("button", { name: "Open browser" })).toBeVisible();

    await enabled.uncheck();
    await expect.poll(() => window.evaluate(() => {
      const a = (window as any).app;
      return {
        deferred: a.workspace.getLeavesOfType("webviewer")[0]?.view.constructor.name,
        descriptorSame: a.internalPlugins.getPluginById("webviewer") === (window as any).__webDescriptor,
        optionsSame: (window as any).__webDescriptor.instance.options === (window as any).__webOptions,
        enabled: (window as any).__webDescriptor.enabled,
        enabledLookup: a.internalPlugins.getEnabledPluginById("webviewer"),
        openCommand: a.commands.findCommand("open-web-viewer")?.checkCallback(true),
        searchCommand: a.commands.execute("search-web"),
      };
    })).toEqual({ deferred: "DeferredView", descriptorSame: true, optionsSame: true, enabled: false, enabledLookup: null, openCommand: false, searchCommand: false });
    await expect(window.getByRole("button", { name: "Open browser" })).toHaveCount(0);
    expect(await window.evaluate(async () => {
      const a = (window as any).app;
      const opened: string[] = [];
      a.host.navigation.openExternal = async (url: string) => { opened.push(url); };
      a.settings.webViewer.openLinksInApp = true;
      a.openExternalLink("https://example.org/disabled");
      await Promise.resolve();
      return opened;
    })).toEqual(["https://example.org/disabled"]);

    const before = await window.evaluate(async () => {
      const a = (window as any).app;
      const id = a.workspace.getActiveLeaf().id;
      await a.openFile(a.vault.getAbstractFileByPath("Local.html"), false);
      return id;
    });
    await expect(window.locator(".notice")).toContainText("Enable Web Viewer in Settings → Core plugins");
    expect(await window.evaluate(() => (window as any).app.workspace.getActiveLeaf().id)).toBe(before);

    await enabled.check();
    await expect.poll(() => window.evaluate(() => {
      const a = (window as any).app;
      return {
        view: a.workspace.getLeavesOfType("webviewer")[0]?.view.constructor.name,
        enabled: (window as any).__webDescriptor.enabled,
        enabledLookup: !!a.internalPlugins.getEnabledPluginById("webviewer"),
        openCommand: a.commands.findCommand("open-web-viewer")?.checkCallback(true),
      };
    })).toEqual({ view: "WebView", enabled: true, enabledLookup: true, openCommand: true });
    await expect(window.getByRole("button", { name: "Open browser" }).first()).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Web Viewer persistence is per-vault and failed writes leave runtime and controls unchanged", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-persist-vault-"));
  const otherVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-persist-other-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webviewer-persist-user-"));
  let current = await launch(vaultDir, userDataDir);
  try {
    await current.window.evaluate(() => {
      const a = (window as any).app;
      a.setting.openTabById("core-plugins");
      a.__originalWrite = a.host.config.write.bind(a.host.config);
      a.host.config.write = async (name: string, value: unknown) => {
        if (name === "web-viewer") throw new Error("simulated failure");
        return a.__originalWrite(name, value);
      };
    });
    let enabled = current.window.getByRole("checkbox", { name: "Enable Web Viewer" });
    await enabled.click();
    await expect(current.window.locator(".notice")).toContainText("Could not save Web Viewer settings");
    await expect(enabled).toBeChecked();
    expect(await current.window.evaluate(() => (window as any).app.webViewer.enabled)).toBe(true);
    await current.window.locator(".notice").last().click();
    await current.window.evaluate(() => {
      const a = (window as any).app;
      a.host.config.write = a.__originalWrite;
    });
    await enabled.click();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(vaultDir, ".geode", "web-viewer.json"), "utf8")).enabled).toBe(false);

    await current.app.close();
    current = await launch(otherVaultDir, userDataDir);
    expect(await current.window.evaluate(() => (window as any).app.webViewer.enabled)).toBe(true);
    await current.app.close();
    current = await launch(vaultDir, userDataDir);
    expect(await current.window.evaluate(() => (window as any).app.webViewer.enabled)).toBe(false);
  } finally {
    await current.app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(otherVaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
