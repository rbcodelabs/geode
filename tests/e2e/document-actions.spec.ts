import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function makeVault() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-actions-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-actions-ud-"));
  for (const name of ["A.md", "B.md", "C.md", "D.md"]) fs.writeFileSync(path.join(vaultDir, name), `# ${name}\n`);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  return { vaultDir, userDataDir };
}

test("new note selects Untitled for immediate rename and exposes shared document menus", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    await win.evaluate(() => (window as any).app.commands.execute("new-note"));
    const title = win.locator(".workspace-leaf.mod-active .view-header-title");
    await expect(title).toHaveText("Untitled");
    expect(await win.evaluate(() => ({
      active: (document.activeElement as HTMLElement | null)?.classList.contains("view-header-title"),
      selected: window.getSelection()?.toString(),
    }))).toEqual({ active: true, selected: "Untitled" });
    if (screenshotDir) await win.screenshot({ path: path.join(screenshotDir, "document-actions-untitled-selected.png") });
    await title.fill("Named from title");
    await title.press("Enter");
    await expect.poll(() => fs.existsSync(path.join(vaultDir, "Named from title.md"))).toBe(true);
    await title.fill("  Named from title  ");
    await title.press("Enter");
    await expect(title).toHaveText("Named from title");
    expect(await title.textContent()).toBe("Named from title");
    await title.fill("");
    await title.press("Enter");
    await expect(title).toHaveText("Named from title");
    await title.fill("A");
    await title.press("Enter");
    await expect(title).toHaveText("Named from title");
    await expect(win.locator(".notice", { hasText: 'A file named "A" already exists' })).toBeVisible();

    await win.getByRole("button", { name: "More options" }).click();
    await expect(win.locator(".menu-item")).toHaveText(["Open in new tab", "Bookmark", "Rename…", "Delete"]);
    await win.keyboard.press("Escape");

    const tab = win.locator(".workspace-split.mod-root .workspace-tab-header", { hasText: "Named from title" });
    await tab.click({ button: "right" });
    await expect(win.locator(".menu-item-title")).toHaveText([
      "Open in new tab", "Bookmark", "Rename…", "Delete", "Add tab to new collection", "Pin", "Close", "Close others", "Close tabs to the right",
    ]);
    if (screenshotDir) await win.screenshot({ path: path.join(screenshotDir, "document-actions-tab-context-menu.png") });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Markdown More options supplies the exact duplicate-open view leaf", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    const expectedLeafId = await win.evaluate(async () => {
      const a = (window as any).app;
      const file = a.vault.getFileByPath("A.md");
      await a.openFile(file, true);
      await a.openFile(file, true);
      const active = a.workspace.getActiveLeaf();
      const original = a.showDocumentMenu.bind(a);
      a.showDocumentMenu = (_event: MouseEvent, leaf: any) => {
        a.__capturedMoreLeafId = leaf.id;
      };
      a.__restoreShowDocumentMenu = () => { a.showDocumentMenu = original; };
      return active.id;
    });
    await win.locator(".workspace-leaf.mod-active").getByRole("button", { name: "More options" }).click();
    expect(await win.evaluate(() => (window as any).app.__capturedMoreLeafId)).toBe(expectedLeafId);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("background tab bulk close stays in its group and preserves pinned siblings", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    await win.evaluate(async () => {
      const a = (window as any).app;
      for (const name of ["A.md", "B.md", "C.md", "D.md"]) await a.openFile(a.vault.getFileByPath(name), true);
      const group = a.workspace.activeGroup;
      group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "B.md").setPinned(true);
      group.setActiveLeaf(group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "D.md"));
    });
    const root = win.locator(".workspace-split.mod-root");
    const cTab = root.locator('.workspace-tab-header[aria-label="C"]');
    await cTab.click({ button: "right" });
    await win.locator(".menu-item", { hasText: /^Close others$/ }).click();
    await expect(root.locator('.workspace-tab-header[aria-label="B"]')).toHaveClass(/mod-pinned/);
    await expect(root.locator('.workspace-tab-header[aria-label="C"]')).toBeVisible();
    await expect(root.locator('.workspace-tab-header[aria-label="A"]')).toHaveCount(0);
    await expect(root.locator('.workspace-tab-header[aria-label="D"]')).toHaveCount(0);
    if (screenshotDir) await win.screenshot({ path: path.join(screenshotDir, "document-actions-close-others-result.png") });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
