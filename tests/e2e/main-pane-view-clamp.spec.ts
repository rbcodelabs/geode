import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

// Where fixed-state screenshots are dropped for the QA report. Kept out of the
// repo (temp dir) so a normal `npm test` never litters the working tree; the
// exact paths are logged so they can be copied into the vault QA note.
const SHOT_DIR = path.join(os.tmpdir(), "geode-clamp-shots");

const MANIFEST = {
  id: "tall-main-view",
  name: "Tall Main View",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "e2e fixture: an ItemView with a very tall content column, opened in a main-pane tab.",
  author: "geode",
};

// A real plugin (require('geode')) that registers an ItemView whose content is
// a tall column of many rows (far exceeding the window height) plus an
// absolutely-positioned "dispatch" panel pinned near the bottom of the view.
// This mirrors the Claude Threads Kanban board's structure: a scrollable list
// inside a flex column, with a floating panel positioned relative to the view
// root. The command mounts it in a MAIN-PANE tab via getLeaf(true) +
// setViewState — the exact path that regressed (main-pane views were never
// height-clamped, so the column ballooned and pushed the panel off-screen).
const ITEM_COUNT = 60;
const ITEM_HEIGHT = 44; // 60 * 44 = 2640px of content, well over an 840px window
const MAIN_JS = `
  const { Plugin, ItemView } = require('geode');
  const VIEW_TYPE = 'tall-main-view';

  class TallView extends ItemView {
    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'Tall Main View'; }
    async onOpen() {
      const root = this.contentEl.createDiv({ cls: 'tall-root' });
      root.style.cssText =
        'position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; height: 100%;';

      const list = root.createDiv({ cls: 'tall-list' });
      list.style.cssText = 'flex: 1; min-height: 0; overflow-y: auto;';
      for (let i = 0; i < ${ITEM_COUNT}; i++) {
        const item = list.createDiv({ cls: 'tall-item', text: 'Card ' + (i + 1) });
        item.style.cssText =
          'height: ${ITEM_HEIGHT}px; box-sizing: border-box; padding: 8px 12px;' +
          'border-bottom: 1px solid var(--background-modifier-border, #333);';
      }

      const panel = root.createDiv({ cls: 'dispatch-panel', text: 'Dispatch a new task' });
      panel.style.cssText =
        'position: absolute; left: 8px; right: 8px; bottom: 16px; height: 40px;' +
        'display: flex; align-items: center; justify-content: center;' +
        'background: var(--interactive-accent, #5b3df5); color: white; border-radius: 6px;';
    }
  }

  module.exports.default = class TallViewPlugin extends Plugin {
    async onload() {
      this.registerView(VIEW_TYPE, (leaf) => new TallView(leaf));
      this.addCommand({
        id: 'open-tall-view',
        name: 'Open tall main view',
        callback: async () => {
          const leaf = this.app.workspace.getLeaf(true); // main-pane tab
          await leaf.setViewState({ type: VIEW_TYPE, active: true });
        },
      });
    }
  };
`;

/**
 * Regression test for the main-pane plugin-view height clamp.
 *
 * Before the fix, `.workspace-leaf-content` / `.view-content-host` had no
 * height clamp in the main tab area (only sidebar-docked views were clamped),
 * so a tall ItemView ballooned its host to the full content height and pushed
 * any absolutely-positioned floating panel far below the visible window. This
 * test opens exactly such a view in a MAIN-PANE tab and asserts that:
 *   1. the view host is clamped to ~the leaf/window height (NOT the intrinsic
 *      content height), and its inner list scrolls internally; and
 *   2. the floating "dispatch" panel stays within the window viewport.
 */
test("main-pane plugin ItemView is height-clamped and its floating panel stays on-screen", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-clamp-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-clamp-e2e-"));

  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "tall-main-view");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["tall-main-view"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const consoleErrors: string[] = [];
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  // Reads the geometry of the tall view host, its leaf, the inner scroll list,
  // and the floating panel, all relative to the current window.
  const measure = () =>
    window.evaluate(() => {
      const hosts = Array.from(document.querySelectorAll<HTMLElement>(".view-content-host"));
      const host = hosts.find((h) => h.querySelector(".tall-root"));
      if (!host) return null;
      const leaf = host.closest<HTMLElement>(".workspace-leaf");
      const list = host.querySelector<HTMLElement>(".tall-list");
      const panel = host.querySelector<HTMLElement>(".dispatch-panel");
      if (!leaf || !list || !panel) return null;
      const hostRect = host.getBoundingClientRect();
      const leafRect = leaf.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        innerHeight: window.innerHeight,
        hostHeight: hostRect.height,
        leafHeight: leafRect.height,
        // Intrinsic content height of the scrollable list — what the host
        // WOULD balloon to if it weren't clamped.
        listScrollHeight: list.scrollHeight,
        listClientHeight: list.clientHeight,
        panelTop: panelRect.top,
        panelBottom: panelRect.bottom,
      };
    });

  let window!: Awaited<ReturnType<typeof app.firstWindow>>;

  try {
    window = await app.firstWindow();
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    // Plugin loaded -> execute its command to mount the view in a main-pane tab.
    await expect
      .poll(() => window.evaluate(() => (window as any).app?.plugins?.getPlugin?.("tall-main-view") != null))
      .toBe(true);
    await window.evaluate(() => (window as any).app.commands.execute("tall-main-view:open-tall-view"));

    // The tall view mounted in the main pane.
    const host = window.locator(".workspace-leaf-content.view-content-host", { has: window.locator(".tall-root") });
    await expect(host).toBeVisible();
    await expect(window.locator(".dispatch-panel")).toBeVisible();
    // 60 rows rendered -> content genuinely exceeds the window height.
    await expect(window.locator(".tall-item")).toHaveCount(ITEM_COUNT);

    // ---- Assertion set at the default window size (1280x840) --------------
    const m1 = await measure();
    expect(m1, "tall view host/leaf/list/panel should all be present").not.toBeNull();

    // The content the host would balloon to (2640px) genuinely exceeds the
    // window, so this is a real clamp, not a trivially-small view.
    expect(m1!.listScrollHeight).toBeGreaterThan(m1!.innerHeight);

    // (1a) Host is clamped to ~the leaf height, NOT ballooned to content height.
    expect(m1!.hostHeight).toBeLessThanOrEqual(m1!.leafHeight + 2);
    expect(m1!.hostHeight).toBeLessThan(m1!.listScrollHeight - 500);
    // (1b) The clamp forced the inner list to scroll internally.
    expect(m1!.listScrollHeight).toBeGreaterThan(m1!.listClientHeight + 100);

    // (2) The floating dispatch panel is fully within the window viewport.
    expect(m1!.panelTop).toBeGreaterThanOrEqual(0);
    expect(m1!.panelBottom).toBeLessThanOrEqual(m1!.innerHeight);

    await window.screenshot({ path: path.join(SHOT_DIR, "fixed-1280x840.png") });

    // ---- Same assertions at a smaller window size (900x700) ---------------
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(900, 700);
    });
    await expect.poll(async () => (await measure())?.innerHeight ?? 0).toBeLessThan(720);

    const m2 = await measure();
    expect(m2, "tall view geometry after resize").not.toBeNull();
    expect(m2!.listScrollHeight).toBeGreaterThan(m2!.innerHeight);
    expect(m2!.hostHeight).toBeLessThanOrEqual(m2!.leafHeight + 2);
    expect(m2!.hostHeight).toBeLessThan(m2!.listScrollHeight - 500);
    expect(m2!.panelTop).toBeGreaterThanOrEqual(0);
    expect(m2!.panelBottom).toBeLessThanOrEqual(m2!.innerHeight);

    await window.screenshot({ path: path.join(SHOT_DIR, "fixed-900x700.png") });

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
    // Surface the screenshot paths in the test log for the QA report.
    console.log(`[clamp-test] screenshots written to: ${SHOT_DIR}`);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
