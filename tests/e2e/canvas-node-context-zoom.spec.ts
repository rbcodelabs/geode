import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Point = { x: number; y: number };
type Camera = { scale: string | null; panX: string | null; panY: string | null };

async function camera(view: Locator): Promise<Camera> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function worldToScreen(view: Locator, surface: Locator, point: Point): Promise<Point> {
  const box = (await surface.boundingBox())!;
  const current = await camera(view);
  return {
    x: box.x + Number(current.panX) + point.x * Number(current.scale),
    y: box.y + Number(current.panY) + point.y * Number(current.scale),
  };
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

async function shiftDigit2(page: Page, surface: Locator): Promise<void> {
  await surface.focus();
  await page.keyboard.down("Shift");
  await page.keyboard.press("Digit2");
  await page.keyboard.up("Shift");
}

test("Canvas node context menu zooms to the preserved or newly selected nodes", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-node-context-zoom-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-node-context-zoom-user-"));
  const canvasPath = path.join(vaultDir, "Node context zoom.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "group", type: "group", x: -600, y: -400, width: 300, height: 200, label: "Far group", vendorGroup: { keep: true } },
      { id: "link", type: "link", x: -250, y: -350, width: 200, height: 100, url: "https://example.com/", vendorLink: { keep: true } },
      { id: "file", type: "file", x: 900, y: 700, width: 200, height: 160, file: "Note.md", vendorFile: { keep: true } },
      { id: "text", type: "text", x: 400, y: 250, width: 240, height: 140, text: "Editable", vendorText: { keep: true } },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "text",
      fromSide: "right",
      fromEnd: "none",
      toNode: "file",
      toSide: "left",
      toEnd: "arrow",
      label: "Endpoints",
      vendorEdge: { keep: true },
    }],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Node context zoom.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    const diskBefore = fs.readFileSync(canvasPath, "utf8");

    // Establish a non-default camera, marquee-select a group plus a link, and
    // capture Shift+2 as the exact geometry oracle for the context action.
    await view.locator('[data-canvas-action="fit"]').click();
    await marquee(window, view, surface, { x: -650, y: -450 }, { x: 0, y: -180 });
    const multiSelection = ["group", "link"];
    expect(await selectedIds(view)).toEqual(multiSelection);
    await shiftDigit2(window, surface);
    const shortcutCamera = await camera(view);
    await view.locator('[data-canvas-action="zoom-in"]').click();
    expect(await camera(view)).not.toEqual(shortcutCamera);

    const group = view.locator('.canvas-node[data-node-id="group"]');
    await group.click({ button: "right", position: { x: 40, y: 40 } });
    await expect(window.locator(".context-menu-item")).toHaveText(["Zoom to selection"]);
    expect(await selectedIds(view)).toEqual(multiSelection);
    await window.locator(".context-menu-item", { hasText: "Zoom to selection" }).click();
    expect(await camera(view)).toEqual(shortcutCamera);
    expect(await selectedIds(view)).toEqual(multiSelection);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);

    // Right-clicking an unselected node creates a sole in-memory selection and
    // clears an edge selection without invoking z-order persistence.
    const edgeHit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
    await edgeHit.dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    const file = view.locator('.canvas-node[data-node-id="file"]');
    const cameraBeforeUnselectedMenu = await camera(view);
    await file.click({ button: "right", position: { x: 40, y: 40 } });
    expect(await selectedIds(view)).toEqual(["file"]);
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual(cameraBeforeUnselectedMenu);
    await expect(window.locator(".context-menu-item")).toHaveText(["Zoom to selection"]);
    await window.locator(".context-menu-item", { hasText: "Zoom to selection" }).click();
    expect(await selectedIds(view)).toEqual(["file"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);

    // Existing edge and empty-surface context behavior stays exact.
    await edgeHit.dispatchEvent("contextmenu", { clientX: 100, clientY: 100 });
    await expect(window.locator(".context-menu-item")).toHaveText(["Edit label", "Go to target", "Go to source", "Remove"]);
    await window.locator(".context-menu-item", { hasText: "Go to source" }).dispatchEvent("click");
    await expect(window.locator(".context-menu-item")).toHaveCount(0);
    await surface.click({ button: "right", position: { x: 10, y: 10 } });
    await expect(window.locator(".context-menu-item")).toHaveCount(0);

    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes).toEqual(initial.nodes);
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Node context zoom.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    expect(await camera(view)).toEqual({ scale: "1", panX: "80", panY: "80" });
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
