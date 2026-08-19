import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Point = { x: number; y: number };
type Geometry = Point & { width: number; height: number };

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

async function expectGeometry(node: Locator, expected: Geometry, precision = 4): Promise<void> {
  const actual = await geometry(node);
  expect(actual.x).toBeCloseTo(expected.x, precision);
  expect(actual.y).toBeCloseTo(expected.y, precision);
  expect(actual.width).toBeCloseTo(expected.width, precision);
  expect(actual.height).toBeCloseTo(expected.height, precision);
}

async function worldToScreen(view: Locator, surface: Locator, point: Point): Promise<Point> {
  const box = (await surface.boundingBox())!;
  const scale = Number(await view.getAttribute("data-scale"));
  const panX = Number(await view.getAttribute("data-pan-x"));
  const panY = Number(await view.getAttribute("data-pan-y"));
  return { x: box.x + panX + point.x * scale, y: box.y + panY + point.y * scale };
}

async function marquee(page: Page, view: Locator, surface: Locator, from: Point, to: Point): Promise<void> {
  const start = await worldToScreen(view, surface, from);
  const end = await worldToScreen(view, surface, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
}

async function beginResize(page: Page, node: Locator, direction: "right" | "southeast"): Promise<Point> {
  const handle = direction === "southeast"
    ? node.locator(".canvas-node-resize-handle")
    : node.locator('.canvas-node-resize-edge[data-direction="right"]');
  const box = (await handle.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return start;
}

test("snaps selected movement and active resize edges to peers with dynamic Space bypass", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-alignment-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-alignment-user-"));
  const canvasPath = path.join(vaultDir, "Alignment.canvas");
  const initial = {
    vendorCanvas: { preserve: true },
    nodes: [
      { id: "a", type: "text", x: 100, y: 100, width: 100, height: 80, text: "A", color: "1", vendorA: [1] },
      { id: "b", type: "text", x: 240, y: 120, width: 100, height: 80, text: "B", color: "2", vendorB: { keep: true } },
      { id: "peer", type: "text", x: 500, y: 300, width: 120, height: 100, text: "Peer", vendorPeer: "keep" },
      { id: "peer-2", type: "text", x: 700, y: 80, width: 100, height: 100, text: "Peer 2", vendorPeer2: [2] },
      { id: "resize", type: "text", x: 100, y: 500, width: 200, height: 100, text: "Resize", color: "3", vendorResize: { deep: [3] } },
      { id: "resize-peer", type: "text", x: 400, y: 490, width: 100, height: 120, text: "Resize peer", vendorResizePeer: true },
      { id: "corner-peer", type: "text", x: 600, y: 700, width: 100, height: 100, text: "Corner peer", vendorCorner: { keep: 4 } },
    ],
    edges: [{
      id: "edge-1", fromNode: "a", fromSide: "right", fromEnd: "none",
      toNode: "peer", toSide: "left", toEnd: "arrow", color: "6", vendorEdge: { keep: true },
    }],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await window.locator('.nav-file-title[data-path="Alignment.canvas"]').click();
    let view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="fit"]').click();
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    const scale = Number(camera.scale);
    expect(scale).not.toBe(1);
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__alignmentWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Alignment.canvas") (window as any).__alignmentWrites += 1;
        return modify(file, data);
      };
    });

    await marquee(window, view, surface, { x: 80, y: 80 }, { x: 350, y: 220 });
    const a = view.locator('.canvas-node[data-node-id="a"]');
    const b = view.locator('.canvas-node[data-node-id="b"]');
    const edge = view.locator('.canvas-edge[data-edge-id="edge-1"]');
    const edgeBefore = await edge.getAttribute("d");
    let diskBefore = fs.readFileSync(canvasPath, "utf8");
    let box = (await a.boundingBox())!;
    let start = { x: box.x + 20, y: box.y + 20 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();

    // Raw +156,+196 world units leaves the selected bounds four world units
    // from the peer's left/top anchors. It snaps to exact +160,+200 at the
    // transformed scale while preserving the selected cards' offset.
    await window.mouse.move(start.x + 156 * scale, start.y + 196 * scale);
    await expectGeometry(a, { x: 260, y: 300, width: 100, height: 80 });
    await expectGeometry(b, { x: 400, y: 320, width: 100, height: 80 });
    expect(await edge.getAttribute("d")).not.toBe(edgeBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(await window.evaluate(() => (window as any).__alignmentWrites)).toBe(0);

    // Space bypass is dynamic inside the same gesture; releasing it restores
    // the same closest-per-axis peer snap without changing the drag origin.
    await window.keyboard.down("Space");
    await window.mouse.move(start.x + 156 * scale + 0.1, start.y + 196 * scale + 0.1);
    await expectGeometry(a, { x: 256 + 0.1 / scale, y: 296 + 0.1 / scale, width: 100, height: 80 }, 2);
    await window.keyboard.up("Space");
    await window.mouse.move(start.x + 156 * scale + 0.2, start.y + 196 * scale + 0.2);
    await expectGeometry(a, { x: 260, y: 300, width: 100, height: 80 });
    await window.mouse.up();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "a")?.x ?? null).toBeCloseTo(260, 4);
    expect(await window.evaluate(() => (window as any).__alignmentWrites)).toBe(1);

    // Shift keeps its dominant-axis constraint, then horizontal peer snapping
    // applies. Space temporarily reveals the constrained unsnapped geometry.
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    box = (await a.boundingBox())!;
    start = { x: box.x + 20, y: box.y + 20 };
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 196 * scale, start.y + 50 * scale);
    await expectGeometry(a, { x: 460, y: 300, width: 100, height: 80 });
    await expectGeometry(b, { x: 600, y: 320, width: 100, height: 80 });
    await window.keyboard.down("Space");
    await window.mouse.move(start.x + 196 * scale + 0.1, start.y + 50 * scale);
    await expectGeometry(a, { x: 456 + 0.1 / scale, y: 300, width: 100, height: 80 }, 2);
    await window.keyboard.up("Space");
    await window.mouse.move(start.x + 196 * scale + 0.2, start.y + 50 * scale);
    await expectGeometry(a, { x: 460, y: 300, width: 100, height: 80 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "b")?.x ?? null).toBeCloseTo(600, 4);
    expect(await window.evaluate(() => (window as any).__alignmentWrites)).toBe(2);

    const resize = view.locator('.canvas-node[data-node-id="resize"]');
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await beginResize(window, resize, "right");
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x + 96 * scale, start.y);
    await expectGeometry(resize, { x: 100, y: 475, width: 300, height: 150 });
    await window.keyboard.down("Space");
    await window.mouse.move(start.x + 96 * scale + 0.1, start.y);
    await expectGeometry(resize, {
      x: 100,
      y: 476 - 0.025 / scale,
      width: 296 + 0.1 / scale,
      height: 148 + 0.05 / scale,
    }, 2);
    await window.keyboard.up("Space");
    await window.mouse.move(start.x + 96 * scale + 0.2, start.y);
    await expectGeometry(resize, { x: 100, y: 475, width: 300, height: 150 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "resize")?.width ?? null).toBeCloseTo(300, 4);
    expect(await window.evaluate(() => (window as any).__alignmentWrites)).toBe(3);

    // The southeast handle resolves both active edges independently. Space
    // bypasses and restores both snaps within the same transformed drag.
    diskBefore = fs.readFileSync(canvasPath, "utf8");
    start = await beginResize(window, resize, "southeast");
    await window.mouse.move(start.x + 196 * scale, start.y + 71 * scale);
    await expectGeometry(resize, { x: 100, y: 475, width: 500, height: 225 });
    await window.keyboard.down("Space");
    await window.mouse.move(start.x + 196 * scale + 0.1, start.y + 71 * scale + 0.1);
    await expectGeometry(resize, { x: 100, y: 475, width: 496 + 0.1 / scale, height: 221 + 0.1 / scale }, 2);
    await window.keyboard.up("Space");
    await window.mouse.move(start.x + 196 * scale + 0.2, start.y + 71 * scale + 0.2);
    await expectGeometry(resize, { x: 100, y: 475, width: 500, height: 225 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.mouse.up();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "resize")?.height ?? null).toBeCloseTo(225, 4);
    expect(await window.evaluate(() => (window as any).__alignmentWrites)).toBe(4);

    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    for (const original of initial.nodes) {
      const current = saved.nodes.find((node: { id: string }) => node.id === original.id);
      for (const [key, value] of Object.entries(original)) {
        if (!["x", "y", "width", "height"].includes(key)) expect(current[key]).toEqual(value);
      }
    }
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Alignment.canvas"]').click();
    view = window.locator(".canvas-view");
    await expectGeometry(view.locator('.canvas-node[data-node-id="a"]'), { x: 460, y: 300, width: 100, height: 80 });
    await expectGeometry(view.locator('.canvas-node[data-node-id="b"]'), { x: 600, y: 320, width: 100, height: 80 });
    await expectGeometry(view.locator('.canvas-node[data-node-id="resize"]'), { x: 100, y: 475, width: 500, height: 225 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(persistedText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
