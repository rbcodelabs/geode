import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "pane-probe",
  name: "Pane Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Registers a dockable view for persistence/DnD tests.",
  author: "geode",
};

// A minimal plugin that registers one view type used to test docking + restore.
const MAIN_JS = `
  const obsidian = require('obsidian');
  const VIEW = 'probe-pane';
  class ProbeView extends obsidian.ItemView {
    getViewType() { return VIEW; }
    getDisplayText() { return 'Probe Pane'; }
    getIcon() { return '★'; }
    async onOpen() { this.contentEl.createEl('div', { cls: 'probe-pane-body', text: 'probe-pane-ok' }); }
  }
  module.exports.default = class extends obsidian.Plugin {
    async onload() { this.registerView(VIEW, (leaf) => new ProbeView(leaf)); }
  };
`;

function makeVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-persist-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-persist-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\n");
  fs.writeFileSync(path.join(vaultDir, "Beta.md"), "# Beta\n");
  const pd = path.join(vaultDir, ".geode", "plugins", "pane-probe");
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, "manifest.json"), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(pd, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(pd, "styles.css"), ".probe-pane-body{padding:6px}");
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["pane-probe"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
}

test("persists workspace layout (tabs + docked plugin pane) across a relaunch", async () => {
  const { vaultDir, userDataDir } = makeVault();
  try {
    // First launch: open two markdown tabs and dock the plugin pane on the right.
    let app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Alpha.md"), true);
      await a.openFile(a.vault.getFileByPath("Beta.md"), true);
      const leaf = a.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "probe-pane", active: true });
      a.workspace.revealLeaf(leaf);
    });
    // Two markdown tabs + the docked pane are present now.
    await expect(win.locator(".workspace-tab-header-inner-title", { hasText: "Beta" })).toBeVisible();
    await expect(
      win.locator(".workspace-sidebar.mod-right .probe-pane-body")
    ).toBeVisible();
    // Wait for the debounced layout save (400ms) to flush to disk.
    await expect
      .poll(() => fs.existsSync(path.join(vaultDir, ".geode", "workspace.json")), { timeout: 4000 })
      .toBe(true);
    await app.close();

    // Relaunch the same vault: layout should be restored from workspace.json.
    app = await launch(userDataDir);
    win = await app.firstWindow();
    const consoleErrors: string[] = [];
    win.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

    await expect(win.locator(".workspace-tab-header-inner-title", { hasText: "Alpha" })).toBeVisible();
    await expect(win.locator(".workspace-tab-header-inner-title", { hasText: "Beta" })).toBeVisible();
    // The docked plugin pane came back in the right sidebar.
    await expect(
      win.locator(".workspace-sidebar.mod-right .probe-pane-body")
    ).toBeVisible();
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    await app.close();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

// A plugin that opens its own view on layout-ready, reusing an existing leaf
// of that type — the standard Obsidian activateView pattern.
const AUTO_OPEN_MAIN_JS = `
  const obsidian = require('obsidian');
  const VIEW = 'auto-pane';
  class AutoView extends obsidian.ItemView {
    getViewType() { return VIEW; }
    getDisplayText() { return 'Auto Pane'; }
    getIcon() { return '⚡'; }
    async onOpen() { this.contentEl.createEl('div', { cls: 'auto-pane-body', text: 'auto-ok' }); }
  }
  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      this.registerView(VIEW, (leaf) => new AutoView(leaf));
      this.app.workspace.onLayoutReady(async () => {
        if (this.app.workspace.getLeavesOfType(VIEW).length) return; // reuse restored leaf
        const leaf = this.app.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: VIEW, active: true });
      });
    }
  };
`;

test("does not duplicate an auto-opening plugin's pane across relaunches", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-auto-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-auto-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const pd = path.join(vaultDir, ".geode", "plugins", "auto-pane");
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(
    path.join(pd, "manifest.json"),
    JSON.stringify({ ...MANIFEST, id: "auto-pane", name: "Auto Pane" })
  );
  fs.writeFileSync(path.join(pd, "main.js"), AUTO_OPEN_MAIN_JS);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["auto-pane"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const counts: number[] = [];
  try {
    // Launch three times; the auto-opened pane must stay a singleton (restore
    // recreates it, then onLayoutReady reuses it — no compounding duplicates).
    for (let i = 0; i < 3; i++) {
      const app = await launch(userDataDir);
      const win = await app.firstWindow();
      await win.waitForTimeout(1500);
      counts.push(
        await win.evaluate(() => (window as any).app.workspace.getLeavesOfType("auto-pane").length)
      );
      await win.waitForTimeout(700); // let the debounced layout save flush
      if (i === 0) {
        // The initial auto-opened layout must be persisted WITHOUT any user
        // interaction (regression guard: save subscription is wired before
        // onLayoutReady fires).
        expect(fs.existsSync(path.join(vaultDir, ".geode", "workspace.json"))).toBe(true);
      }
      await app.close();
    }
    expect(counts).toEqual([1, 1, 1]);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("does not accumulate empty tabs across relaunches", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const leafCounts: number[] = [];
  try {
    // Launch repeatedly without opening anything. The main group must stay at
    // a single placeholder tab — empties must never be persisted/re-created.
    for (let i = 0; i < 3; i++) {
      const app = await launch(userDataDir);
      const win = await app.firstWindow();
      await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
      await win.waitForTimeout(700); // allow any (suppressed) save to settle
      leafCounts.push(
        await win.evaluate(() => (window as any).app.workspace.activeGroup.leaves.length)
      );
      await app.close();
    }
    expect(leafCounts).toEqual([1, 1, 1]);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("moves a pane across containers (sidebar ↔ tab group) and reorders tabs by drag", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await launch(userDataDir);
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    // Dock the probe pane in the right sidebar, then move it to the main tab group.
    const afterMoveToMain = await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Alpha.md"), false);
      const leaf = a.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "probe-pane", active: true });
      a.workspace.revealLeaf(leaf);
      // Move it out of the sidebar into the active tab group.
      a.workspace.moveLeaf(leaf, a.workspace.activeGroup);
      return {
        group: leaf.group?.constructor?.name,
        inMain: !!document.querySelector(".workspace-tab-container .probe-pane-body"),
        inSidebar: !!document.querySelector(".workspace-sidebar.mod-right .probe-pane-body"),
      };
    });
    expect(afterMoveToMain.group).toBe("TabGroup");
    expect(afterMoveToMain.inMain).toBe(true);
    expect(afterMoveToMain.inSidebar).toBe(false);

    // Move it back into the right sidebar.
    const afterMoveBack = await win.evaluate(() => {
      const a = (window as any).app;
      const leaf = a.workspace.getLeavesOfType("probe-pane")[0];
      a.workspace.moveLeaf(leaf, a.workspace.rightSidebar);
      return {
        group: leaf.group?.constructor?.name,
        inSidebar: !!document.querySelector(".workspace-sidebar.mod-right .probe-pane-body"),
      };
    });
    expect(afterMoveBack.group).toBe("Sidebar");
    expect(afterMoveBack.inSidebar).toBe(true);

    // Reorder tabs by real drag: open a 2nd + 3rd tab, drag the last before the first.
    await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Beta.md"), true);
    });
    const order1 = await win.evaluate(() =>
      [...document.querySelectorAll(".workspace-tab-container .workspace-tab-header-inner-title, .workspace-tab-header-container .workspace-tab-header-inner-title")]
        .map((e) => (e as HTMLElement).textContent)
    );
    // Drag the "Beta" tab to before the "Alpha" tab.
    const beta = win.locator(".workspace-tab-header", { hasText: "Beta" });
    const alpha = win.locator(".workspace-tab-header", { hasText: "Alpha" });
    await beta.dragTo(alpha, { targetPosition: { x: 2, y: 10 } });
    const order2 = await win.evaluate(() => {
      const a = (window as any).app;
      return a.workspace.activeGroup.leaves.map((l: any) => l.getDisplayText());
    });
    // Beta now precedes Alpha in the tab group order.
    expect(order2.indexOf("Beta")).toBeLessThan(order2.indexOf("Alpha"));
    expect(order1.length).toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
