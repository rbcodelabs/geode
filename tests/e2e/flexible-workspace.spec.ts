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
  await expect(window.locator(".workspace-center > .workspace-tabs")).toHaveCount(2);
  await expect(window.locator('.workspace-center .workspace-leaf-content[data-type="file-explorer"]')).toBeVisible();
  if (screenshotDir) {
    await window.screenshot({ path: path.join(screenshotDir, "flexible-workspace-file-explorer-center.png") });
  }
});

test("dragging an external file over a center body edge does not target or create a split", async () => {
  const target = window.locator(".workspace-center .workspace-tab-container").first();
  const groupsBefore = await window.locator(".workspace-center > .workspace-tabs").count();

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
  await expect(window.locator(".workspace-center > .workspace-tabs")).toHaveCount(groupsBefore);
});
