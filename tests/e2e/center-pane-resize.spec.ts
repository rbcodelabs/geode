import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let app: ElectronApplication;
let window: Page;
const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;

test.beforeEach(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-center-resize-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-center-resize-ud-"));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  app = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${userData}`], cwd: path.resolve(".") });
  window = await app.firstWindow();
  await window.waitForSelector(".workspace");
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any) => win.setSize(1280, 800));
});

test.afterEach(async () => { await app?.close(); });

test("ordinary and ratio splits preserve their requested allocations", async () => {
  const result = await window.evaluate(() => {
    const workspace = (window as any).app.workspace;
    workspace.splitActiveLeaf("vertical");
    const ordinary = workspace.serialize().center.root.sizes;
    workspace.groupEmptied(workspace.groups[1]);
    workspace.splitActiveLeafWithRatio("vertical", 0.3);
    return { ordinary, ratio: workspace.serialize().center.root.sizes };
  });
  expect(result.ordinary).toEqual([0.5, 0.5]);
  expect(result.ratio[0]).toBeCloseTo(0.3, 6);
  expect(result.ratio[1]).toBeCloseTo(0.7, 6);
  await expect(window.locator(".workspace-center .workspace-center-resize-handle")).toHaveCount(1);
});

test("a split workspace keeps a usable right sidebar collapse and expand control", async () => {
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));

  const rightToggle = window.locator(".workspace-center .sidebar-toggle-button.mod-right").last();
  const rightSidebar = window.locator(".workspace-sidebar.mod-right");
  await expect(rightToggle).toBeVisible();
  await expect(rightToggle).toHaveAccessibleName("Collapse sidebar");
  await rightToggle.click();
  await expect(rightSidebar).toHaveClass(/is-collapsed/);

  const expandToggle = window.locator(".workspace-center .sidebar-toggle-button.mod-right").last();
  await expect(expandToggle).toBeVisible();
  await expect(expandToggle).toHaveAccessibleName("Expand sidebar");
  await expandToggle.click();
  await expect(rightSidebar).not.toHaveClass(/is-collapsed/);
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await window.screenshot({ path: path.join(screenshotDir, "split-workspace-right-sidebar-reopened.png") });
  }
});

test("a real center-divider drag clamps, serializes, and restores after restart", async () => {
  await window.evaluate(async () => {
    const app = (window as any).app;
    const first = await app.vault.create("Drag first.md", "# First");
    await app.openFile(first, false);
    app.workspace.splitActiveLeaf("vertical");
    const second = await app.vault.create("Drag second.md", "# Second");
    await app.openFile(second, false);
  });
  const handle = window.locator(".workspace-center .workspace-center-resize-handle");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.move(box!.x + 2, box!.y + 2);
  await window.mouse.down();
  await window.mouse.move(0, box!.y + 2);
  await window.mouse.up();
  const result = await window.evaluate(() => {
    const panes = [...document.querySelectorAll<HTMLElement>(".workspace-center .workspace-tabs")];
    return {
      widths: panes.map((pane) => pane.getBoundingClientRect().width),
      sizes: (window as any).app.workspace.serialize().center.root.sizes,
    };
  });
  expect(Math.min(...result.widths)).toBeGreaterThanOrEqual(239);
  expect(result.sizes[0]).toBeLessThan(result.sizes[1]);
  await window.evaluate(async () => {
    const state = (window as any).app.workspace.serialize();
    await (window as any).hostServices.config.write("workspace", state);
  });
  await window.reload();
  await window.waitForSelector(".workspace");
  expect(await window.evaluate(() => (window as any).app.workspace.serialize().center.root.sizes)).toEqual(result.sizes);
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await window.screenshot({ path: path.join(screenshotDir, "center-pane-resized.png") });
  }
});

test("center divider is keyboard operable and exposes separator state", async () => {
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  const handle = window.getByRole("separator");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle).toHaveAttribute("tabindex", "0");
  await handle.focus();
  await handle.press("ArrowRight");
  const sizes = await window.evaluate(() => (window as any).app.workspace.serialize().center.root.sizes);
  expect(sizes[0]).toBeCloseTo(0.55, 6);
  expect(sizes[1]).toBeCloseTo(0.45, 6);
  await expect(handle).toHaveAttribute("aria-valuenow", "55");
});

test("pointer cancellation cleans up resize listeners without accepting later movement", async () => {
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  const handle = window.getByRole("separator");
  const box = await handle.boundingBox();
  await handle.dispatchEvent("pointerdown", { clientX: box!.x + 2, clientY: box!.y + 2, pointerId: 7 });
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700, pointerId: 7 })));
  await handle.dispatchEvent("pointercancel", { pointerId: 7 });
  const cancelled = await window.evaluate(() => (window as any).app.workspace.serialize().center.root.sizes);
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1_000, pointerId: 7 })));
  expect(await window.evaluate(() => (window as any).app.workspace.serialize().center.root.sizes)).toEqual(cancelled);
  await expect(handle).not.toHaveClass(/is-resizing/);
});

/**
 * Regression: a *stacked* (top/bottom) split with content tall enough to
 * overflow its assigned share rendered at its content's natural height
 * instead of shrinking to the resized percentage — the resize handle still
 * computed and applied correct `sizes`/`flex-basis` values throughout, but
 * `.workspace-tabs.mod-top` had no `min-height: 0`, so its default
 * `min-height: auto` (a flex item's default — "never shrink below your
 * content's intrinsic height") silently overrode the assigned share. Only
 * ever visible with content tall enough to hit that floor: every existing
 * split/resize test used one-line `# Title`-style content, and this file's
 * own `splitActiveLeaf("vertical")` calls above are actually horizontal
 * (side-by-side) splits in disguise — `splitActiveLeaf`'s `_direction`
 * parameter is unused; it's a horizontal-only facade over `addGroup` — so
 * none of them exercised the stacked/column-flex layout this bug lives in.
 * `Workspace.splitGroup(target, "bottom", ratio)` is used directly here to
 * get a genuine vertical (column-direction) split.
 */
test("a vertical split with tall content still shrinks to its resized share", async () => {
  await window.evaluate(async () => {
    const app = (window as any).app;
    const tallBody = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n\n");
    const tall = await app.vault.create("Tall.md", `# Tall\n\n${tallBody}`);
    await app.openFile(tall, false);
    const short = await app.vault.create("Short.md", "# Short");
    const group = app.workspace.groups[0];
    const target = app.workspace.splitGroup(group, "bottom", 0.5);
    app.workspace.setActiveGroup(target);
    await app.openFile(short, false);
  });
  await expect(window.locator(".workspace-center .workspace-split.mod-vertical:not(.mod-root)")).toHaveCount(1);

  const handle = window.getByRole("separator");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  // Drag the divider most of the way down: the tall-content (top) pane
  // should end up with a *small* share despite its content wanting far more
  // room than that.
  await handle.dispatchEvent("pointerdown", { clientX: box!.x + 2, clientY: box!.y + 2, pointerId: 9 });
  // Drag UP (smaller clientY) to shrink the leading (top) pane's share.
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 80, pointerId: 9 })));
  await handle.dispatchEvent("pointerup", { clientY: 80, pointerId: 9 });

  const result = await window.evaluate(() => {
    const panes = [...document.querySelectorAll<HTMLElement>(".workspace-center .workspace-tabs")];
    const containerHeight = document.querySelector(".workspace-center .workspace-split.mod-vertical:not(.mod-root)")!.getBoundingClientRect().height;
    return {
      heights: panes.map((pane) => pane.getBoundingClientRect().height),
      sizes: (window as any).app.workspace.serialize().center.root.sizes,
      containerHeight,
    };
  });
  // `attachResize`'s own 240px-minimum-pane clamp is the floor here (240px
  // of an ~800px-tall window), not a target this test picked.
  expect(result.sizes[0]).toBeLessThan(0.32);
  // The bug: the tall pane refused to shrink below its content's intrinsic
  // height (hundreds of lines — far more than 30% of an 800px window) and
  // rendered close to `containerHeight`, starving the short pane down near
  // zero. Fixed, it tracks its assigned share within a few px of rounding.
  expect(result.heights[0]).toBeLessThanOrEqual(result.containerHeight * 0.37);
  expect(result.heights[0]).toBeCloseTo(result.containerHeight * result.sizes[0], -1);
});

test("three panes retain unrelated shares and persisted sizes restore after restart", async () => {
  const saved = await window.evaluate(async () => {
    const app = (window as any).app;
    const workspace = app.workspace;
    const first = await app.vault.create("First.md", "# First");
    await app.openFile(first, false);
    workspace.splitActiveLeafWithRatio("vertical", 0.3);
    const second = await app.vault.create("Second.md", "# Second");
    await app.openFile(second, false);
    workspace.setActiveGroup(workspace.groups[1]);
    workspace.splitActiveLeafWithRatio("vertical", 0.5);
    const third = await app.vault.create("Third.md", "# Third");
    await app.openFile(third, false);
    const state = workspace.serialize();
    await (window as any).hostServices.config.write("workspace", state);
    return state.center.root.sizes;
  });
  await window.reload();
  await window.waitForSelector(".workspace");
  const restored = await window.evaluate(() => (window as any).app.workspace.serialize().center.root.sizes);
  expect(saved[0]).toBeCloseTo(0.3, 6);
  expect(saved[1]).toBeCloseTo(0.35, 6);
  expect(saved[2]).toBeCloseTo(0.35, 6);
  expect(restored).toEqual(saved);
  await expect(window.locator(".workspace-center .workspace-center-resize-handle")).toHaveCount(2);
});

test("removing first, middle, and last panes keeps sizes aligned after resize", async () => {
  const result = await window.evaluate(() => {
    const workspace = (window as any).app.workspace;
    // `centerRoot` collapses to a lone (wrapper-less) TabGroup once only one
    // pane remains, so it has no `.sizes` array at all then — the natural
    // equivalent of the old flat `centerGroupSizes === [1]` is "one group,
    // 100% implied share".
    const sizesOf = () => Array.isArray(workspace.centerRoot?.sizes) ? [...workspace.centerRoot.sizes] : [1];
    workspace.splitActiveLeafWithRatio("vertical", 0.4);
    workspace.setActiveGroup(workspace.groups[1]);
    workspace.splitActiveLeafWithRatio("vertical", 0.5);
    workspace.centerRoot.sizes = [0.2, 0.3, 0.5];
    const snapshots: number[][] = [];
    workspace.groupEmptied(workspace.groups[1]);
    snapshots.push(sizesOf());
    workspace.groupEmptied(workspace.groups[0]);
    snapshots.push(sizesOf());
    workspace.splitActiveLeaf("vertical");
    workspace.groupEmptied(workspace.groups[1]);
    snapshots.push(sizesOf());
    return snapshots;
  });
  expect(result[0][0]).toBeCloseTo(2 / 7, 6);
  expect(result[0][1]).toBeCloseTo(5 / 7, 6);
  expect(result[1]).toEqual([1]);
  expect(result[2]).toEqual([1]);
});
