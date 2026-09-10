import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../..");
// Synthetic equivalent of the existing Threads manager contract, not a copy of
// plugin code or user data. No agents, schedulers, subprocesses or network calls.
const pluginCode = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  async onload() {
    this.settings = await this.loadData();
    const projects = this.settings.projects;
    const listeners = new Set();
    this.manager = {
      getProjects: () => projects,
      getProjectCwd: p => p.cwdOverride,
      subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); }
    };
    this.change = (kind) => {
      if (kind === "create") projects.push({ id: "second", name: "Second Project", cwdOverride: projects[0].cwdOverride });
      if (kind === "rename") projects[0].name = "Renamed Project";
      if (kind === "cwd") projects[0].cwdOverride += "-changed";
      if (kind === "delete") projects.splice(0);
      for (const listener of listeners) listener("", { type: "projects_changed" });
    };
  }
};`;

test("restores a granted Threads source across a full app restart without a new grant or vault fallback", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-threads-restart-"));
  const userData = path.join(base, "userdata");
  const vault = path.join(base, "vault");
  const project = path.join(base, "project");
  const plugin = path.join(vault, ".geode/plugins/claude-threads");
  const sourceText = "# External source\n[[Not a vault link]]\n";
  const vaultText = "# Same filename, vault content only\n";
  const settings = JSON.stringify({ projects: [{ id: "first", name: "First Project", vaultFolder: "", cwdOverride: project }] });
  await Promise.all([fs.mkdir(plugin, { recursive: true }), fs.mkdir(userData), fs.mkdir(project)]);
  await fs.writeFile(path.join(vault, "Welcome.md"), vaultText);
  await fs.writeFile(path.join(project, "Welcome.md"), sourceText);
  await fs.writeFile(path.join(plugin, "manifest.json"), JSON.stringify({ id: "claude-threads", name: "Threads fixture", version: "1.0.0", minAppVersion: "0.1.0", author: "Test", description: "Synthetic lifecycle", isDesktopOnly: false }));
  await fs.writeFile(path.join(plugin, "main.js"), pluginCode);
  await fs.writeFile(path.join(plugin, "data.json"), settings);
  await fs.writeFile(path.join(vault, ".geode/plugins.json"), JSON.stringify(["claude-threads"]));
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));
  const launch = () => electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    const section = page.locator(".projects-section");
    await expect(section.getByRole("button", { name: "Attach folder…", exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, project);
    await section.getByRole("button", { name: "Attach folder…", exact: true }).click();
    await section.getByRole("button", { name: "First Project", exact: true }).click();
    await section.getByRole("button", { name: "Welcome.md", exact: true }).click();
    await expect(page.locator(".external-source-view code")).toHaveText(sourceText);
    const savedState = await page.evaluate(() => window.app.workspace.getLeavesOfType("geode-external-source")[0].view?.getState?.());
    expect(savedState).toMatchObject({ version: 1, ref: { relativePath: "Welcome.md" }, rootLabel: "First Project" });
    const rootId = (savedState as { ref: { rootId: string } }).ref.rootId;
    await expect.poll(() => fs.readFile(path.join(vault, ".geode/workspace.json"), "utf8").catch(() => "")).toContain(rootId);
    const registryBefore = await fs.readFile(path.join(userData, "external-roots.json"), "utf8");
    await app.close();
    app = undefined;

    // A new main process, same user data and vault. No direct contributions or
    // attachment calls: the installed fixture must reconnect through PluginManager.
    app = await launch();
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { unexpectedGrantDialogs: number };
      state.unexpectedGrantDialogs = 0;
      dialog.showOpenDialog = async () => { state.unexpectedGrantDialogs++; return { canceled: true, filePaths: [] }; };
      dialog.showMessageBox = async () => { state.unexpectedGrantDialogs++; return { response: 0, checkboxChecked: false }; };
    });
    const restoredPage = await app.firstWindow();
    await expect(restoredPage.locator(".external-source-view code")).toHaveText(sourceText);
    await expect(restoredPage.locator(".external-source-view")).toContainText("Read-only · External source");
    const restoredSection = restoredPage.locator(".projects-section");
    await expect(restoredSection).toContainText("First Project");
    await expect(restoredSection.getByRole("button", { name: "Attach folder…", exact: true })).toHaveCount(0);
    expect(await restoredPage.evaluate(() => window.app.workspace.getLeavesOfType("geode-external-source")[0].view?.getState?.())).toEqual(savedState);
    expect(await restoredPage.evaluate(async () => {
      const project = (await window.geode.externalRoots!.listProjects())[0];
      if (project.state !== "bound") throw new Error("Restored Project is not bound");
      return project.root.rootId;
    })).toBe(rootId);
    expect(await restoredPage.evaluate(() => window.app.workspace.getLeavesOfType("markdown").length)).toBe(0);
    expect(await app.evaluate(() => (globalThis as unknown as { unexpectedGrantDialogs: number }).unexpectedGrantDialogs)).toBe(0);
    expect(await fs.readFile(path.join(userData, "external-roots.json"), "utf8")).toBe(registryBefore);
    expect(await fs.readFile(path.join(plugin, "data.json"), "utf8")).toBe(settings);
    expect(await fs.readFile(path.join(project, "Welcome.md"), "utf8")).toBe(sourceText);
    expect(await fs.readFile(path.join(vault, "Welcome.md"), "utf8")).toBe(vaultText);
  } finally {
    await app?.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("real PluginManager bridges Threads manager lifecycle without attaching automatically", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-threads-projects-"));
  const userData = path.join(base, "userdata");
  const vault = path.join(base, "vault");
  const project = path.join(base, "project");
  const plugin = path.join(vault, ".geode/plugins/claude-threads");
  await Promise.all([fs.mkdir(plugin, { recursive: true }), fs.mkdir(userData), fs.mkdir(project)]);
  await fs.writeFile(path.join(vault, "Welcome.md"), "Vault only");
  await fs.writeFile(path.join(project, "project.txt"), "External project source");
  await fs.writeFile(path.join(plugin, "manifest.json"), JSON.stringify({ id: "claude-threads", name: "Threads fixture", version: "1.0.0", minAppVersion: "0.1.0", author: "Test", description: "Synthetic lifecycle", isDesktopOnly: false }));
  await fs.writeFile(path.join(plugin, "main.js"), pluginCode);
  await fs.writeFile(path.join(plugin, "data.json"), JSON.stringify({ projects: [{ id: "first", name: "First Project", vaultFolder: "", cwdOverride: project }] }));
  await fs.writeFile(path.join(vault, ".geode/plugins.json"), JSON.stringify(["claude-threads"]));
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    const section = page.locator(".projects-section");
    await expect(section).toContainText("First Project");
    await expect(section.getByRole("button", { name: "Attach folder…" })).toHaveCount(1);
    expect(await fs.readFile(path.join(userData, "external-roots.json"), "utf8").catch(() => null)).toBeNull();
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, project);
    await section.getByRole("button", { name: "Attach folder…", exact: true }).click();
    await section.getByRole("button", { name: "First Project", exact: true }).click();
    await section.getByRole("button", { name: "project.txt", exact: true }).click();
    const source = page.locator(".external-source-view");
    await expect(source.locator("code")).toHaveText("External project source");
    const rootId = await page.evaluate(async () => {
      const project = (await window.geode.externalRoots!.listProjects())[0];
      if (project.state !== "bound") throw new Error("Not bound");
      return project.root.rootId;
    });
    for (const [kind, expected] of [["create", "Second Project"], ["rename", "Renamed Project"], ["cwd", "Working directory changed"]]) {
      await page.evaluate(kind => {
        const plugin = window.app.pluginManager.getPlugin("claude-threads") as unknown as { change(kind: string): void };
        plugin.change(kind);
      }, kind);
      await expect(section).toContainText(expected);
    }
    await expect(source.locator("code")).toHaveCount(0);
    expect(await page.evaluate(async rootId => {
      try { await window.geode.externalRoots!.readText({ rootId, relativePath: "project.txt" }); return "unexpected access"; }
      catch { return "denied"; }
    }, rootId)).toBe("denied");
    await page.evaluate(() => (window.app.pluginManager.getPlugin("claude-threads") as unknown as { change(kind: string): void }).change("delete"));
    await expect(section).toBeHidden();
    expect(await page.evaluate(async rootId => {
      const root = (await window.geode.externalRoots!.listGrants!()).find(grant => grant.root.rootId === rootId);
      return { retained: !!root, associations: root?.associations.length };
    }, rootId)).toEqual({ retained: true, associations: 0 });
    await page.evaluate(() => window.app.pluginManager.disable("claude-threads"));
    await page.evaluate(() => window.app.pluginManager.enable("claude-threads"));
    await expect(section).toContainText("First Project");
    await page.evaluate(() => window.app.pluginManager.disable("claude-threads"));
    await expect(section).toBeHidden();
    // Simulate uninstall's existing disable-then-rescan path in this fixture only.
    await fs.rename(plugin, path.join(base, "removed-plugin"));
    await page.evaluate(() => window.app.pluginManager.rescan());
    await expect(section).toBeHidden();
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
