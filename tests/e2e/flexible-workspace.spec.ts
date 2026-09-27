import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let app: ElectronApplication;
let window: Page;
let vault: string;
let userData: string;
const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;

test.beforeAll(async () => {
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-flex-workspace-"));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-flex-workspace-ud-"));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  app = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${userData}`], cwd: path.resolve(".") });
  window = await app.firstWindow();
  await window.waitForSelector(".workspace");
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any) => win.setSize(1280, 800));
});

test.afterAll(async () => { await app?.close(); });

test("split sidebar leaves create independent vertically stacked groups and false reuses", async () => {
  const result = await window.evaluate(() => {
    const workspace = (window as any).app.workspace;
    const first = workspace.getRightLeaf(false);
    const reused = workspace.getRightLeaf(false);
    const split = workspace.getRightLeaf(true);
    return {
      reused: first === reused,
      split: first.group !== split.group,
      groups: workspace.rightSidebar.groups.length,
    };
  });
  expect(result).toEqual({ reused: true, split: true, groups: 2 });
  await expect(window.locator(".workspace-sidebar.mod-right .workspace-split-resize-handle")).toHaveCount(1);
});

test("built-in sidebar views are movable leaves without reopening or closing", async () => {
  const result = await window.evaluate(() => {
    const workspace = (window as any).app.workspace;
    const leaf = workspace.getLeavesOfType("file-explorer")[0];
    const view = leaf?.view;
    let opens = 0;
    let closes = 0;
    const originalOpen = view.onOpen.bind(view);
    const originalClose = view.onClose.bind(view);
    view.onOpen = () => { opens++; return originalOpen(); };
    view.onClose = () => { closes++; return originalClose(); };
    workspace.moveLeaf(leaf, workspace.rightSidebar.defaultGroup);
    return {
      found: !!leaf,
      sameView: leaf.view === view,
      opens,
      closes,
      inRight: !!document.querySelector('.workspace-sidebar.mod-right [data-type="file-explorer"]'),
    };
  });
  expect(result).toEqual({ found: true, sameView: true, opens: 0, closes: 0, inRight: true });
});

test("sidebar dividers resize with minimum clamping and serialize the recursive tree", async () => {
  const handle = window.locator(".workspace-sidebar.mod-right .workspace-split-resize-handle").first();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await handle.dispatchEvent("pointerdown", { clientX: box!.x + 2, clientY: box!.y + 2, pointerId: 1 });
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", { clientY: -10_000, pointerId: 1 })));
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })));

  const result = await window.evaluate(() => {
    const workspace = (window as any).app.workspace;
    const groups = [...document.querySelectorAll(".workspace-sidebar.mod-right .workspace-tabs")];
    const saved = workspace.serialize();
    return {
      minHeight: Math.min(...groups.map((group: any) => group.getBoundingClientRect().height)),
      version: saved.version,
      direction: saved.right.root.direction,
      sizes: saved.right.root.sizes,
    };
  });
  expect(result.minHeight).toBeGreaterThanOrEqual(120);
  expect(result.version).toBe(3);
  expect(result.direction).toBe("vertical");
  expect(result.sizes).toHaveLength(2);
  if (screenshotDir) {
    await window.screenshot({ path: path.join(screenshotDir, "flexible-workspace-sidebar-split-resized.png") });
  }
});

test("top-edge sidebar drop inserts the moved built-in before existing groups", async () => {
  const source = window.locator('[data-type="search"]').first();
  const target = window.locator(".workspace-sidebar.mod-right");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await source.dragTo(target, { targetPosition: { x: box!.width / 2, y: 2 } });
  const order = await window.evaluate(() => {
    const sidebar = (window as any).app.workspace.rightSidebar;
    return sidebar.groups.map((group: any) => group.leaves.map((leaf: any) => leaf.view?.viewType));
  });
  expect(order[0]).toContain("search");
});

test("built-in singleton commands find a relocated Search leaf", async () => {
  const result = await window.evaluate(() => {
    const app = (window as any).app;
    const leaf = app.workspace.getLeavesOfType("search")[0];
    app.workspace.moveLeaf(leaf, app.workspace.activeGroup);
    app.openSearch("relocated needle");
    return {
      same: app.workspace.getLeavesOfType("search")[0] === leaf,
      connected: leaf.view.containerEl.isConnected,
      query: leaf.view.inputEl?.value,
    };
  });
  expect(result).toEqual({ same: true, connected: true, query: "relocated needle" });
});

test("dragging a built-in tab to a center body edge creates a split", async () => {
  const source = window.locator('[data-type="file-explorer"]').first();
  const target = window.locator(".workspace-center .workspace-tab-container").first();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await source.dragTo(target, { targetPosition: { x: box!.width - 2, y: box!.height / 2 } });
  // Descendant, not direct-child: `.workspace-center`'s sole DOM child is now
  // the center root node's `containerEl` — a `CenterSplit` wrapper once there's
  // more than one group — so groups are no longer necessarily direct children.
  await expect(window.locator(".workspace-center .workspace-tabs")).toHaveCount(2);
  await expect(window.locator('.workspace-center .workspace-leaf-content[data-type="file-explorer"]')).toBeVisible();
  if (screenshotDir) {
    await window.screenshot({ path: path.join(screenshotDir, "flexible-workspace-file-explorer-center.png") });
  }
});

test("dragging an external file over a center body edge does not target or create a split", async () => {
  const target = window.locator(".workspace-center .workspace-tab-container").first();
  const groupsBefore = await window.locator(".workspace-center .workspace-tabs").count();

  const result = await target.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File(["external"], "external.md", { type: "text/markdown" }));
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.right - 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer: transfer,
    };
    el.dispatchEvent(new DragEvent("dragover", eventInit));
    const dropTarget = el.closest<HTMLElement>(".workspace-tabs")?.dataset.dropTarget ?? null;
    return { dropTarget };
  });

  expect(result.dropTarget).toBeNull();
  if (screenshotDir) {
    await window.screenshot({ path: path.join(screenshotDir, "flexible-workspace-external-file-no-split.png") });
  }
  await target.evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["external"], "external.md", { type: "text/markdown" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(window.locator(".workspace-center .workspace-tabs")).toHaveCount(groupsBefore);
});

/**
 * Regression coverage: `TabGroup`'s constructor wires a `mousedown` listener
 * on `containerEl` (`this.workspace.setActiveGroup(this)`) to keep
 * `Workspace.activeGroup` in sync with whatever pane the user last clicked
 * in. `Workspace.activeGroup` must only ever be a *main-area* group — see the
 * invariant documented on `resolveSourceLeaf`/`getMostRecentLeaf` in
 * workspace.ts — and `TabGroup.setActiveLeaf`'s own two call sites already
 * guard this with `if (!this.sidebar)`. The constructor's listener lacked
 * that guard, so a plain mousedown anywhere inside a *split* sidebar pane
 * (docked via `getRightLeaf(true)`/`getLeftLeaf(true)`, e.g. two Calendar-like
 * panes stacked in the right sidebar) corrupted `activeGroup` to point at the
 * sidebar. After that, any plugin's `workspace.getLeaf(false)` /
 * `workspace.getUnpinnedLeaf()` call — including the real Calendar plugin's
 * day-click handler (`openOrCreateDailyNote`), exercised directly here via
 * `getUnpinnedLeaf()` — resolved to that sidebar leaf and opened content
 * there instead of the main workspace area.
 *
 * A single non-split sidebar dock (`getRightLeaf(false)`, going through
 * `Sidebar.addLeaf()`) does not exercise this: only a *split* sidebar group
 * goes through the vulnerable `TabGroup` constructor path, which is why this
 * test specifically adds a second, split group before clicking in it.
 *
 * Launches its own dedicated Electron instance (rather than reusing this
 * file's shared, sequential `app`) so it neither depends on nor perturbs the
 * group-count/DOM-order assumptions baked into the other tests here (several
 * of which move/split the right sidebar's built-in views across the file's
 * shared session).
 */
test("mousedown inside a split sidebar pane does not corrupt the main-area active group", async () => {
  const mainFileName = "SidebarMousedownRegressionMain.md";
  const isolatedVault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sidebar-mousedown-"));
  const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sidebar-mousedown-ud-"));
  fs.writeFileSync(
    path.join(isolatedUserData, "geode.json"),
    JSON.stringify({ recentVaults: [isolatedVault], lastVault: isolatedVault })
  );
  const isolatedApp = await electron.launch({
    args: [path.resolve("."), `--user-data-dir=${isolatedUserData}`],
    cwd: path.resolve("."),
  });
  try {
    const isolatedWindow = await isolatedApp.firstWindow();
    await isolatedWindow.waitForSelector(".workspace");

    await isolatedWindow.evaluate(async (fileName) => {
      const app = (window as any).app;
      const file = await app.vault.create(fileName, "# Main");
      await app.openFile(file, false);
    }, mainFileName);

    // Dock a *split* sidebar pane (two stacked TabGroups in the right
    // sidebar) — the shape that actually exercises the vulnerable
    // `TabGroup` constructor path, matching how the Calendar plugin's issue
    // was reported (see calendar-plugin.spec.ts for the non-split dock,
    // which does NOT reproduce this).
    //
    // The sidebar's own default (unsplit) group is `Sidebar` itself, whose
    // `containerEl` carries `.workspace-sidebar`, not `.workspace-tabs` (see
    // `Sidebar.defaultGroup`) — so `.workspace-tabs` under the right sidebar
    // only ever matches genuine *split* `TabGroup`s, counted here before
    // adding one via `getRightLeaf(true)`.
    const sidebarGroups = isolatedWindow.locator(".workspace-sidebar.mod-right .workspace-tabs");
    const splitGroupsBefore = await sidebarGroups.count();
    await isolatedWindow.evaluate(() => void (window as any).app.workspace.getRightLeaf(true));
    await expect(sidebarGroups).toHaveCount(splitGroupsBefore + 1);
    // The newly added split group is the last one. Dispatched directly on
    // its container (not a tab header, button, or other control) — a bare
    // click on blank pane background is exactly what corrupted `activeGroup`
    // before the fix, since the listener is unconditional and not scoped to
    // any particular descendant.
    await sidebarGroups.nth(splitGroupsBefore).dispatchEvent("mousedown");

    const result = await isolatedWindow.evaluate((fileName) => {
      const workspace = (window as any).app.workspace;
      // The exact call the vendored Calendar plugin's day-click handler
      // makes (see calendar-plugin.spec.ts / tests/fixtures/plugins/calendar).
      const unpinned = workspace.getUnpinnedLeaf();
      return {
        activeGroupIsSidebar: workspace.activeGroup.isSidebar,
        unpinnedLeafIsSidebar: unpinned.group.isSidebar,
        unpinnedLeafFile: unpinned.view?.getFile?.()?.path ?? null,
      };
    }, mainFileName);

    expect(result).toEqual({ activeGroupIsSidebar: false, unpinnedLeafIsSidebar: false, unpinnedLeafFile: mainFileName });
  } finally {
    await isolatedApp.close();
    fs.rmSync(isolatedVault, { recursive: true, force: true });
    fs.rmSync(isolatedUserData, { recursive: true, force: true });
  }
});
