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
  await expect(window.locator(".workspace-center > .workspace-center-resize-handle")).toHaveCount(1);
});

test("center divider resizes adjacent panes, clamps them, and serializes the result", async () => {
  await window.evaluate(() => (window as any).app.workspace.splitActiveLeaf("vertical"));
  const handle = window.locator(".workspace-center > .workspace-center-resize-handle");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await handle.dispatchEvent("pointerdown", { clientX: box!.x + 2, clientY: box!.y + 2, pointerId: 1 });
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointermove", { clientX: -10_000, pointerId: 1 })));
  await window.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 })));
  const result = await window.evaluate(() => {
    const panes = [...document.querySelectorAll<HTMLElement>(".workspace-center > .workspace-tabs")];
    return {
      widths: panes.map((pane) => pane.getBoundingClientRect().width),
      sizes: (window as any).app.workspace.serialize().center.root.sizes,
    };
  });
  expect(Math.min(...result.widths)).toBeGreaterThanOrEqual(239);
  expect(result.sizes[0]).toBeLessThan(result.sizes[1]);
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await window.screenshot({ path: path.join(screenshotDir, "center-pane-resized.png") });
  }
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
  await expect(window.locator(".workspace-center > .workspace-center-resize-handle")).toHaveCount(2);
});
