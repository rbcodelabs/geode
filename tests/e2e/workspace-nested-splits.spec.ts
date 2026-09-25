import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Regression coverage for the center-region drop-target bug: dragging a tab
 * to the top/bottom edge of a *center* pane showed a correct stacked
 * (vertical) drop preview during the drag, but releasing always produced a
 * left/right (horizontal) split instead — `TabGroup.installDropTarget()`'s
 * body-drop handler called `Workspace.addGroup()`, which is horizontal-only,
 * regardless of the computed edge. `Workspace.splitGroup(target, edge, ratio)`
 * fixes this by actually honoring `edge`, and generalizes the center region
 * from a single flat row into a recursive mixed-direction split tree (see
 * `CenterSplit` in `src/renderer/workspace.ts`).
 */

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-nested-splits-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-nested-splits-ud-"));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  app = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${userData}`], cwd: path.resolve(".") });
  window = await app.firstWindow();
  await window.waitForSelector(".workspace");
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any) => win.setSize(1280, 900));
});

test.afterEach(async () => { await app?.close(); });

/**
 * Open `name` in `groupIndex` (defaults to the active group). `newTab`
 * matches `App.openFile`'s `newLeaf` — `false` (the default) reuses that
 * group's already-active leaf, which is exactly what a freshly split group's
 * empty placeholder leaf is for; pass `true` to add a second real tab
 * alongside content already open in that group.
 */
async function openNote(name: string, groupIndex?: number, newTab = false): Promise<void> {
  await window.evaluate(async ({ name, groupIndex, newTab }: { name: string; groupIndex?: number; newTab: boolean }) => {
    const app = (window as any).app;
    const workspace = app.workspace;
    if (typeof groupIndex === "number") workspace.setActiveGroup(workspace.groups[groupIndex]);
    const file = app.vault.getFileByPath(`${name}.md`) ?? (await app.vault.create(`${name}.md`, `# ${name}`));
    await app.openFile(file, newTab);
  }, { name, groupIndex, newTab });
}

/** Drag the tab header for `fileName` onto an edge zone of `targetGroupIndex`'s content host. */
async function dragTabToEdge(fileName: string, targetGroupIndex: number, edge: "left" | "right" | "top" | "bottom"): Promise<void> {
  const tab = window.locator(".workspace-tab-header", { hasText: fileName });
  const targets = window.locator(".workspace-tab-container");
  const target = targets.nth(targetGroupIndex);
  const box = await target.boundingBox();
  if (!box) throw new Error(`no bounding box for content host ${targetGroupIndex}`);
  // Comfortably inside the 20% edge band `TabGroup.installDropTarget()` reads.
  const position = {
    left: { x: Math.max(1, box.width * 0.05), y: box.height / 2 },
    right: { x: box.width * 0.95, y: box.height / 2 },
    top: { x: box.width / 2, y: Math.max(1, box.height * 0.05) },
    bottom: { x: box.width / 2, y: box.height * 0.95 },
  }[edge];
  await tab.dragTo(target, { targetPosition: position });
}

/** Serialized center tree, for shape assertions independent of DOM structure. */
async function centerRoot(): Promise<any> {
  return window.evaluate(() => (window as any).app.workspace.serialize().center.root);
}

test("dragging a tab to the top edge of a group in a horizontal split wraps just that group in a vertical split", async () => {
  await openNote("First");
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  await openNote("Second", 1);
  await openNote("Third", 1, true); // group 1 now has two tabs: Second, Third

  await dragTabToEdge("Third", 0, "top");

  const root = await centerRoot();
  expect(root.type).toBe("split");
  expect(root.direction).toBe("horizontal");
  expect(root.children).toHaveLength(2);
  const [wrapped, sibling] = root.children;
  // The former group-0 slot is now a vertical split of [Third, First]; the
  // sibling (group 1, still holding Second) is untouched.
  expect(wrapped.type).toBe("split");
  expect(wrapped.direction).toBe("vertical");
  expect(wrapped.children.map((c: any) => c.leaves.map((l: any) => l.file))).toEqual([["Third.md"], ["First.md"]]);
  expect(sibling.type).toBe("tabs");
  expect(sibling.leaves.map((l: any) => l.file)).toEqual(["Second.md"]);
  // `:not(.mod-root)` excludes Geode's center wrapper, which is unconditionally
  // classed `mod-root mod-vertical` for Obsidian theme compatibility regardless
  // of the actual tree shape (see `Workspace.centerEl` setup) — an unscoped
  // `.mod-vertical` query would always over-count by one.
  await expect(window.locator(".workspace-split.mod-vertical:not(.mod-root)")).toHaveCount(1);
});

test("dragging a tab to the bottom edge of an existing vertical stack joins that split instead of nesting another", async () => {
  await openNote("First");
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  await openNote("Second", 1);
  await openNote("Third", 1, true);
  await dragTabToEdge("Third", 0, "top"); // creates the vertical[Third, First] stack

  // Drop "Second" onto the bottom edge of the stack's bottom pane (First).
  await dragTabToEdge("Second", 1, "bottom");

  const root = await centerRoot();
  // Exactly one vertical split with three stacked panes — no nested wrapper.
  // The sibling group holding "Second" is emptied by the move and closed,
  // which leaves the outer horizontal split with a single child; that
  // redundant wrapper collapses (see `Workspace.closeGroup`), promoting the
  // vertical stack itself to `root` rather than leaving it nested one level down.
  expect(root.type).toBe("split");
  expect(root.direction).toBe("vertical");
  expect(root.children.map((c: any) => c.leaves.map((l: any) => l.file))).toEqual([["Third.md"], ["First.md"], ["Second.md"]]);
  await expect(window.locator(".workspace-split.mod-vertical:not(.mod-root)")).toHaveCount(1);
});

test("dragging a tab to the right edge of a pane in a vertical stack nests a horizontal split inside it", async () => {
  await openNote("First");
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  await openNote("Second", 1);
  await openNote("Third", 1, true);
  await dragTabToEdge("Third", 0, "top"); // vertical[Third, First] alongside group holding Second

  // Drop "Second" onto the right edge of the vertical stack's bottom pane (First).
  await dragTabToEdge("Second", 1, "right");

  const root = await centerRoot();
  // As above: the sibling group holding "Second" is emptied and closed, so the
  // outer horizontal split collapses and the vertical stack becomes `root`
  // directly — its second pane (First) is now itself wrapped in a nested
  // horizontal split with the incoming "Second".
  expect(root.type).toBe("split");
  expect(root.direction).toBe("vertical");
  expect(root.children).toHaveLength(2);
  const [third, nested] = root.children;
  expect(third.type).toBe("tabs");
  expect(third.leaves.map((l: any) => l.file)).toEqual(["Third.md"]);
  expect(nested.type).toBe("split");
  expect(nested.direction).toBe("horizontal");
  expect(nested.children.map((c: any) => c.leaves.map((l: any) => l.file))).toEqual([["First.md"], ["Second.md"]]);
  await expect(window.locator(".workspace-split.mod-horizontal:not(.mod-root)")).toHaveCount(1);
});

test("closing panes back down to one leaves no leftover split wrapper in the DOM", async () => {
  await openNote("First");
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  await openNote("Second", 1);
  await dragTabToEdge("Second", 0, "top"); // vertical[Second, First], one pane per leaf

  await expect(window.locator(".workspace-tabs")).toHaveCount(2);
  // Scoped to `.workspace-center`: an unscoped `.workspace-split` also matches
  // the always-present left/right sidebar containers (they carry the same
  // class, see `Sidebar`'s `mod-sidedock` setup), and the descendant selector
  // itself excludes the center wrapper (`.workspace-center` is the ancestor,
  // not a descendant of itself), so this reads as "real splits inside the
  // center region" without needing a `:not(.mod-root)` exclusion too.
  await expect(window.locator(".workspace-center .workspace-split")).toHaveCount(1);

  await window.evaluate(async () => {
    const workspace = (window as any).app.workspace;
    // Close every pane but the last by detaching its sole leaf.
    while (workspace.groups.length > 1) {
      const leaf = workspace.groups[0].leaves[0];
      await leaf.detach();
    }
  });

  await expect(window.locator(".workspace-tabs")).toHaveCount(1);
  await expect(window.locator(".workspace-center .workspace-split")).toHaveCount(0);
  const root = await centerRoot();
  expect(root.type).toBe("tabs");
});

test("a nested split layout survives reload", async () => {
  await openNote("First");
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  await openNote("Second", 1);
  await openNote("Third", 1, true);
  await dragTabToEdge("Third", 0, "top");

  const before = await centerRoot();
  await window.evaluate(async () => {
    const state = (window as any).app.workspace.serialize();
    await (window as any).hostServices.config.write("workspace", state);
  });
  await window.reload();
  await window.waitForSelector(".workspace");
  const after = await centerRoot();
  expect(after).toEqual(before);
  await expect(window.locator(".workspace-split.mod-vertical:not(.mod-root)")).toHaveCount(1);
});
