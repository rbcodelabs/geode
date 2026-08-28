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
  description: "Registers a dockable view for deferred-pane tests.",
  author: "geode",
};

const MAIN_JS = `
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
    async onload() { this.registerView(VIEW, (leaf) => new ProbeView(leaf)); }
  };
`;

function makeVault(options: { withPlugin?: boolean } = {}): {
  vaultDir: string;
  userDataDir: string;
} {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-deferred-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-deferred-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\n\nhello world\n");
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  if (options.withPlugin) {
    const pd = path.join(vaultDir, ".geode", "plugins", "pane-probe");
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, "manifest.json"), JSON.stringify(MANIFEST));
    fs.writeFileSync(path.join(pd, "main.js"), MAIN_JS);
    fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["pane-probe"]));
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
}

test("keeps the same leaf when a plugin is disabled and re-enabled in a live session", async () => {
  const { vaultDir, userDataDir } = makeVault({ withPlugin: true });
  const app = await launch(userDataDir);
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const before = await win.evaluate(async () => {
      const a = (window as any).app;
      const leaf = a.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "probe-pane", active: true, state: { cursor: 4 } });
      a.workspace.revealLeaf(leaf);
      return { id: leaf.id, view: leaf.view.constructor.name };
    });
    expect(before.view).toBe("ProbeView");
    await expect(win.locator(".workspace-sidebar.mod-right .probe-pane-body")).toBeVisible();

    // Disabling the plugin runs Plugin.onunload -> unregisterViewFactory.
    // That used to call detachLeavesOfType and destroy the pane outright,
    // which also meant a routine plugin *update* wiped it.
    await win.evaluate(() => (window as any).app.pluginManager.disable("pane-probe"));
    const disabled = await win.evaluate(() => {
      const leaves = (window as any).app.workspace.getLeavesOfType("probe-pane");
      return {
        count: leaves.length,
        id: leaves[0]?.id ?? null,
        view: leaves[0]?.view?.constructor?.name ?? null,
        state: leaves[0]?.getViewState()?.state ?? null,
      };
    });
    expect(disabled.count).toBe(1);
    expect(disabled.id).toBe(before.id);
    expect(disabled.view).toBe("DeferredView");
    expect(disabled.state).toEqual({ cursor: 4 });
    await expect(
      win.locator(".workspace-sidebar.mod-right .deferred-view-placeholder")
    ).toBeVisible();
    await expect(win.locator(".probe-pane-body")).toHaveCount(0);

    // Re-enabling registers the factory again, which hydrates the placeholder
    // in place — same leaf, same state, no duplicate pane.
    await win.evaluate(() => (window as any).app.pluginManager.enable("pane-probe"));
    await expect(win.locator(".workspace-sidebar.mod-right .probe-pane-body")).toBeVisible();
    const reenabled = await win.evaluate(() => {
      const leaves = (window as any).app.workspace.getLeavesOfType("probe-pane");
      return {
        count: leaves.length,
        id: leaves[0]?.id ?? null,
        view: leaves[0]?.view?.constructor?.name ?? null,
        state: leaves[0]?.getViewState()?.state ?? null,
      };
    });
    expect(reenabled).toEqual({
      count: 1,
      id: before.id,
      view: "ProbeView",
      state: { cursor: 4 },
    });
    await expect(win.locator(".deferred-view-placeholder")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

/**
 * Built-ins have no registered view factory, so the deferral machinery must
 * never mint a placeholder for one. A ghost `search` placeholder would both
 * duplicate the pane forever and break `app.openSearch`, which does
 * `getLeavesOfType("search")[0].view as SearchView` and calls `setQuery` on it.
 */
test("never defers a built-in view type, even when the layout names it twice", async () => {
  const { vaultDir, userDataDir } = makeVault();
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "workspace.json"),
    JSON.stringify({
      version: 2,
      center: {
        root: {
          type: "tabs",
          leaves: [{ type: "search" }, { type: "markdown", file: "Alpha.md" }],
          active: 0,
        },
        activeGroup: 0,
      },
      left: {
        root: { type: "tabs", leaves: [{ type: "file-explorer" }, { type: "search" }], active: 0 },
        collapsed: false,
        width: 280,
      },
      right: { root: { type: "tabs", leaves: [], active: 0 }, collapsed: false, width: 280 },
    })
  );

  const app = await launch(userDataDir);
  try {
    const win = await app.firstWindow();
    const consoleErrors: string[] = [];
    win.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const counts = await win.evaluate(() => ({
      search: (window as any).app.workspace.getLeavesOfType("search").length,
      fileExplorer: (window as any).app.workspace.getLeavesOfType("file-explorer").length,
    }));
    expect(counts).toEqual({ search: 1, fileExplorer: 1 });
    // No placeholder anywhere — a built-in must never produce one.
    await expect(win.locator(".deferred-view-placeholder")).toHaveCount(0);

    // The surviving leaf is the real SearchView, not something impersonating
    // its type: `openSearch` casts and calls `setQuery`.
    const query = await win.evaluate(() => {
      const a = (window as any).app;
      a.openSearch("hello");
      return a.workspace.getLeavesOfType("search")[0].view.constructor.name;
    });
    expect(query).toBe("SearchView");
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
