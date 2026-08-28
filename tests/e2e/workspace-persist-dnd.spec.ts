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
    getIcon() { return 'star'; }
    // Round-trip the view state the way a real plugin does; ItemView's default
    // getState() returns {}, which would drop it at serialize time.
    getState() { return this._state ?? {}; }
    async setState(state) { this._state = state; }
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

/**
 * Every persisted leaf in `workspace.json`, flattened out of the nested split
 * tree. Read from disk deliberately: the point of most of these assertions is
 * what actually survived a save cycle, not what the renderer thinks it has.
 * Returns [] before the first debounced save lands.
 */
function persistedLeaves(vaultDir: string): { type: string; state?: any; title?: string }[] {
  const file = path.join(vaultDir, ".geode", "workspace.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const out: { type: string; state?: any; title?: string }[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === "tabs") out.push(...node.leaves);
    else if (node.type === "split") node.children.forEach(walk);
  };
  for (const region of ["center", "left", "right"]) walk(parsed[region]?.root);
  return out;
}

test("keeps a docked plugin pane as a labelled placeholder when the plugin is disabled, and rehydrates it on re-enable", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const pluginsJson = path.join(vaultDir, ".geode", "plugins.json");
  try {
    // 1. Dock the pane with the plugin enabled and let the layout save.
    let app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    await win.evaluate(async () => {
      const a = (window as any).app;
      const leaf = a.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "probe-pane", active: true, state: { cursor: 42 } });
      a.workspace.revealLeaf(leaf);
    });
    await expect(win.locator(".workspace-sidebar.mod-right .probe-pane-body")).toBeVisible();
    await expect
      .poll(() => persistedLeaves(vaultDir).filter((l) => l.type === "probe-pane").length, {
        timeout: 5000,
      })
      .toBe(1);
    await app.close();

    // 2. Relaunch with the plugin disabled. Pre-fix, the docked leaf was never
    // created (restoreSidebar had no `else`) and the next save dropped it.
    fs.writeFileSync(pluginsJson, JSON.stringify([]));
    app = await launch(userDataDir);
    win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const deferredState = await win.evaluate(() => {
      const a = (window as any).app;
      const leaves = a.workspace.getLeavesOfType("probe-pane");
      return {
        count: leaves.length,
        isDeferred: !!leaves[0] && leaves[0].view.constructor.name === "DeferredView",
        title: leaves[0]?.view?.getDisplayText() ?? null,
        state: leaves[0]?.getViewState()?.state ?? null,
      };
    });
    expect(deferredState.count).toBe(1);
    expect(deferredState.isDeferred).toBe(true);
    // The persisted title, not the raw view type.
    expect(deferredState.title).toBe("Probe Pane");
    expect(deferredState.state).toEqual({ cursor: 42 });

    // The placeholder is visible and labelled; the real view's body is not.
    await expect(
      win.locator(".workspace-sidebar.mod-right .deferred-view-placeholder")
    ).toBeVisible();
    await expect(win.locator(".deferred-view-title")).toHaveText("Probe Pane");
    await expect(win.locator(".probe-pane-body")).toHaveCount(0);
    // The sidebar strip entry must carry an icon, or the pane still looks gone.
    await expect(
      win.locator('.workspace-sidebar.mod-right .workspace-tab-header[data-type="probe-pane"] .workspace-tab-header-inner-icon')
    ).toHaveCount(1);

    // 3. The still-deferred leaf survives this launch's own save, read back
    //    from disk with its type and state intact.
    await win.waitForTimeout(900);
    const onDisk = persistedLeaves(vaultDir).filter((l) => l.type === "probe-pane");
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].state).toEqual({ cursor: 42 });
    expect(onDisk[0].title).toBe("Probe Pane");
    await app.close();

    // 4. Re-enable the plugin: the pane comes back live, still a singleton.
    fs.writeFileSync(pluginsJson, JSON.stringify(["pane-probe"]));
    app = await launch(userDataDir);
    win = await app.firstWindow();
    await expect(win.locator(".workspace-sidebar.mod-right .probe-pane-body")).toBeVisible();
    expect(
      await win.evaluate(() => (window as any).app.workspace.getLeavesOfType("probe-pane").length)
    ).toBe(1);
    await expect(win.locator(".deferred-view-placeholder")).toHaveCount(0);
    await app.close();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps two panes of the same unavailable type as two placeholders, in order", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const pluginsJson = path.join(vaultDir, ".geode", "plugins.json");
  try {
    let app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    await win.evaluate(async () => {
      const a = (window as any).app;
      for (const cursor of [1, 2]) {
        const leaf = a.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: "probe-pane", active: true, state: { cursor } });
      }
    });
    await expect
      .poll(() => persistedLeaves(vaultDir).filter((l) => l.type === "probe-pane").length, {
        timeout: 5000,
      })
      .toBe(2);
    await app.close();

    fs.writeFileSync(pluginsJson, JSON.stringify([]));
    app = await launch(userDataDir);
    win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    // Pre-fix, `getLeavesOfType(type)[0]` matched the placeholder built moments
    // earlier in the same restore pass and collapsed the two into one.
    const states = await win.evaluate(() =>
      (window as any).app.workspace
        .getLeavesOfType("probe-pane")
        .map((l: any) => l.getViewState().state)
    );
    expect(states).toEqual([{ cursor: 1 }, { cursor: 2 }]);
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
        // Record what onLayoutReady actually saw: if hydration hasn't run yet,
        // the restored leaf is still a placeholder and this early-return leaves
        // it dead for the whole session.
        const existing = this.app.workspace.getLeavesOfType(VIEW);
        globalThis.__autoPaneSawLive = existing.length
          ? existing[0].view.constructor.name !== 'DeferredView'
          : null;
        if (existing.length) return; // reuse restored leaf
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
      // Whatever onLayoutReady found, it must never have been a placeholder:
      // the standard `if (getLeavesOfType(VIEW).length) return;` idiom would
      // then early-return and leave the pane dead for the whole session.
      expect(await win.evaluate(() => (globalThis as any).__autoPaneSawLive)).not.toBe(false);
      await expect(win.locator(".auto-pane-body")).toBeVisible();
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

// A plugin whose onload blows PLUGIN_ONLOAD_TIMEOUT_MS (10s) before it gets
// around to registering its view — the real-world "slow plugin" case. The
// synchronous part of onload runs immediately; `registerView` lands long after
// workspace restore has already given up on finding a factory.
const SLOW_MAIN_JS = `
  const obsidian = require('obsidian');
  const VIEW = 'probe-pane';
  class ProbeView extends obsidian.ItemView {
    getViewType() { return VIEW; }
    getDisplayText() { return 'Probe Pane'; }
    getIcon() { return 'star'; }
    getState() { return this._state ?? {}; }
    async setState(state) { this._state = state; }
    async onOpen() { this.contentEl.createEl('div', { cls: 'probe-pane-body', text: 'probe-pane-ok' }); }
  }
  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      await new Promise((r) => setTimeout(r, 12000));
      this.registerView(VIEW, (leaf) => new ProbeView(leaf));
    }
  };
`;

test("restores a pane whose plugin registers its view after the onload timeout", async () => {
  test.setTimeout(90_000);
  const { vaultDir, userDataDir } = makeVault();
  try {
    let app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    await win.evaluate(async () => {
      const a = (window as any).app;
      const leaf = a.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "probe-pane", active: true, state: { cursor: 9 } });
      a.workspace.revealLeaf(leaf);
    });
    await expect
      .poll(() => persistedLeaves(vaultDir).filter((l) => l.type === "probe-pane").length, {
        timeout: 5000,
      })
      .toBe(1);
    await app.close();

    // Swap in the slow variant and relaunch.
    fs.writeFileSync(path.join(vaultDir, ".geode", "plugins", "pane-probe", "main.js"), SLOW_MAIN_JS);
    app = await launch(userDataDir);
    win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible({ timeout: 30_000 });

    // Immediately after restore the pane is a placeholder — and, crucially,
    // this launch's own layout save keeps it rather than stripping it.
    await expect
      .poll(
        () =>
          win.evaluate(() => {
            const leaf = (window as any).app.workspace.getLeavesOfType("probe-pane")[0];
            return leaf ? leaf.view.constructor.name : null;
          }),
        { timeout: 20_000 }
      )
      .toBe("DeferredView");
    await win.waitForTimeout(900);
    expect(persistedLeaves(vaultDir).filter((l) => l.type === "probe-pane")[0]?.state).toEqual({
      cursor: 9,
    });

    // The late registerView reclaims it.
    await expect(win.locator(".workspace-sidebar.mod-right .probe-pane-body")).toBeVisible({
      timeout: 25_000,
    });
    expect(
      await win.evaluate(() => (window as any).app.workspace.getLeavesOfType("probe-pane").length)
    ).toBe(1);
    await app.close();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("awaits deferred-leaf hydration before firing onLayoutReady", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await launch(userDataDir);
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    // The startup ordering is what makes deferral safe: a plugin's
    // onLayoutReady must never observe a placeholder (see AUTO_OPEN_MAIN_JS).
    // Assert it directly off the perf ring, which records each measure when it
    // settles. The ring persists across launches, so compare last occurrences.
    const order = await win.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("geode:performance-ring") ?? "[]");
      const ops = raw.map((m: any) => m.op);
      return {
        hydrate: ops.lastIndexOf("startup-deferred-hydrate"),
        layoutReady: ops.lastIndexOf("startup-layout-ready"),
      };
    });
    expect(order.hydrate).toBeGreaterThanOrEqual(0);
    expect(order.layoutReady).toBeGreaterThanOrEqual(0);
    expect(order.hydrate).toBeLessThan(order.layoutReady);
  } finally {
    await app.close();
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
