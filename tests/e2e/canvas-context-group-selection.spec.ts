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

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
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
    w.__contextGroupWrites = 0;
    const modify = w.app.vault.modify.bind(w.app.vault);
    w.app.vault.modify = async (file: { path: string }, data: string) => {
      if (file.path === "Context groups.canvas") w.__contextGroupWrites += 1;
      return modify(file, data);
    };
  });
}

async function geometry(node: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
}

test("creates padded Canvas groups from an eligible node context selection", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-context-group-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-context-group-user-"));
  const canvasPath = path.join(vaultDir, "Context groups.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "group-1", type: "group", x: 60, y: 60, width: 540, height: 280, label: "Existing backdrop", color: "1", vendorGroup1: { keep: true } },
      { id: "group-2", type: "group", x: 650, y: 0, width: 180, height: 140, label: "ID collision", vendorGroup2: ["keep"] },
      { id: "a", type: "text", x: 100, y: 100, width: 180, height: 100, text: "A", color: "2", vendorA: true },
      { id: "b", type: "text", x: 360, y: 180, width: 200, height: 120, text: "B", vendorB: { deep: [1, 2] } },
      { id: "keeper", type: "text", x: 800, y: 400, width: 180, height: 100, text: "Keeper", color: "5", vendorKeeper: "keep" },
    ],
    edges: [
      { id: "edge-1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", color: "3", vendorEdge1: { keep: true } },
      { id: "edge-2", fromNode: "b", toNode: "keeper", label: "Keep", vendorEdge2: ["deep"] },
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

    await window.locator('.nav-file-title[data-path="Context groups.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    const menuItems = window.locator(".context-menu-item");

    // Group, edge, and true-empty menus retain their existing exact contracts.
    await view.locator('.canvas-node[data-node-id="group-1"]').click({ button: "right", position: { x: 20, y: 20 } });
    await expect(menuItems).toHaveText(["Zoom to selection", "Delete"]);
    await view.locator(".view-header").click();
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("contextmenu", { clientX: 200, clientY: 150 });
    await expect(menuItems).toHaveText(["Edit label", "Go to target", "Go to source", "Remove"]);
    await view.locator(".view-header").click();
    await surface.click({ button: "right", position: { x: 10, y: 10 } });
    await expect(menuItems).toHaveText(["Add note from vault", "Add media from vault", "Add web page", "Create group"]);
    await view.locator(".view-header").click();

    // A transformed marquee selects two cards plus an existing group. The
    // eligible selected card menu exposes Create group immediately before Delete.
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    await marquee(view, surface, window, { x: 40, y: 40 }, { x: 620, y: 360 });
    expect(await selectedIds(view)).toEqual(["a", "b", "group-1"]);
    const diskBeforeCancel = fs.readFileSync(canvasPath, "utf8");
    await installWriteCounter(window);
    const a = view.locator('.canvas-node[data-node-id="a"]');
    await a.click({ button: "right", position: { x: 30, y: 30 } });
    await expect(menuItems).toHaveText(["Zoom to selection", "Convert to file…", "Create group", "Delete"]);
    expect(await selectedIds(view)).toEqual(["a", "b", "group-1"]);

    // Cancel is byte-, selection-, write-, and camera-inert.
    await menuItems.filter({ hasText: /^Create group$/ }).click();
    const prompt = window.locator(".prompt-input");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAttribute("placeholder", "Group label…");
    await prompt.fill("Cancelled");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeCancel);
    expect(await selectedIds(view)).toEqual(["a", "b", "group-1"]);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(await window.evaluate(() => (window as any).__contextGroupWrites)).toBe(0);

    // Successful context grouping filters out selected groups, trims the label,
    // uses exact 40-world-unit padding, inserts behind cards, and writes once.
    await a.click({ button: "right", position: { x: 30, y: 30 } });
    await menuItems.filter({ hasText: /^Create group$/ }).click();
    await prompt.fill("  Context selection  ");
    await prompt.press("Enter");
    const group3 = view.locator('.canvas-node[data-node-id="group-3"]');
    await expect(group3).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    await expect(group3.locator(".canvas-group-label")).toHaveText("Context selection");
    expect(await geometry(group3)).toEqual({ x: 60, y: 60, width: 540, height: 280 });
    expect(await camera(view)).toEqual(transformedCamera);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.some((node: { id: string }) => node.id === "group-3") ?? null).toBe(true);
    expect(await window.evaluate(() => (window as any).__contextGroupWrites)).toBe(1);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const originalIds = initial.nodes.map((node) => node.id);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.filter((node: { id: string }) => originalIds.includes(node.id))).toEqual(initial.nodes);
    expect(saved.edges).toEqual(initial.edges);
    const indexGroup3 = saved.nodes.findIndex((node: { id: string }) => node.id === "group-3");
    expect(indexGroup3).toBeLessThan(saved.nodes.findIndex((node: { id: string }) => node.id === "a"));
    expect(indexGroup3).toBeLessThan(saved.nodes.findIndex((node: { id: string }) => node.id === "b"));
    expect(saved.nodes[indexGroup3]).toEqual({
      id: "group-3", type: "group", x: 60, y: 60, width: 540, height: 280, label: "Context selection",
    });
    await group3.click({ button: "right", position: { x: 20, y: 20 } });
    await expect(menuItems).toHaveText(["Zoom to selection", "Delete"]);
    await view.locator(".view-header").click();

    await window.reload();
    await window.locator('.nav-file-title[data-path="Context groups.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="group-3"] .canvas-group-label')).toHaveText("Context selection");
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);

    // Right-clicking an unselected card makes it the sole eligible selection;
    // empty label creates a padded collision-safe group without label.
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const soleCamera = await camera(view);
    await installWriteCounter(window);
    const keeper = view.locator('.canvas-node[data-node-id="keeper"]');
    await keeper.click({ button: "right", position: { x: 30, y: 30 } });
    expect(await selectedIds(view)).toEqual(["keeper"]);
    await expect(menuItems).toHaveText(["Zoom to selection", "Convert to file…", "Create group", "Delete"]);
    await menuItems.filter({ hasText: /^Create group$/ }).click();
    await prompt.press("Enter");
    const group4 = view.locator('.canvas-node[data-node-id="group-4"]');
    await expect(group4).toHaveClass(/is-selected/);
    expect(await geometry(group4)).toEqual({ x: 760, y: 360, width: 260, height: 180 });
    expect(await camera(view)).toEqual(soleCamera);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.some((node: { id: string }) => node.id === "group-4") ?? null).toBe(true);
    expect(await window.evaluate(() => (window as any).__contextGroupWrites)).toBe(1);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const savedGroup4 = saved.nodes.find((node: { id: string }) => node.id === "group-4");
    expect(savedGroup4).toEqual({ id: "group-4", type: "group", x: 760, y: 360, width: 260, height: 180 });
    expect(Object.hasOwn(savedGroup4, "label")).toBe(false);
    expect(saved.nodes.filter((node: { id: string }) => originalIds.includes(node.id))).toEqual(initial.nodes);
    expect(saved.edges).toEqual(initial.edges);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Context groups.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="group-3"]')).toHaveCount(1);
    await expect(view.locator('.canvas-node[data-node-id="group-4"]')).toHaveCount(1);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
