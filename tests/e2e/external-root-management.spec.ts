import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-root-management-e2e-"));
  const userData = path.join(base, "user-data"); const vault = path.join(base, "vault");
  const otherVault = path.join(base, "other-vault"); const project = path.join(base, "project");
  await Promise.all([userData, vault, otherVault, project].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(vault, "Welcome.md"), "# Vault");
  await fs.writeFile(path.join(otherVault, "Other.md"), "# Other");
  await fs.writeFile(path.join(project, "source.txt"), "Original source");
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, project);
  const rootId = await window.evaluate(async (suggestedPath) => {
    const roots = window.geode.externalRoots!;
    await roots.contribute([{ projectId: "project", label: "Managed project", suggestedPath }]);
    const result = await roots.attach("project"); if (result?.state !== "bound") throw new Error("Expected bound project");
    return result.root.rootId;
  }, project);
  return { base, userData, vault, otherVault, project, rootId, app, window };
}

test("core Project folders settings retains disabled Project associations and removes only confirmed orphan grants", async ({}, testInfo) => {
  const s = await fixture();
  try {
    await s.window.evaluate(() => window.app.setting.openTabById("project-folders"));
    const settings = s.window.locator(".modal.mod-settings");
    await expect(settings.getByRole("heading", { name: "Project folders", exact: true })).toBeVisible();
    await expect(settings).toContainText("Active — detach from Projects");
    await expect(settings.getByRole("button", { name: /Remove association/ })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: /Remove folder grant/ })).toHaveCount(0);
    await s.window.evaluate(() => window.geode.externalRoots!.contribute([]));
    const removeAssociation = settings.getByRole("button", { name: "Remove association for Managed project", exact: true });
    await expect(removeAssociation).toBeVisible();
    await s.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await removeAssociation.click();
    await expect(settings).toContainText("Cancelled. Nothing was removed.");
    await expect(removeAssociation).toBeVisible();
    await s.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await removeAssociation.click();
    await expect(settings).toContainText("Unassigned folder");
    await s.window.screenshot({ path: testInfo.outputPath("project-folder-management.png") });
    await settings.getByRole("button", { name: `Remove folder grant ${s.rootId.slice(0, 8)}`, exact: true }).click();
    await expect(settings).toContainText("No folder grants to manage.");
    expect(await fs.readFile(path.join(s.project, "source.txt"), "utf8")).toBe("Original source");
    const persisted = JSON.parse(await fs.readFile(path.join(s.userData, "external-roots.json"), "utf8"));
    expect(persisted.roots).toEqual([]); expect(persisted.bindings).toEqual([]);
  } finally { await s.app.close(); await fs.rm(s.base, { recursive: true, force: true }); }
});

test("pending management confirmation cannot remove an association after its vault session switches", async () => {
  const s = await fixture();
  try {
    await s.window.evaluate(() => window.geode.externalRoots!.contribute([]));
    await s.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = () => new Promise((resolve) => {
        (globalThis as unknown as { resolveManagement: typeof resolve }).resolveManagement = resolve;
      });
    });
    await s.window.evaluate(() => {
      (window as unknown as { pendingManagement: Promise<boolean> }).pendingManagement = window.geode.externalRoots!.removeStaleAssociation!("project").then(() => true, () => false);
    });
    await expect.poll(() => s.app.evaluate(() => typeof (globalThis as unknown as { resolveManagement?: unknown }).resolveManagement)).toBe("function");
    await s.window.evaluate((vault) => window.geode.openVault(vault), s.otherVault);
    await s.app.evaluate(() => {
      (globalThis as unknown as { resolveManagement: (result: { response: number; checkboxChecked: boolean }) => void }).resolveManagement({ response: 1, checkboxChecked: false });
    });
    expect(await s.window.evaluate(() => (window as unknown as { pendingManagement: Promise<boolean> }).pendingManagement)).toBe(false);
    const persisted = JSON.parse(await fs.readFile(path.join(s.userData, "external-roots.json"), "utf8"));
    expect(persisted.bindings).toHaveLength(1); expect(persisted.roots).toHaveLength(1);
  } finally { await s.app.close(); await fs.rm(s.base, { recursive: true, force: true }); }
});

test("shared vault windows refresh source and tree on reconnect, detach, and grant removal", async () => {
  const s = await fixture();
  try {
    // The primary window has no pinned launch target, so switching it exercises
    // the ordinary lifecycle while the second window remains pinned to Other.
    await s.window.evaluate(() => window.geode.externalRoots!.detach("project"));
    const pagePromise = s.app.waitForEvent("window");
    await s.window.evaluate((vault) => window.geode.openVaultWindow(vault), s.otherVault);
    const second = await pagePromise;
    await expect(second.locator('.nav-file-title[data-path="Other.md"]')).toBeVisible();
    await s.window.evaluate((vault) => window.app.switchVaultInWindow(vault), s.otherVault);
    await expect(s.window.locator('.nav-file-title[data-path="Other.md"]')).toBeVisible();
    await s.window.evaluate(async (suggestedPath) => {
      await window.geode.externalRoots!.contribute([{ projectId: "project", label: "Managed project", suggestedPath }]);
      await window.geode.externalRoots!.attach("project");
    }, s.project);
    await second.evaluate((suggestedPath) => window.geode.externalRoots!.contribute([{ projectId: "project", label: "Managed project", suggestedPath }]), s.project);
    for (const page of [s.window, second]) {
      await page.evaluate(async (rootId) => {
        await window.app.workspace.getLeaf(true).setViewState({ type: "geode-external-source", active: true,
          state: { version: 1, ref: { rootId, relativePath: "source.txt" }, rootLabel: "Managed project" } });
      }, s.rootId);
      await expect(page.locator(".external-source-view code")).toHaveText("Original source");
      await expect(page.locator(".projects-section .projects-root")).toHaveCount(1);
    }
    await s.window.evaluate(() => window.geode.externalRoots!.contribute([]));
    await s.window.evaluate(() => window.app.setting.openTabById("project-folders"));
    const settings = s.window.locator(".modal.mod-settings");
    await expect(settings).toContainText("Active — detach from Projects");
    await expect(settings.getByRole("button", { name: /Remove association/ })).toHaveCount(0);
    await s.window.evaluate(() => window.app.setting.close());
    await s.window.evaluate((suggestedPath) => window.geode.externalRoots!.contribute([{ projectId: "project", label: "Managed project", suggestedPath }]), s.project);
    const moved = path.join(s.base, "moved-project"); await fs.rename(s.project, moved);
    await fs.writeFile(path.join(moved, "source.txt"), "Reconnected source");
    await s.app.evaluate(({ dialog }, selectedPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] }); }, moved);
    await s.window.evaluate(() => window.geode.externalRoots!.reconnect("project"));
    for (const page of [s.window, second]) await expect(page.locator(".external-source-view code")).toHaveText("Reconnected source");
    await s.window.evaluate(() => window.geode.externalRoots!.detach("project"));
    for (const page of [s.window, second]) {
      await expect(page.locator(".external-source-view code")).toHaveCount(0);
      await expect(page.locator(".external-source-view")).toContainText("unavailable");
      await expect(page.locator(".projects-section").getByRole("button", { name: "Attach folder…", exact: true })).toBeVisible();
    }
    await s.window.evaluate((rootId) => window.geode.externalRoots!.removeOrphanGrant!(rootId), s.rootId);
    expect(await second.evaluate(() => window.geode.externalRoots!.listGrants!())).toEqual([]);
  } finally { await s.app.close(); await fs.rm(s.base, { recursive: true, force: true }); }
});
