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
  return { app, window, base, project, otherVault, userData };
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
