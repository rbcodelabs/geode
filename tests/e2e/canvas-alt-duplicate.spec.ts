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

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

test("Alt-drag duplicates selected non-group Canvas nodes and their internal edges", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-alt-duplicate-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-alt-duplicate-user-"));
  const canvasPath = path.join(vaultDir, "Duplicate.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const initial = {
    vendorCanvas: { keep: { deeply: true } },
    nodes: [
      { id: "selection-group", type: "group", x: 60, y: 50, width: 340, height: 140, label: "Selection", vendorGroup: { keep: true } },
      { id: "alpha", type: "text", x: 80, y: 80, width: 120, height: 80, text: "Alpha", color: "4", vendorNode: { source: "alpha", deep: [1, { keep: true }] } },
      { id: "beta", type: "file", x: 240, y: 80, width: 120, height: 80, file: "Note.md", subpath: "#Note", vendorNode: { source: "beta", deep: [2, { keep: true }] } },
      { id: "alpha-copy", type: "text", x: 500, y: 260, width: 100, height: 70, text: "Occupied copy id", vendorOccupied: true },
      { id: "outside", type: "link", x: 660, y: 80, width: 160, height: 90, url: "https://example.com/", vendorOutside: { keep: true } },
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
        color: "5",
        label: "Internal",
        vendorEdge: { kind: "internal", deep: [1, 2] },
      },
      {
        id: "edge-2",
        fromNode: "beta",
        fromSide: "right",
        fromEnd: "none",
        toNode: "outside",
        toSide: "left",
        toEnd: "arrow",
        vendorEdge: { kind: "crossing" },
      },
      {
        id: "edge-3",
        fromNode: "outside",
        toNode: "alpha-copy",
        vendorEdge: { kind: "occupied-id" },
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

    await window.locator('.nav-file-title[data-path="Duplicate.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
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
    const diskBefore = fs.readFileSync(canvasPath, "utf8");

    await marquee(window, view, surface, { x: 40, y: 40 }, { x: 390, y: 180 });
    expect(await selectedIds(view)).toEqual(["alpha", "beta", "selection-group"]);

    const alpha = view.locator('.canvas-node[data-node-id="alpha"]');
    let alphaBox = (await alpha.boundingBox())!;
    let dragStart = { x: alphaBox.x + 30, y: alphaBox.y + 30 };

    // An Alt gesture that never crosses the drag threshold neither duplicates
    // nor persists, and leaves the original selection intact.
    await window.keyboard.down("Alt");
    await window.mouse.move(dragStart.x, dragStart.y);
    await window.mouse.down();
    await window.mouse.move(dragStart.x + 2, dragStart.y + 2);
    await window.mouse.up();
    await window.keyboard.up("Alt");
    expect(await selectedIds(view)).toEqual(["alpha", "beta", "selection-group"]);
    await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length);
    await expect(view.locator(".canvas-edge")).toHaveCount(initial.edges.length);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);

    alphaBox = (await alpha.boundingBox())!;
    dragStart = { x: alphaBox.x + 30, y: alphaBox.y + 30 };
    await window.keyboard.down("Alt");
    await window.mouse.move(dragStart.x, dragStart.y);
    await window.mouse.down();
    await window.mouse.move(dragStart.x + 72, dragStart.y + 48);

    // At 1.2 zoom this is exactly a +60,+40 world delta. Only cloned
    // non-group cards are selected and their internal edge renders live.
    const cloneIds = await selectedIds(view);
    expect(cloneIds).toHaveLength(2);
    expect(cloneIds).not.toContain("alpha");
    expect(cloneIds).not.toContain("beta");
    expect(cloneIds).not.toContain("selection-group");
    await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length + 2);
    await expect(view.locator(".canvas-edge")).toHaveCount(initial.edges.length + 1);
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
    const cloneGeometry = await view.locator(".canvas-node.is-selected").evaluateAll((nodes) => nodes
      .map((element) => {
        const node = element as HTMLElement;
        return { id: node.dataset.nodeId!, x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top) };
      })
      .sort((a, b) => a.x - b.x));
    expect(cloneGeometry.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 140, y: 120 }, { x: 300, y: 120 }]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.mouse.up();
    await window.keyboard.up("Alt");
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.length).toBe(initial.nodes.length + 2);
    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);

    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    for (const original of initial.nodes) {
      expect(saved.nodes.find((node: { id: string }) => node.id === original.id)).toEqual(original);
    }
    expect(saved.edges.slice(0, initial.edges.length)).toEqual(initial.edges);
    expect(new Set(saved.nodes.map((node: { id: string }) => node.id)).size).toBe(saved.nodes.length);
    expect(new Set(saved.edges.map((edge: { id: string }) => edge.id)).size).toBe(saved.edges.length);

    const clones = saved.nodes.filter((node: { id: string }) => !initial.nodes.some((original) => original.id === node.id));
    const alphaClone = clones.find((node: { vendorNode?: { source?: string } }) => node.vendorNode?.source === "alpha");
    const betaClone = clones.find((node: { vendorNode?: { source?: string } }) => node.vendorNode?.source === "beta");
    expect(alphaClone).toEqual({ ...initial.nodes[1], id: alphaClone.id, x: alphaClone.x, y: alphaClone.y });
    expect(betaClone).toEqual({ ...initial.nodes[2], id: betaClone.id, x: betaClone.x, y: betaClone.y });
    expect(alphaClone.x).toBeCloseTo(140, 4);
    expect(alphaClone.y).toBeCloseTo(120, 4);
    expect(betaClone.x).toBeCloseTo(300, 4);
    expect(betaClone.y).toBeCloseTo(120, 4);
    expect(betaClone.x - alphaClone.x).toBe(160);
    expect(betaClone.y - alphaClone.y).toBe(0);
    expect(alphaClone.id).not.toBe("alpha-copy");

    const clonedEdges = saved.edges.slice(initial.edges.length);
    expect(clonedEdges).toHaveLength(1);
    expect(clonedEdges[0]).toEqual({
      ...initial.edges[0],
      id: clonedEdges[0].id,
      fromNode: alphaClone.id,
      toNode: betaClone.id,
    });
    expect(clonedEdges[0].id).not.toBe("edge-1");
    expect(clonedEdges[0].id).not.toBe("edge-2");
    expect(clonedEdges[0].id).not.toBe("edge-3");
    expect(saved.edges.filter((edge: { fromNode: string; toNode: string }) =>
      edge.fromNode === betaClone.id && edge.toNode === "outside")).toHaveLength(0);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Duplicate.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length + 2);
    await expect(view.locator(".canvas-edge")).toHaveCount(initial.edges.length + 1);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    await expect(view.locator(`.canvas-node[data-node-id="${alphaClone.id}"]`)).toHaveCSS("left", "140px");
    await expect(view.locator(`.canvas-node[data-node-id="${betaClone.id}"]`)).toHaveCSS("left", "300px");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(persistedText);

    // Alt-dragging a card outside the current selection copies only that card;
    // its incident crossing edge is not eligible for duplication.
    const occupied = view.locator('.canvas-node[data-node-id="alpha-copy"]');
    const occupiedBox = (await occupied.boundingBox())!;
    const occupiedStart = { x: occupiedBox.x + 20, y: occupiedBox.y + 20 };
    const beforeSingleCopy = fs.readFileSync(canvasPath, "utf8");
    await window.keyboard.down("Alt");
    await window.mouse.move(occupiedStart.x, occupiedStart.y);
    await window.mouse.down();
    await window.mouse.move(occupiedStart.x + 24, occupiedStart.y + 12);
    const singleCloneIds = await selectedIds(view);
    expect(singleCloneIds).toHaveLength(1);
    expect(singleCloneIds[0]).not.toBe("alpha-copy");
    await expect(view.locator(".canvas-edge")).toHaveCount(initial.edges.length + 1);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeSingleCopy);
    await window.mouse.up();
    await window.keyboard.up("Alt");
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.length).toBe(initial.nodes.length + 3);
    const afterSingleCopy = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(afterSingleCopy.nodes.find((node: { id: string }) => node.id === singleCloneIds[0]).vendorOccupied).toBe(true);
    expect(afterSingleCopy.edges).toHaveLength(initial.edges.length + 1);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
