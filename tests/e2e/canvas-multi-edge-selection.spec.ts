import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<{ scale: string | null; panX: string | null; panY: string | null }> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function pathPoint(pathLocator: Locator): Promise<{ x: number; y: number }> {
  return pathLocator.evaluate((element) => {
    const edge = element as SVGPathElement;
    const point = edge.getPointAtLength(edge.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(edge.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
}

async function clickEdge(page: Page, view: Locator, id: string, shift = false): Promise<void> {
  const hit = view.locator(`.canvas-edge-hit[data-edge-id="${id}"]`);
  const point = await pathPoint(hit);
  if (shift) await page.keyboard.down("Shift");
  try {
    await page.mouse.click(point.x, point.y);
  } finally {
    if (shift) await page.keyboard.up("Shift");
  }
}

async function selectedEdges(view: Locator): Promise<string[]> {
  return view.locator(".canvas-edge.is-selected").evaluateAll((edges) =>
    edges.map((edge) => (edge as HTMLElement).dataset.edgeId!).sort());
}

async function controlNames(view: Locator): Promise<string[]> {
  return view.locator(".canvas-selection-controls > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""));
}

test("selects and operates on multiple Canvas edges as one set", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-multi-edge-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-multi-edge-user-"));
  const canvasPath = path.join(vaultDir, "Multi edge.canvas");
  const initial = {
    vendorCanvas: { preserve: { deeply: true } },
    nodes: [
      { id: "a", type: "text", x: -900, y: -520, width: 220, height: 140, text: "A", vendorA: [1] },
      { id: "b", type: "text", x: 120, y: -80, width: 240, height: 160, text: "B", color: "2", vendorB: { keep: true } },
      { id: "c", type: "text", x: 1050, y: 620, width: 260, height: 180, text: "C", vendorC: "keep" },
      { id: "d", type: "text", x: -620, y: 760, width: 230, height: 150, text: "D", vendorD: true },
    ],
    edges: [
      { id: "edge-1", fromNode: "a", fromSide: "right", fromEnd: "none", toNode: "b", toSide: "left", toEnd: "arrow", label: "A to B", color: "1", vendorEdge1: { keep: 1 } },
      { id: "edge-2", fromNode: "b", fromSide: "right", fromEnd: "none", toNode: "c", toSide: "left", toEnd: "arrow", color: "2", vendorEdge2: [2] },
      { id: "edge-3", fromNode: "c", fromSide: "bottom", fromEnd: "none", toNode: "d", toSide: "right", toEnd: "arrow", label: "C to D", color: "3", vendorEdge3: "keep-3" },
      { id: "edge-4", fromNode: "d", fromSide: "top", fromEnd: "none", toNode: "a", toSide: "bottom", toEnd: "arrow", color: "4", vendorEdge4: { keep: 4 } },
      { id: "edge-5", fromNode: "a", fromSide: "top", fromEnd: "none", toNode: "c", toSide: "top", toEnd: "arrow", label: "Untouched", color: "5", vendorEdge5: ["survive"] },
    ],
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

    await window.locator('.nav-file-title[data-path="Multi edge.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasMultiEdgeWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Multi edge.canvas") (window as any).__canvasMultiEdgeWrites += 1;
        return modify(file, data);
      };
    });

    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + 80, surfaceBox.y + 80);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + 140, surfaceBox.y + 115);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);

    // First Shift-click normalizes a node selection to one edge. Further
    // Shift-clicks toggle membership without ever mixing node/edge selection.
    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(initial.nodes.length);
    await clickEdge(window, view, "edge-1", true);
    expect(await selectedEdges(view)).toEqual(["edge-1"]);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-1"]')).toHaveCount(2);
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);

    await clickEdge(window, view, "edge-2", true);
    expect(await selectedEdges(view)).toEqual(["edge-1", "edge-2"]);
    await expect(view.locator(".canvas-edge-endpoint-handle.is-selected")).toHaveCount(0);
    expect(await controlNames(view)).toEqual(["Set color", "Remove"]);
    await clickEdge(window, view, "edge-1", true);
    expect(await selectedEdges(view)).toEqual(["edge-2"]);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-2"]')).toHaveCount(2);
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);
    await clickEdge(window, view, "edge-2", true);
    expect(await selectedEdges(view)).toEqual([]);
    await expect(view.locator(".canvas-selection-controls")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__canvasMultiEdgeWrites)).toBe(0);

    // Plain click selects exactly one. Shift adds another and Shift+2 fits the
    // union of all endpoint nodes without changing selection or disk.
    await clickEdge(window, view, "edge-1");
    await clickEdge(window, view, "edge-2", true);
    expect(await selectedEdges(view)).toEqual(["edge-1", "edge-2"]);
    const beforeFit = fs.readFileSync(canvasPath, "utf8");
    await surface.focus();
    await window.keyboard.press("Shift+Digit2");
    const fitCamera = await camera(view);
    expect(fitCamera).not.toEqual(transformedCamera);
    const fittedSurface = (await surface.boundingBox())!;
    for (const id of ["a", "b", "c"]) {
      const box = (await view.locator(`.canvas-node[data-node-id="${id}"]`).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(fittedSurface.x - 1);
      expect(box.y).toBeGreaterThanOrEqual(fittedSurface.y - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(fittedSurface.x + fittedSurface.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(fittedSurface.y + fittedSurface.height + 1);
    }
    expect(await selectedEdges(view)).toEqual(["edge-1", "edge-2"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeFit);

    // Fixed and custom colors apply to the whole set in one write. The custom
    // prompt is prefilled only for a common selected-edge color.
    await view.getByRole("button", { name: "Set color" }).click();
    await view.getByRole("button", { name: "Color 6" }).click();
    await expect.poll(() => readCanvas(canvasPath)?.edges.slice(0, 2).map((edge: { color?: string }) => edge.color) ?? null).toEqual(["6", "6"]);
    expect(await window.evaluate(() => (window as any).__canvasMultiEdgeWrites)).toBe(1);
    expect(await selectedEdges(view)).toEqual(["edge-1", "edge-2"]);
    expect(await camera(view)).toEqual(fitCamera);

    await view.getByRole("button", { name: "Set color" }).click();
    await view.getByRole("button", { name: "Custom color…" }).click();
    let prompt = window.locator('.prompt-input[placeholder="CSS color…"]');
    await expect(prompt).toHaveValue("6");
    await prompt.press("Escape");
    await clickEdge(window, view, "edge-3", true);
    await view.getByRole("button", { name: "Set color" }).click();
    await view.getByRole("button", { name: "Custom color…" }).click();
    prompt = window.locator('.prompt-input[placeholder="CSS color…"]');
    await expect(prompt).toHaveValue("");
    await prompt.press("Escape");
    await clickEdge(window, view, "edge-3", true);

    await view.getByRole("button", { name: "Set color" }).click();
    await view.getByRole("button", { name: "Custom color…" }).click();
    prompt = window.locator('.prompt-input[placeholder="CSS color…"]');
    await prompt.fill("rebeccapurple");
    await prompt.press("Enter");
    await expect.poll(() => readCanvas(canvasPath)?.edges.slice(0, 2).map((edge: { color?: string }) => edge.color) ?? null).toEqual(["rebeccapurple", "rebeccapurple"]);
    expect(await window.evaluate(() => (window as any).__canvasMultiEdgeWrites)).toBe(2);
    let saved = readCanvas(canvasPath)!;
    expect(saved.nodes).toEqual(initial.nodes);
    expect(saved.edges[0]).toEqual({ ...initial.edges[0], color: "rebeccapurple" });
    expect(saved.edges[1]).toEqual({ ...initial.edges[1], color: "rebeccapurple" });
    expect(saved.edges.slice(2)).toEqual(initial.edges.slice(2));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    // Context and double-click normalize a multi-selection to one edge while
    // retaining their exact menu and inline-editor contracts.
    const edge1Hit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
    const edge1Point = await pathPoint(edge1Hit);
    await window.mouse.click(edge1Point.x, edge1Point.y, { button: "right" });
    expect(await selectedEdges(view)).toEqual(["edge-1"]);
    await expect(window.locator(".context-menu-item")).toHaveText(["Edit label", "Go to target", "Go to source", "Remove"]);
    await window.locator("body").dispatchEvent("mousedown");
    await clickEdge(window, view, "edge-2", true);
    const edge2Hit = view.locator('.canvas-edge-hit[data-edge-id="edge-2"]');
    await edge2Hit.dispatchEvent("dblclick");
    await expect(view.locator(".canvas-edge-label-editor")).toHaveCount(1);
    expect(await selectedEdges(view)).toEqual(["edge-2"]);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-2"]')).toHaveCount(2);
    await view.locator(".canvas-edge-label-editor").press("Escape");

    // Keyboard deletion removes the entire selected set in one write and
    // preserves every unaffected edge/node field and camera.
    await clickEdge(window, view, "edge-1", true);
    expect(await selectedEdges(view)).toEqual(["edge-1", "edge-2"]);
    await surface.focus();
    await window.keyboard.press("Delete");
    await expect.poll(() => readCanvas(canvasPath)?.edges.map((edge: { id: string }) => edge.id) ?? null).toEqual(["edge-3", "edge-4", "edge-5"]);
    expect(await window.evaluate(() => (window as any).__canvasMultiEdgeWrites)).toBe(3);
    await expect(view.locator(".canvas-edge.is-selected, .canvas-node.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(await camera(view)).toEqual(fitCamera);
    saved = readCanvas(canvasPath)!;
    expect(saved.nodes).toEqual(initial.nodes);
    expect(saved.edges).toEqual(initial.edges.slice(2));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    // Floating Remove also deletes all selected edges once, leaving one exact
    // unaffected edge and clearing selection/controls through reload.
    await clickEdge(window, view, "edge-3");
    await clickEdge(window, view, "edge-4", true);
    expect(await selectedEdges(view)).toEqual(["edge-3", "edge-4"]);
    expect(await controlNames(view)).toEqual(["Set color", "Remove"]);
    await expect(view.locator(".canvas-edge-endpoint-handle.is-selected")).toHaveCount(0);
    await view.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => readCanvas(canvasPath)?.edges.map((edge: { id: string }) => edge.id) ?? null).toEqual(["edge-5"]);
    expect(await window.evaluate(() => (window as any).__canvasMultiEdgeWrites)).toBe(4);
    await expect(view.locator(".canvas-edge.is-selected, .canvas-node.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(await camera(view)).toEqual(fitCamera);
    saved = readCanvas(canvasPath)!;
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes).toEqual(initial.nodes);
    expect(saved.edges).toEqual([initial.edges[4]]);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Multi edge.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-5"]')).toHaveCount(1);
    await expect(view.locator(".canvas-edge.is-selected, .canvas-node.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
