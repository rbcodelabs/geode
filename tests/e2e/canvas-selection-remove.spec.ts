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

async function marquee(view: Locator, surface: Locator, page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const box = (await surface.boundingBox())!;
  const scale = Number(await view.getAttribute("data-scale"));
  const panX = Number(await view.getAttribute("data-pan-x"));
  const panY = Number(await view.getAttribute("data-pan-y"));
  const screen = (point: { x: number; y: number }) => ({
    x: box.x + panX + point.x * scale,
    y: box.y + panY + point.y * scale,
  });
  const a = screen(from);
  const b = screen(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function installWriteCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__canvasRemoveWrites = 0;
    const modify = w.app.vault.modify.bind(w.app.vault);
    w.app.vault.modify = async (file: { path: string }, data: string) => {
      if (file.path === "Remove.canvas") w.__canvasRemoveWrites += 1;
      return modify(file, data);
    };
  });
}

async function expectRemoveControl(view: Locator): Promise<Locator> {
  const controls = view.locator(".canvas-selection-controls");
  await expect(controls).toHaveCount(1);
  await expect(controls.getByRole("button", { name: "Set color", exact: true })).toHaveCount(1);
  const remove = controls.getByRole("button", { name: "Remove", exact: true });
  await expect(remove).toHaveCount(1);
  await expect(remove).toHaveAttribute("title", "Remove");
  await expect(remove).toHaveText("");
  await expect(remove.locator("svg")).toHaveCount(1);
  return remove;
}

test("removes selected Canvas nodes or edge from the floating controls", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-remove-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-remove-user-"));
  const canvasPath = path.join(vaultDir, "Remove.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 180, height: 100, text: "A", color: "1", vendorA: { keep: true } },
      { id: "b", type: "group", x: 220, y: 0, width: 200, height: 120, label: "B", color: "tomato", vendorB: ["keep"] },
      { id: "keeper", type: "text", x: 560, y: 0, width: 180, height: 100, text: "Keeper", color: "3", vendorKeeper: true },
      { id: "other", type: "text", x: 560, y: 260, width: 180, height: 100, text: "Other", vendorOther: { deep: [1] } },
      { id: "last", type: "text", x: 900, y: 260, width: 180, height: 100, text: "Last", color: "#123456", vendorLast: "keep" },
    ],
    edges: [
      { id: "edge-ab", fromNode: "a", toNode: "b", color: "1", vendorInternal: true },
      { id: "edge-a-keeper", fromNode: "a", toNode: "keeper", vendorAEdge: { keep: true } },
      { id: "edge-b-other", fromNode: "b", toNode: "other", vendorBEdge: ["keep"] },
      { id: "edge-remove", fromNode: "keeper", fromSide: "bottom", toNode: "other", toSide: "top", color: "5", label: "Remove me", vendorRemove: { deep: true } },
      { id: "edge-keep", fromNode: "other", toNode: "last", color: "6", label: "Keep me", vendorKeep: [1, 2] },
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

    await window.locator('.nav-file-title[data-path="Remove.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const nodeCamera = await camera(view);
    await installWriteCounter(window);

    // A transformed marquee selects both nodes without persistence. The
    // floating controls expose Set color plus one icon-only Remove action.
    await marquee(view, surface, window, { x: -20, y: -20 }, { x: 440, y: 140 });
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(2);
    const beforeNodeRemove = fs.readFileSync(canvasPath, "utf8");
    const removeNodes = await expectRemoveControl(view);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeNodeRemove);
    expect(await window.evaluate(() => (window as any).__canvasRemoveWrites)).toBe(0);

    await removeNodes.click();
    const expectedNodesAfterRemove = initial.nodes.filter((node) => !["a", "b"].includes(node.id));
    const expectedEdgesAfterRemove = initial.edges.filter((edge) => !["a", "b"].includes(edge.fromNode) && !["a", "b"].includes(edge.toNode));
    await expect.poll(() => readCanvas(canvasPath)?.nodes.map((node: { id: string }) => node.id) ?? null)
      .toEqual(expectedNodesAfterRemove.map((node) => node.id));
    expect(await window.evaluate(() => (window as any).__canvasRemoveWrites)).toBe(1);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(await camera(view)).toEqual(nodeCamera);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes).toEqual(expectedNodesAfterRemove);
    expect(saved.edges).toEqual(expectedEdgesAfterRemove);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Remove.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator(".canvas-node")).toHaveCount(3);
    await expect(view.locator(".canvas-edge")).toHaveCount(2);
    await expect(view.locator(".canvas-selection-controls")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);

    // The same control removes only a selected edge, persists once, clears
    // selection/controls, and leaves all node and other-edge data exact.
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const edgeCamera = await camera(view);
    await installWriteCounter(window);
    await view.locator('.canvas-edge-hit[data-edge-id="edge-remove"]').dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-remove"]')).toHaveClass(/is-selected/);
    const beforeEdgeRemove = fs.readFileSync(canvasPath, "utf8");
    const removeEdge = await expectRemoveControl(view);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeEdgeRemove);
    expect(await window.evaluate(() => (window as any).__canvasRemoveWrites)).toBe(0);

    await removeEdge.click();
    await expect.poll(() => readCanvas(canvasPath)?.edges.map((edge: { id: string }) => edge.id) ?? null).toEqual(["edge-keep"]);
    expect(await window.evaluate(() => (window as any).__canvasRemoveWrites)).toBe(1);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(await camera(view)).toEqual(edgeCamera);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes).toEqual(expectedNodesAfterRemove);
    expect(saved.edges).toEqual([initial.edges.find((edge) => edge.id === "edge-keep")]);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Remove.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator(".canvas-node")).toHaveCount(3);
    await expect(view.locator(".canvas-edge")).toHaveCount(1);
    await expect(view.locator(".canvas-selection-controls")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
