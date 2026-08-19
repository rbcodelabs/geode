import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function geometry(node: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
}

async function camera(view: Locator): Promise<Record<string, string | null>> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function resizeStart(view: Locator, page: Page, nodeId: string, selector: string): Promise<{ x: number; y: number; scale: number }> {
  const handle = view.locator(`.canvas-node[data-node-id="${nodeId}"] ${selector}`);
  const box = (await handle.boundingBox())!;
  const direction = await handle.getAttribute("data-direction");
  const point = direction === "left" || direction === "right"
    ? { x: box.x + box.width / 2, y: box.y + box.height / 4 }
    : direction === "top" || direction === "bottom"
      ? { x: box.x + box.width / 4, y: box.y + box.height / 2 }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return { ...point, scale: Number(await view.getAttribute("data-scale")) };
}

async function moveWorld(page: Page, start: { x: number; y: number; scale: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(start.x + dx * start.scale, start.y + dy * start.scale, { steps: 4 });
}

function expectBounds(actual: { x: number; y: number; width: number; height: number }, expected: { left: number; top: number; right: number; bottom: number }): void {
  expect(actual.x).toBeCloseTo(expected.left, 3);
  expect(actual.y).toBeCloseTo(expected.top, 3);
  expect(actual.x + actual.width).toBeCloseTo(expected.right, 3);
  expect(actual.y + actual.height).toBeCloseTo(expected.bottom, 3);
}

test("expands pointer-down containing groups around resized cards with dynamic Space bypass", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-resize-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-resize-user-"));
  const canvasPath = path.join(vaultDir, "Group resize.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "parent", type: "group", x: 60, y: 60, width: 200, height: 160, label: "Parent", color: "1", vendorParent: { keep: true } },
      { id: "card", type: "text", x: 100, y: 100, width: 120, height: 80, text: "Resize", color: "2", vendorCard: ["keep"] },
      { id: "parent-2", type: "group", x: 660, y: 60, width: 200, height: 160, label: "Parent 2", color: "3", vendorParent2: true },
      { id: "entered", type: "group", x: 690, y: 90, width: 140, height: 60, label: "Entered during resize", color: "4", vendorEntered: { keep: true } },
      { id: "card-2", type: "text", x: 700, y: 100, width: 120, height: 80, text: "Enter then leave", color: "5", vendorCard2: { keep: true } },
      { id: "keeper", type: "text", x: 1080, y: 180, width: 160, height: 100, text: "Keeper", color: "6", vendorKeeper: [1, 2] },
    ],
    edges: [
      { id: "parent-edge", fromNode: "parent", fromSide: "right", fromEnd: "none", toNode: "keeper", toSide: "left", toEnd: "arrow", color: "1", vendorParentEdge: true },
      { id: "card-edge", fromNode: "card", fromSide: "bottom", fromEnd: "none", toNode: "keeper", toSide: "top", toEnd: "arrow", color: "2", vendorCardEdge: { keep: true } },
    ],
  };
  const initialText = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(canvasPath, initialText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await window.locator('.nav-file-title[data-path="Group resize.canvas"]').click();
    let view = window.locator(".canvas-view");
    await window.evaluate(() => {
      const w = window as any;
      w.__groupResizeWrites = 0;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Group resize.canvas") w.__groupResizeWrites += 1;
        return modify(file, data);
      };
    });
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    const parent = () => view.locator('.canvas-node[data-node-id="parent"]');
    const card = () => view.locator('.canvas-node[data-node-id="card"]');
    const parentEdge = () => view.locator('.canvas-edge[data-edge-id="parent-edge"]');
    let diskBefore = fs.readFileSync(canvasPath, "utf8");

    // Space suppresses both peer snapping and containing-group expansion.
    // Releasing it during the same gesture catches the parent up around the
    // live resized bounds plus the established 40-world-unit padding.
    const edgeBefore = await parentEdge().getAttribute("d");
    let start = await resizeStart(view, window, "card", '.canvas-node-resize-edge[data-direction="right"]');
    await window.keyboard.down("Space");
    await moveWorld(window, start, 140, 0);
    expect(await geometry(card())).toEqual({ x: 100, y: 100, width: 260, height: 80 });
    expect(await geometry(parent())).toEqual({ x: 60, y: 60, width: 200, height: 160 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.keyboard.up("Space");
    await moveWorld(window, start, 141, 0);
    expectBounds(await geometry(parent()), { left: 60, top: 60, right: 401, bottom: 220 });
    expect(await parentEdge().getAttribute("d")).not.toBe(edgeBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => window.evaluate(() => (window as any).__groupResizeWrites)).toBe(1);

    // Southeast, left, and top handles expand only the required boundaries;
    // previously expanded boundaries never shrink.
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    const beforeSoutheast = await geometry(parent());
    start = await resizeStart(view, window, "card", ".canvas-node-resize-handle");
    await moveWorld(window, start, 70, 90);
    const afterSoutheastCard = await geometry(card());
    expectBounds(await geometry(parent()), {
      left: beforeSoutheast.x,
      top: beforeSoutheast.y,
      right: afterSoutheastCard.x + afterSoutheastCard.width + 40,
      bottom: afterSoutheastCard.y + afterSoutheastCard.height + 40,
    });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => window.evaluate(() => (window as any).__groupResizeWrites)).toBe(2);

    diskBefore = fs.readFileSync(canvasPath, "utf8");
    const beforeLeft = await geometry(parent());
    start = await resizeStart(view, window, "card", '.canvas-node-resize-edge[data-direction="left"]');
    await moveWorld(window, start, -100, 0);
    const afterLeftCard = await geometry(card());
    expectBounds(await geometry(parent()), {
      left: afterLeftCard.x - 40,
      top: beforeLeft.y,
      right: beforeLeft.x + beforeLeft.width,
      bottom: beforeLeft.y + beforeLeft.height,
    });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => window.evaluate(() => (window as any).__groupResizeWrites)).toBe(3);

    diskBefore = fs.readFileSync(canvasPath, "utf8");
    const beforeTop = await geometry(parent());
    start = await resizeStart(view, window, "card", '.canvas-node-resize-edge[data-direction="top"]');
    await moveWorld(window, start, 0, -90);
    const afterTopCard = await geometry(card());
    expectBounds(await geometry(parent()), {
      left: beforeTop.x,
      top: afterTopCard.y - 40,
      right: beforeTop.x + beforeTop.width,
      bottom: beforeTop.y + beforeTop.height,
    });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => window.evaluate(() => (window as any).__groupResizeWrites)).toBe(4);

    // A group that first contains the card only after the gesture begins is
    // never added to the stable pointer-down snapshot.
    const enteredBefore = await geometry(view.locator('.canvas-node[data-node-id="entered"]'));
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await resizeStart(view, window, "card-2", '.canvas-node-resize-edge[data-direction="bottom"]');
    await moveWorld(window, start, 0, -40);
    const containedMidGesture = await geometry(view.locator('.canvas-node[data-node-id="card-2"]'));
    expect(containedMidGesture.y + containedMidGesture.height).toBeLessThanOrEqual(enteredBefore.y + enteredBefore.height);
    expect(await geometry(view.locator('.canvas-node[data-node-id="entered"]'))).toEqual(enteredBefore);
    await moveWorld(window, start, 0, 100);
    const grownCard2 = await geometry(view.locator('.canvas-node[data-node-id="card-2"]'));
    const parent2 = await geometry(view.locator('.canvas-node[data-node-id="parent-2"]'));
    expect(parent2.y + parent2.height).toBeCloseTo(grownCard2.y + grownCard2.height + 40, 4);
    expect(await geometry(view.locator('.canvas-node[data-node-id="entered"]'))).toEqual(enteredBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => window.evaluate(() => (window as any).__groupResizeWrites)).toBe(5);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    for (const original of initial.nodes) {
      const current = saved.nodes.find((node: { id: string }) => node.id === original.id);
      for (const key of Object.keys(original).filter((key) => key.startsWith("vendor") || key === "color" || key === "text" || key === "label")) {
        expect(current[key]).toEqual((original as any)[key]);
      }
    }
    expect(saved.edges).toEqual(initial.edges);
    expect(await camera(view)).toEqual(transformedCamera);

    await window.reload();
    await expect.poll(() => window.evaluate(() => (window as any).app?.workspace?.layoutReady ?? false)).toBe(true);
    await window.locator('.nav-file-title[data-path="Group resize.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="parent"]')).toBeVisible();
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
