import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const THREAD_HISTORY_PROBE_MANIFEST = {
  id: "thread-history-probe",
  name: "Thread History Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Models a stateful Agent Threads main-pane view.",
  author: "geode",
};

const THREAD_HISTORY_PROBE_MAIN = `
  const obsidian = require('obsidian');
  const VIEW = 'thread-history-probe';

  class ThreadHistoryProbeView extends obsidian.ItemView {
    state = {};
    getViewType() { return VIEW; }
    getDisplayText() { return 'Agent Threads'; }
    getState() { return this.state; }
    async setState(state) {
      this.state = state || {};
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'thread-history-probe-body', text: this.state.threadId || 'no thread' });
    }
  }

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      this.registerView(VIEW, (leaf) => new ThreadHistoryProbeView(leaf));
    }
  };
`;

function makeVault(options: { withThreadHistoryProbe?: boolean } = {}) {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-actions-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-actions-ud-"));
  for (const name of ["A.md", "B.md", "C.md", "D.md"]) fs.writeFileSync(path.join(vaultDir, name), `# ${name}\n`);
  fs.writeFileSync(path.join(vaultDir, "Board.canvas"), JSON.stringify({ nodes: [], edges: [] }));
  fs.writeFileSync(path.join(vaultDir, "Board 2.canvas"), JSON.stringify({ nodes: [], edges: [] }));
  fs.writeFileSync(path.join(vaultDir, "Data.base"), "filters:\n  and: []\nviews:\n  - type: table\n    name: Table\n");
  fs.writeFileSync(path.join(vaultDir, "Data 2.base"), "filters:\n  and: []\nviews:\n  - type: table\n    name: Table\n");
  if (options.withThreadHistoryProbe) {
    const pluginDir = path.join(vaultDir, ".geode", "plugins", THREAD_HISTORY_PROBE_MANIFEST.id);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(THREAD_HISTORY_PROBE_MANIFEST));
    fs.writeFileSync(path.join(pluginDir, "main.js"), THREAD_HISTORY_PROBE_MAIN);
    fs.writeFileSync(
      path.join(vaultDir, ".geode", "plugins.json"),
      JSON.stringify([THREAD_HISTORY_PROBE_MANIFEST.id]),
    );
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  return { vaultDir, userDataDir };
}

test("a file picked from a stateful plugin view can navigate back to that view", async () => {
  const { vaultDir, userDataDir } = makeVault({ withThreadHistoryProbe: true });
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    // Explorer rows appear before plugin loading and workspace restoration
    // finish. Do not race either phase when creating the probe's history.
    await win.waitForFunction(() => (window as any).app?.workspace?.layoutReady
      && (window as any).app.workspace.getViewFactory("thread-history-probe"));
    await win.evaluate(async () => {
      const geode = (window as any).app;
      const leaf = geode.workspace.getLeaf(false);
      await leaf.setViewState({
        type: "thread-history-probe",
        active: true,
        state: { threadId: "thread-42" },
      });
      await geode.openFile(geode.vault.getFileByPath("A.md"), false);
    });

    const active = win.locator(".workspace-leaf.mod-active");
    const back = active.getByRole("button", { name: "Navigate back" });
    await expect(active.locator(".view-header-title")).toHaveText("A");
    await expect(back).toHaveAttribute("aria-disabled", "false");
    await back.click();
    await expect(active.locator(".view-header-title")).toHaveText("Agent Threads");
    await expect(active.locator(".thread-history-probe-body")).toHaveText("thread-42");
    if (screenshotDir) {
      await win.screenshot({ path: path.join(screenshotDir, "agent-threads-restored-after-picked-file.png") });
    }
    const forward = active.getByRole("button", { name: "Navigate forward" });
    await expect(forward).toHaveAttribute("aria-disabled", "false");
    await forward.click();
    await expect(active.locator(".view-header-title")).toHaveText("A");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("same-type document navigation preserves view identity and lifecycle", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    const result = await win.evaluate(async () => {
      const a = (window as any).app;
      const cases = [
        ["A.md", "B.md"],
        ["Board.canvas", "Board 2.canvas"],
        ["Data.base", "Data 2.base"],
      ];
      const results = [];
      for (const [firstPath, secondPath] of cases) {
        await a.openFile(a.vault.getFileByPath(firstPath), true);
        const leaf = a.workspace.getActiveLeaf();
        const originalView = leaf.view;
        let opens = 0;
        let closes = 0;
        const originalOpen = originalView.onOpen.bind(originalView);
        const originalClose = originalView.onClose.bind(originalView);
        originalView.onOpen = async () => { opens += 1; await originalOpen(); };
        originalView.onClose = async () => { closes += 1; await originalClose(); };
        await a.openFile(a.vault.getFileByPath(secondPath), false);
        results.push({ same: leaf.view === originalView, opens, closes, path: leaf.view.getFile().path });
      }
      return results;
    });
    expect(result).toEqual([
      { same: true, opens: 0, closes: 0, path: "B.md" },
      { same: true, opens: 0, closes: 0, path: "Board 2.canvas" },
      { same: true, opens: 0, closes: 0, path: "Data 2.base" },
    ]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("document tabs keep independent navigation with working back and forward controls", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    const leafIds = await win.evaluate(async () => {
      const a = (window as any).app;
      for (const path of ["A.md", "Board.canvas", "Data.base"]) await a.openFile(a.vault.getFileByPath(path), false);
      const first = a.workspace.getActiveLeaf();
      await a.openFile(a.vault.getFileByPath("B.md"), true);
      await a.openFile(a.vault.getFileByPath("D.md"), false);
      return { first: first.id, second: a.workspace.getActiveLeaf().id };
    });

    const active = win.locator(".workspace-leaf.mod-active");
    const back = active.getByRole("button", { name: "Navigate back" });
    const forward = active.getByRole("button", { name: "Navigate forward" });
    await expect(back).toHaveAttribute("aria-disabled", "false");
    await expect(forward).toHaveAttribute("aria-disabled", "true");
    await back.focus();
    await back.press("Enter");
    await expect(active.locator(".view-header-title")).toHaveText("B");
    await expect(forward).toHaveAttribute("aria-disabled", "false");

    await win.evaluate((id) => {
      const a = (window as any).app;
      const leaf = a.workspace.activeGroup.leaves.find((candidate: any) => candidate.id === id);
      leaf.group.setActiveLeaf(leaf);
    }, leafIds.first);
    await expect(active.locator(".view-header-title")).toHaveText("Data");
    await active.getByRole("button", { name: "Navigate back" }).click();
    await expect(active.locator(".view-header-title")).toHaveText("Board");
    await active.getByRole("button", { name: "Navigate back" }).click();
    await expect(active.locator(".view-header-title")).toHaveText("A");
    await active.getByRole("button", { name: "Navigate forward" }).click();
    await expect(active.locator(".view-header-title")).toHaveText("Board");

    await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("C.md"), false);
    });
    await expect(active.getByRole("button", { name: "Navigate forward" })).toHaveAttribute("aria-disabled", "true");

    await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("D.md"), false);
      await a.vault.trash(a.vault.getFileByPath("C.md"));
    });
    await active.getByRole("button", { name: "Navigate back" }).click();
    await expect(active.locator(".view-header-title")).toHaveText("Board");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("document navigation serializes races and leaves the mounted file unchanged after a read failure", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("A.md"), false);
      const originalRead = a.vault.read.bind(a.vault);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      a.vault.read = async (file: any) => {
        if (file.path === "B.md") await gate;
        return originalRead(file);
      };
      const first = a.openFile(a.vault.getFileByPath("B.md"), false);
      const second = a.openFile(a.vault.getFileByPath("C.md"), false);
      a.__releaseDocumentNavigation = release;
      a.__documentNavigationRace = Promise.all([first, second]);
      a.__restoreDocumentRead = () => { a.vault.read = originalRead; };
    });
    const active = win.locator(".workspace-leaf.mod-active");
    await expect(active.locator(".view-header-title")).toHaveText("A");
    await win.evaluate(async () => {
      const a = (window as any).app;
      a.__releaseDocumentNavigation();
      await a.__documentNavigationRace;
    });
    await expect(active.locator(".view-header-title")).toHaveText("C");
    await active.getByRole("button", { name: "Navigate back" }).click();
    await expect(active.locator(".view-header-title")).toHaveText("B");

    await win.evaluate(() => {
      const a = (window as any).app;
      a.__restoreDocumentRead();
      const originalRead = a.vault.read.bind(a.vault);
      a.vault.read = async (file: any) => {
        if (file.path === "A.md") throw new Error("deterministic read failure");
        return originalRead(file);
      };
    });
    await active.getByRole("button", { name: "Navigate back" }).click();
    await expect(win.locator(".notice", { hasText: "Could not navigate: deterministic read failure" })).toBeVisible();
    await expect(active.locator(".view-header-title")).toHaveText("B");
    await expect(active.getByRole("button", { name: "Navigate back" })).toHaveAttribute("aria-disabled", "false");
    await expect(active.getByRole("button", { name: "Navigate forward" })).toHaveAttribute("aria-disabled", "false");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

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
    await expect(win.locator(".menu-item")).toHaveText(["Open in new tab", "Bookmark", "Rename…", "Reveal in Finder", "Delete"]);
    await win.keyboard.press("Escape");

    const tab = win.locator(".workspace-split.mod-root .workspace-tab-header", { hasText: "Named from title" });
    await tab.click({ button: "right" });
    await expect(win.locator(".menu-item-title")).toHaveText([
      "Open in new tab", "Bookmark", "Rename…", "Reveal in Finder", "Delete", "Add tab to new collection", "Pin", "Close", "Close others", "Close tabs to the right",
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
