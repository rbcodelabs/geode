import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Direction = "top" | "right" | "bottom" | "left";
type Geometry = { x: number; y: number; width: number; height: number };

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function geometry(node: Locator): Promise<Geometry> {
  return node.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return {
      x: Number.parseFloat(style.left),
      y: Number.parseFloat(style.top),
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
}

async function expectGeometryClose(node: Locator, expected: Geometry): Promise<void> {
  const actual = await geometry(node);
  expect(actual.x).toBeCloseTo(expected.x, 4);
  expect(actual.y).toBeCloseTo(expected.y, 4);
  expect(actual.width).toBeCloseTo(expected.width, 4);
  expect(actual.height).toBeCloseTo(expected.height, 4);
}

async function beginEdgeResize(page: Page, node: Locator, direction: Direction): Promise<{ x: number; y: number }> {
  const handle = node.locator(`.canvas-node-resize-edge[data-direction="${direction}"]`);
  const box = (await handle.boundingBox())!;
  const start = direction === "left" || direction === "right"
    ? { x: box.x + box.width / 2, y: box.y + box.height / 4 }
    : { x: box.x + box.width / 4, y: box.y + box.height / 2 };
  const hit = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    return {
      className: target?.className ?? null,
      direction: target?.closest(".canvas-node-resize-edge")?.getAttribute("data-direction") ?? null,
      nodeId: target?.closest(".canvas-node")?.getAttribute("data-node-id") ?? null,
    };
  }, start);
  expect(hit.direction, JSON.stringify(hit)).toBe(direction);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return start;
}

test("resizes every Canvas node type from directional border handles", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-edge-resize-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-edge-resize-user-"));
  const canvasPath = path.join(vaultDir, "Edge resize.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "text", type: "text", x: 100, y: 100, width: 240, height: 120, text: "Text", color: "1", vendorText: { keep: [1] } },
      { id: "file", type: "file", x: 500, y: 100, width: 180, height: 120, file: "Note.md", color: "2", vendorFile: { keep: [2] } },
      { id: "link", type: "link", x: 100, y: 350, width: 200, height: 100, url: "https://example.com/", color: "3", vendorLink: { keep: [3] } },
      { id: "group", type: "group", x: 450, y: 340, width: 240, height: 160, label: "Group", color: "4", vendorGroup: { keep: [4] } },
    ],
    edges: [{
      id: "edge-1", fromNode: "text", fromSide: "top", fromEnd: "none",
      toNode: "file", toSide: "left", toEnd: "arrow", color: "6", vendorEdge: { keep: true },
    }],
  };
  const initialText = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(canvasPath, initialText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Edge resize.canvas"]').click();
    let view = window.locator(".canvas-view");
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__edgeResizeWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Edge resize.canvas") (window as any).__edgeResizeWrites += 1;
        return modify(file, data);
      };
    });

    await view.locator('[data-canvas-action="fit"]').click();
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    const scale = Number(camera.scale);
    expect(scale).not.toBe(1);

    for (const id of ["text", "file", "link", "group"]) {
      const node = view.locator(`.canvas-node[data-node-id="${id}"]`);
      await expect(node.locator(".canvas-node-resize-handle")).toHaveCount(1);
      await expect(node.locator(".canvas-node-resize-edge")).toHaveCount(4);
      for (const direction of ["top", "right", "bottom", "left"] as const) {
        await expect(node.locator(`.canvas-node-resize-edge[data-direction="${direction}"]`)).toHaveCount(1);
      }
    }

    const text = view.locator('.canvas-node[data-node-id="text"]');
    const edge = view.locator('.canvas-edge[data-edge-id="edge-1"]');
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    const edgeBefore = await edge.getAttribute("d");
    let diskBefore = fs.readFileSync(canvasPath, "utf8");
    let start = await beginEdgeResize(window, text, "left");
    await expect(text).toHaveClass(/is-selected/);
    await expect(edge).not.toHaveClass(/is-selected/);

    // Plain left resizing moves the dragged boundary and keeps the right edge fixed.
    await window.mouse.move(start.x + 60 * scale, start.y);
    await expectGeometryClose(text, { x: 160, y: 100, width: 180, height: 120 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);

    // Shift dynamically derives both dimensions from the original geometry,
    // retaining the opposite horizontal edge and vertical center.
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x + 60 * scale, start.y);
    await expectGeometryClose(text, { x: 160, y: 115, width: 180, height: 90 });
    await window.keyboard.up("Shift");
    await window.mouse.move(start.x + 60 * scale, start.y);
    await expectGeometryClose(text, { x: 160, y: 100, width: 180, height: 120 });
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x + 60 * scale, start.y);
    await expectGeometryClose(text, { x: 160, y: 115, width: 180, height: 90 });
    expect(await edge.getAttribute("d")).not.toBe(edgeBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "text")?.x ?? null).toBeCloseTo(160, 4);
    expect(await window.evaluate(() => (window as any).__edgeResizeWrites)).toBe(1);

    // Right plain resize keeps x/y fixed and changes width only.
    const file = view.locator('.canvas-node[data-node-id="file"]');
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await beginEdgeResize(window, file, "right");
    await window.mouse.move(start.x + 40 * scale, start.y);
    await expectGeometryClose(file, { x: 500, y: 100, width: 220, height: 120 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "file")?.width ?? null).toBeCloseTo(220, 4);

    // Top Shift resize is vertically driven, fixes the bottom edge, and
    // adjusts width symmetrically around the original horizontal center.
    const link = view.locator('.canvas-node[data-node-id="link"]');
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await beginEdgeResize(window, link, "top");
    await window.mouse.move(start.x, start.y + 30 * scale);
    await expectGeometryClose(link, { x: 100, y: 380, width: 200, height: 70 });
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x, start.y + 30 * scale);
    await expectGeometryClose(link, { x: 130, y: 380, width: 140, height: 70 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "link")?.height ?? null).toBeCloseTo(70, 4);

    // Bottom plain resize fixes the origin and changes height only.
    const group = view.locator('.canvas-node[data-node-id="group"]');
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await beginEdgeResize(window, group, "bottom");
    await window.mouse.move(start.x, start.y + 50 * scale);
    await expectGeometryClose(group, { x: 450, y: 340, width: 240, height: 210 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();

    // Ratio-preserving left shrink clamps on both minimum dimensions without
    // moving the fixed right edge or drifting the original vertical center.
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await beginEdgeResize(window, text, "left");
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x + 400 * scale, start.y);
    await expectGeometryClose(text, { x: 240, y: 135, width: 100, height: 50 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "text")?.width ?? null).toBeCloseTo(100, 4);
    expect(await window.evaluate(() => (window as any).__edgeResizeWrites)).toBe(5);

    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    for (const id of ["text", "file", "link", "group"]) {
      const before = initial.nodes.find((node) => node.id === id)!;
      const after = saved.nodes.find((node: { id: string }) => node.id === id);
      expect(after.color).toBe(before.color);
      expect(after[`vendor${id[0].toUpperCase()}${id.slice(1)}`]).toEqual(before[`vendor${id[0].toUpperCase()}${id.slice(1)}`]);
    }
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Edge resize.canvas"]').click();
    view = window.locator(".canvas-view");
    await expectGeometryClose(view.locator('.canvas-node[data-node-id="text"]'), { x: 240, y: 135, width: 100, height: 50 });
    await expectGeometryClose(view.locator('.canvas-node[data-node-id="file"]'), { x: 500, y: 100, width: 220, height: 120 });
    await expectGeometryClose(view.locator('.canvas-node[data-node-id="link"]'), { x: 130, y: 380, width: 140, height: 70 });
    await expectGeometryClose(view.locator('.canvas-node[data-node-id="group"]'), { x: 450, y: 340, width: 240, height: 210 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(persistedText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
