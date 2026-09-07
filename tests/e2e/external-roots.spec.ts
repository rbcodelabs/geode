import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-external-roots-e2e-"));
  const userData = path.join(base, "user-data");
  const vault = path.join(base, "vault");
  const otherVault = path.join(base, "other-vault");
  const project = path.join(base, "project");
  await Promise.all([userData, vault, otherVault, project].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(vault, "Welcome.md"), "# Vault note\n");
  await fs.writeFile(path.join(project, "external-only.md"), "# External source\n[[Not a vault link]]\n");
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
  return { app, window, base, project, otherVault, userData, vault };
}

test("external root IPC requires an explicit grant and stays separate from vault files and guest contents", async () => {
  const s = await fixture();
  try {
    await s.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, s.project);
    const result = await s.window.evaluate(async (suggestedPath) => {
      const roots = window.geode.externalRoots!;
      const before = await roots.contribute([{ projectId: "project-a", label: "Test Project", suggestedPath }]);
      const attached = await roots.attach("project-a");
      if (attached?.state !== "bound") throw new Error("Expected attached project");
      const page = await roots.listDirectory({ rootId: attached.root.rootId, relativePath: "" });
      const text = await roots.readText({ rootId: attached.root.rootId, relativePath: "external-only.md" });
      return { before, attached, page, text, vaultPaths: window.app.vault.getFiles().map((file) => file.path) };
    }, s.project);
    expect(result.before).toEqual([{ projectId: "project-a", label: "Test Project", state: "unbound" }]);
    expect(result.text).toBe("# External source\n[[Not a vault link]]\n");
    expect(result.page.entries.map((entry) => entry.name)).toEqual(["external-only.md"]);
    expect(result.vaultPaths).not.toContain("external-only.md");
    expect(JSON.stringify(result.attached)).not.toContain(s.project);

    const guestResult = await s.app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const guest = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
      win.contentView.addChildView(guest);
      try {
        await guest.webContents.loadURL("about:blank");
        return await guest.webContents.executeJavaScript('require("electron").ipcRenderer.invoke("external-roots-projects")');
      } finally {
        win.contentView.removeChildView(guest);
        guest.webContents.close();
      }
    });
    expect(guestResult).toEqual({ ok: false, error: "unavailable" });
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

test("a native attachment picker cannot commit after the originating vault switches", async () => {
  const s = await fixture();
  try {
    await s.app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () => new Promise((resolve) => {
        (globalThis as unknown as { resolveRootPicker: typeof resolve }).resolveRootPicker = resolve;
      });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await s.window.evaluate(async () => {
      await window.geode.externalRoots!.contribute([{ projectId: "project-a", label: "Test Project" }]);
      (window as unknown as { pendingAttachment: Promise<string> }).pendingAttachment = window.geode.externalRoots!.attach("project-a")
        .then(() => "unexpected success", (error: Error) => error.message);
    });
    await expect.poll(() => s.app.evaluate(() => typeof (globalThis as unknown as { resolveRootPicker?: unknown }).resolveRootPicker)).toBe("function");
    await s.window.evaluate((vault) => window.geode.openVault(vault), s.otherVault);
    await s.app.evaluate((_electron, selectedPath) => {
      (globalThis as unknown as { resolveRootPicker: (value: { canceled: boolean; filePaths: string[] }) => void })
        .resolveRootPicker({ canceled: false, filePaths: [selectedPath] });
    }, s.project);
    const outcome = await s.window.evaluate(() => (window as unknown as { pendingAttachment: Promise<string> }).pendingAttachment);
    expect(outcome).toContain("root-unavailable");
    expect(await fs.readFile(path.join(s.userData, "external-roots.json"), "utf8").catch(() => null)).toBeNull();
    expect(await s.window.evaluate(() => window.geode.externalRoots!.listProjects())).toEqual([]);
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

test("Projects explorer attaches and opens literal read-only source without vault participation", async ({}, testInfo) => {
  const s = await fixture();
  try {
    await s.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, s.project);
    await s.window.evaluate(async suggestedPath => {
      await window.geode.externalRoots!.contribute([{ projectId: "project-a", label: "Test Project", suggestedPath }]);
    }, s.project);
    const section = s.window.locator(".projects-section");
    await expect(section.getByRole("button", { name: "Attach folder…", exact: true })).toBeVisible();
    await section.getByRole("button", { name: "Attach folder…", exact: true }).click();
    await section.getByRole("button", { name: "Test Project", exact: true }).click();
    await section.getByRole("button", { name: "external-only.md", exact: true }).click();
    const source = s.window.locator(".external-source-view");
    await expect(source.locator("code")).toHaveText("# External source\n[[Not a vault link]]\n");
    await expect(source).toContainText("Read-only");
    await expect(source.locator(".cm-editor, textarea, a, [contenteditable=true]")).toHaveCount(0);
    expect(await s.window.evaluate(() => window.app.vault.getFiles().map(file => file.path))).not.toContain("external-only.md");
    await fs.writeFile(path.join(s.project, "external-only.md"), '<script>window.externalExecuted=true</script>\n# Updated source');
    await source.getByRole("button", { name: "Refresh external source" }).click();
    await expect(source.locator("code")).toContainText("<script>");
    expect(await s.window.evaluate(() => (window as unknown as { externalExecuted?: boolean }).externalExecuted)).toBeUndefined();
    await expect(source.locator("script")).toHaveCount(0);
    await s.window.screenshot({ path: testInfo.outputPath("external-project-source.png") });
    await s.window.setViewportSize({ width: 900, height: 700 });
    await s.window.screenshot({ path: testInfo.outputPath("external-project-source-narrow.png") });
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

test("shared Project roots reconnect one tree and invalidate removed contributions", async () => {
  const s = await fixture();
  try {
    const child = path.join(s.project, "child");
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, "nested.txt"), "Nested source");
    await s.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, s.project);
    const rootId = await s.window.evaluate(async suggestedPath => {
      const host = window.geode.externalRoots!;
      await host.contribute([{ projectId: "a", label: "Main", suggestedPath }, { projectId: "b", label: "Child", suggestedPath: `${suggestedPath}/child` }]);
      const root = await host.attach("a");
      if (root?.state !== "bound") throw new Error("Not bound");
      return root.root.rootId;
    }, s.project);
    await s.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, child);
    await s.window.evaluate(() => window.geode.externalRoots!.attach("b"));
    const section = s.window.locator(".projects-section");
    await expect(section.locator(".projects-root")).toHaveCount(1);
    await expect(section.locator(".projects-root-alias")).toContainText(["Main", "Child"]);
    await section.getByRole("button", { name: "Main · Child", exact: true }).click();
    await section.getByRole("button", { name: "external-only.md", exact: true }).click();
    const source = s.window.locator(".external-source-view");
    await expect(source.locator("code")).toContainText("External source");
    const moved = path.join(s.base, "moved-project");
    await fs.rename(s.project, moved);
    await fs.writeFile(path.join(moved, "external-only.md"), "Reconnected source");
    await section.getByRole("button", { name: "Refresh Projects", exact: true }).click();
    await expect(section).toContainText("Folder missing");
    await s.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, moved);
    await section.getByRole("button", { name: "Reconnect…", exact: true }).first().click();
    await expect(source.locator("code")).toHaveText("Reconnected source");
    expect(await s.window.evaluate(() => window.app.workspace.getLeavesOfType("geode-external-source")[0].view?.getState?.())).toMatchObject({ ref: { rootId, relativePath: "external-only.md" } });
    await s.window.evaluate(() => window.geode.externalRoots!.contribute([]));
    await expect(section).toBeHidden();
    await expect(source.locator("code")).toHaveCount(0);
    await expect(source).toContainText("unavailable");
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});

test("unknown external tab identity survives reload without resolving the same vault filename", async () => {
  const s = await fixture();
  try {
    const state = { version: 1, ref: { rootId: "815b7178-17b2-458c-a7a2-19acd1fdd87c", relativePath: "Welcome.md" }, rootLabel: "Missing Project" };
    await s.window.evaluate(async saved => {
      const leaf = window.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: "geode-external-source", state: saved, active: true });
    }, state);
    await expect(s.window.locator(".external-source-view")).toContainText("unavailable");
    await expect.poll(() => fs.readFile(path.join(s.vault, ".geode", "workspace.json"), "utf8").catch(() => "")).toContain(state.ref.rootId);
    await s.window.reload();
    await expect(s.window.locator(".external-source-view")).toContainText("Missing Project");
    await expect(s.window.locator(".external-source-view code")).toHaveCount(0);
    expect(await s.window.evaluate(() => window.app.workspace.getLeavesOfType("geode-external-source")[0].view?.getState?.())).toEqual(state);
    await expect(s.window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
  } finally {
    await s.app.close();
    await fs.rm(s.base, { recursive: true, force: true });
  }
});
