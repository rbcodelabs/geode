import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Point = { x: number; y: number };

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
  await expect(view.locator(".canvas-marquee")).toBeVisible();
  await page.mouse.up();
}

async function geometry(node: Locator): Promise<Point> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

test("moves the selected non-group Canvas set with dynamic Shift axis constraint", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selected-drag-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selected-drag-user-"));
  const canvasPath = path.join(vaultDir, "Selected drag.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "group", type: "group", x: 50, y: 50, width: 350, height: 140, label: "Selected group", vendorGroup: { keep: true } },
      { id: "alpha", type: "text", x: 80, y: 80, width: 120, height: 80, text: "Alpha", vendorNode: { source: "alpha", deep: [1, { keep: true }] } },
      { id: "beta", type: "file", x: 260, y: 100, width: 120, height: 80, file: "Note.md", vendorNode: { source: "beta", deep: [2, { keep: true }] } },
      { id: "outside", type: "link", x: 450, y: 100, width: 160, height: 90, url: "https://example.com/", vendorOutside: { deep: [3, { keep: true }] } },
    ],
    edges: [
      {
        id: "edge-1",
        fromNode: "alpha",
        fromSide: "right",
        fromEnd: "none",
        toNode: "beta",
        toSide: "left",
        toEnd: "arrow",
        label: "Internal",
        color: "4",
        vendorEdge: { kind: "internal", deep: true },
      },
      {
        id: "edge-2",
        fromNode: "beta",
        fromSide: "right",
        fromEnd: "none",
        toNode: "outside",
        toSide: "left",
        toEnd: "arrow",
        vendorEdge: { kind: "incident", deep: true },
      },
    ],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Selected drag.canvas"]').click();
    let view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 50, surfaceBox.y + surfaceBox.height - 60);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 80, surfaceBox.y + surfaceBox.height - 85);
    await window.mouse.up({ button: "middle" });
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    expect(Number(camera.scale)).toBe(1.2);

    await marquee(window, view, surface, { x: 40, y: 40 }, { x: 390, y: 190 });
    expect(await selectedIds(view)).toEqual(["alpha", "beta", "group"]);
    const alpha = view.locator('.canvas-node[data-node-id="alpha"]');
    const beta = view.locator('.canvas-node[data-node-id="beta"]');
    const group = view.locator('.canvas-node[data-node-id="group"]');
    const outside = view.locator('.canvas-node[data-node-id="outside"]');
    const internalEdge = view.locator('.canvas-edge[data-edge-id="edge-1"]');
    const incidentEdge = view.locator('.canvas-edge[data-edge-id="edge-2"]');
    const internalPathBefore = await internalEdge.getAttribute("d");
    const incidentPathBefore = await incidentEdge.getAttribute("d");
    let diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");

    // A +72,+48 screen displacement at 1.2 zoom is +60,+40 world units.
    // Dragging an already-selected card moves every selected non-group card.
    let box = (await alpha.boundingBox())!;
    let start = { x: box.x + 24, y: box.y + 24 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 72, start.y + 48);
    expect(await geometry(beta)).toEqual({ x: 320, y: 140 });
    expect(await geometry(alpha)).toEqual({ x: 140, y: 120 });
    expect(await geometry(group)).toEqual({ x: 50, y: 50 });
    expect(await geometry(outside)).toEqual({ x: 450, y: 100 });
    expect(await selectedIds(view)).toEqual(["alpha", "beta", "group"]);
    expect(await internalEdge.getAttribute("d")).not.toBe(internalPathBefore);
    expect(await incidentEdge.getAttribute("d")).not.toBe(incidentPathBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.up();
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "beta").x).toBeCloseTo(320, 4);

    // Shift uses the dominant displacement dynamically. From one drag origin,
    // the same selected set first constrains horizontally, then vertically.
    diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");
    box = (await beta.boundingBox())!;
    start = { x: box.x + 24, y: box.y + 24 };
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 72, start.y + 24);
    expect(await geometry(alpha)).toEqual({ x: 200, y: 120 });
    expect(await geometry(beta)).toEqual({ x: 380, y: 140 });
    expect(await geometry(group)).toEqual({ x: 50, y: 50 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.move(start.x + 24, start.y + 72);
    expect(await geometry(alpha)).toEqual({ x: 140, y: 180 });
    expect(await geometry(beta)).toEqual({ x: 320, y: 200 });
    expect(await geometry(group)).toEqual({ x: 50, y: 50 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "alpha").y).toBeCloseTo(180, 4);

    // Dragging a card outside the selection replaces it and moves it alone.
    diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");
    box = (await outside.boundingBox())!;
    start = { x: box.x + 5, y: box.y + 5 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 36, start.y + 24);
    expect(await selectedIds(view)).toEqual(["outside"]);
    expect(await geometry(outside)).toEqual({ x: 480, y: 120 });
    expect(await geometry(alpha)).toEqual({ x: 140, y: 180 });
    expect(await geometry(beta)).toEqual({ x: 320, y: 200 });
    expect(await geometry(group)).toEqual({ x: 50, y: 50 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.up();
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "outside").x).toBeCloseTo(480, 4);

    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "alpha").vendorNode).toEqual(initial.nodes[1].vendorNode);
    expect(saved.nodes.find((node: { id: string }) => node.id === "beta").vendorNode).toEqual(initial.nodes[2].vendorNode);
    expect(saved.nodes.find((node: { id: string }) => node.id === "outside").vendorOutside).toEqual(initial.nodes[3].vendorOutside);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Selected drag.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="alpha"]')).toHaveCSS("left", "140px");
    await expect(view.locator('.canvas-node[data-node-id="alpha"]')).toHaveCSS("top", "180px");
    await expect(view.locator('.canvas-node[data-node-id="beta"]')).toHaveCSS("left", "320px");
    await expect(view.locator('.canvas-node[data-node-id="beta"]')).toHaveCSS("top", "200px");
    await expect(view.locator('.canvas-node[data-node-id="outside"]')).toHaveCSS("left", "480px");
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(persistedText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
