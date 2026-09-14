/**
 * The file-backed sidebar panels (Comments, Backlinks, Outline) must follow the
 * active pane. They used to cache their subject from the `file-open` payload,
 * which is emitted only when the newly active leaf's view answers `getFile()`
 * — so activating a fileless web view stranded the previous note's content on
 * screen.
 *
 * Two distinct workspace paths produce a web view in the active pane, and they
 * emit different events, so both are exercised here:
 *
 *   - swapping the view inside the current leaf (WorkspaceLeaf.setView, what an
 *     explorer click on an HTML file does) emits only `layout-change`;
 *   - activating a separate web-view tab (TabGroup.setActiveLeaf) emits
 *     `active-leaf-change` and no `file-open`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const BLANK = "No file is open.";

/** Sidebar tab id -> text the panel shows when Note.md is the active file. */
const PANELS = [
  { type: "outline", populated: "Alpha heading" },
  { type: "backlinks", populated: "Linked mentions" },
  // Note.md carries no comment markers, so the populated state is the
  // "no comments" message — still distinct from the no-file state.
  { type: "comments", populated: "No comments in this note." },
] as const;

async function launch() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sidebar-active-leaf-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sidebar-active-leaf-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Alpha heading\n\nbody\n");
  fs.writeFileSync(path.join(vaultDir, "Linker.md"), "# Linker\n\nSee [[Note]].\n");
  fs.writeFileSync(path.join(vaultDir, "Page.html"), "<html><body><h1>Hi</h1></body></html>\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);

  const cleanup = async () => {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, cleanup };
}

function panelBody(window: Page) {
  return window.locator(".workspace-sidebar.mod-right .sidebar-view-body");
}

async function showPanel(window: Page, type: string) {
  await window.locator(`.workspace-sidebar.mod-right [data-type="${type}"]`).click();
}

async function openInExplorer(window: Page, filePath: string) {
  await window.locator(`.nav-file-title[data-path="${filePath}"]`).click();
}

test("every file-backed panel blanks when the active pane swaps to a web view in place, and restores on return", async () => {
  const { window, cleanup } = await launch();
  try {
    for (const { type, populated } of PANELS) {
      await showPanel(window, type);
      await openInExplorer(window, "Note.md");
      await expect(panelBody(window)).toContainText(populated);

      // Explorer click on an HTML file reuses the active leaf: the markdown
      // view is replaced by a fileless web view without changing tabs.
      await openInExplorer(window, "Page.html");
      await expect(window.locator(".web-view")).toBeVisible();
      await expect(panelBody(window), `${type} must blank for a fileless web view`).toContainText(BLANK);
      await expect(panelBody(window)).not.toContainText(populated);

      await openInExplorer(window, "Note.md");
      await expect(panelBody(window), `${type} must restore when a note becomes active again`).toContainText(populated);
    }
  } finally {
    await cleanup();
  }
});

test("every file-backed panel blanks when a separate web-view tab is activated, and survives sidebar focus", async () => {
  const { window, cleanup } = await launch();
  try {
    await openInExplorer(window, "Note.md");
    await window.evaluate(async () => {
      const geode = (window as any).app;
      await geode.openFile(geode.vault.getAbstractFileByPath("Page.html"), true);
    });
    await expect(window.locator(".web-view")).toBeVisible();

    const tabs = window.locator(".workspace-split.mod-root .workspace-tab-header");
    await expect(tabs).toHaveCount(2);
    const noteTab = tabs.nth(0);
    const webTab = tabs.nth(1);

    for (const { type, populated } of PANELS) {
      await showPanel(window, type);
      await noteTab.click();
      await expect(panelBody(window)).toContainText(populated);

      await webTab.click();
      await expect(panelBody(window), `${type} must blank when a web-view tab is activated`).toContainText(BLANK);
      await expect(panelBody(window)).not.toContainText(populated);

      await noteTab.click();
      await expect(panelBody(window)).toContainText(populated);

      // Focusing a sidebar leaf never reassigns the workspace's active group,
      // so clicking inside the panel must not blank the panel's own content.
      await panelBody(window).click();
      await expect(panelBody(window), `${type} must survive being clicked into`).toContainText(populated);
    }
  } finally {
    await cleanup();
  }
});
