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

async function selectedNodeIds(view: Locator): Promise<string[]> {
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

async function openPalette(view: Locator): Promise<Locator> {
  const controls = view.locator(".canvas-selection-controls");
  await controls.getByRole("button", { name: "Set color", exact: true }).click();
  const palette = view.locator(".canvas-color-palette");
  await expect(palette).toHaveCount(1);
  await expect(palette.getByRole("button")).toHaveCount(7);
  for (let index = 1; index <= 6; index += 1) {
    await expect(palette.getByRole("button", { name: `Color ${index}`, exact: true })).toHaveCount(1);
  }
  await expect(palette.getByRole("button", { name: "Custom color…", exact: true })).toHaveCount(1);
  return palette;
}

async function openCustomColor(view: Locator, page: Page): Promise<Locator> {
  const palette = await openPalette(view);
  await palette.getByRole("button", { name: "Custom color…", exact: true }).click();
  const prompt = page.locator(".prompt-input");
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveAttribute("placeholder", "CSS color…");
  return prompt;
}

test("colors selected Canvas nodes or edge through fixed selection controls", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-colors-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-colors-user-"));
  const canvasPath = path.join(vaultDir, "Colors.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 180, height: 100, text: "A", color: "1", vendorA: { keep: true } },
      { id: "b", type: "group", x: 220, y: 0, width: 200, height: 120, label: "B", color: "tomato", vendorB: ["keep"] },
      { id: "keeper", type: "text", x: 650, y: 260, width: 200, height: 120, text: "Keep", vendorKeeper: { deep: [1, 2] } },
    ],
    edges: [{
      id: "edge-1", fromNode: "a", fromSide: "right", fromEnd: "none",
      toNode: "keeper", toSide: "left", toEnd: "arrow", color: "2",
      label: "Keep edge", vendorEdge: { deep: true },
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

    await window.locator('.nav-file-title[data-path="Colors.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await expect(view.locator(".canvas-selection-controls, .canvas-color-palette")).toHaveCount(0);
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    const initialDisk = fs.readFileSync(canvasPath, "utf8");
    await window.evaluate(() => {
      const w = window as any;
      w.__canvasColorWrites = 0;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Colors.canvas") w.__canvasColorWrites += 1;
        return modify(file, data);
      };
    });

    // A transformed marquee selection shows one surface-anchored control,
    // never inside the transformed Canvas viewport.
    await marquee(view, surface, window, { x: -20, y: -20 }, { x: 440, y: 140 });
    expect(await selectedNodeIds(view)).toEqual(["a", "b"]);
    const controls = view.locator(".canvas-selection-controls");
    await expect(controls).toHaveCount(1);
    await expect(controls.getByRole("button", { name: "Set color", exact: true })).toHaveCount(1);
    await expect(view.locator(".canvas-viewport .canvas-selection-controls")).toHaveCount(0);
    expect(await controls.evaluate((element) => element.parentElement?.classList.contains("canvas-surface"))).toBe(true);

    const palette = await openPalette(view);
    await expect(view.locator(".canvas-viewport .canvas-color-palette")).toHaveCount(0);
    expect(await palette.evaluate((element) => element.parentElement?.classList.contains("canvas-selection-controls"))).toBe(true);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialDisk);
    expect(await window.evaluate(() => (window as any).__canvasColorWrites)).toBe(0);

    // A preset applies to every selected node, rerenders immediately, keeps
    // the selection/camera, and writes the Canvas exactly once.
    await palette.getByRole("button", { name: "Color 3", exact: true }).click();
    await expect(view.locator('.canvas-node[data-node-id="a"]')).toHaveAttribute("data-canvas-color", "3");
    await expect(view.locator('.canvas-node[data-node-id="b"]')).toHaveAttribute("data-canvas-color", "3");
    expect(await selectedNodeIds(view)).toEqual(["a", "b"]);
    await expect(controls).toHaveCount(1);
    await expect(view.locator(".canvas-color-palette")).toHaveCount(0);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.filter((node: { id: string }) => ["a", "b"].includes(node.id)).map((node: { color: string }) => node.color) ?? null).toEqual(["3", "3"]);
    expect(await window.evaluate(() => (window as any).__canvasColorWrites)).toBe(1);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes).toEqual(initial.nodes.map((node) => ["a", "b"].includes(node.id) ? { ...node, color: "3" } : node));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    // Selecting the edge clears node selection but retains the same one-button
    // control. Custom cancel and invalid values are byte/write inert.
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    expect(await selectedNodeIds(view)).toEqual([]);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(controls).toHaveCount(1);
    const beforeCustom = fs.readFileSync(canvasPath, "utf8");
    let prompt = await openCustomColor(view, window);
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeCustom);
    expect(await window.evaluate(() => (window as any).__canvasColorWrites)).toBe(1);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    for (const invalid of ["   ", "not-a-color"] ) {
      prompt = await openCustomColor(view, window);
      await prompt.fill(invalid);
      await prompt.press("Enter");
      await expect(window.locator(".notice", { hasText: "valid CSS color" }).last()).toBeVisible();
      expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeCustom);
      expect(await window.evaluate(() => (window as any).__canvasColorWrites)).toBe(1);
      await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
      expect(await camera(view)).toEqual(transformedCamera);
    }

    // A browser-valid custom color applies only to the selected edge.
    prompt = await openCustomColor(view, window);
    await prompt.fill("  #123456  ");
    await prompt.press("Enter");
    await expect.poll(() => readCanvas(canvasPath)?.edges[0]?.color ?? null).toBe("#123456");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveAttribute("style", /stroke:/);
    await expect(controls).toHaveCount(1);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(await window.evaluate(() => (window as any).__canvasColorWrites)).toBe(2);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes).toEqual(initial.nodes.map((node) => ["a", "b"].includes(node.id) ? { ...node, color: "3" } : node));
    expect(saved.edges).toEqual([{ ...initial.edges[0], color: "#123456" }]);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    // Surface click clears selection and removes both fixed UI elements
    // without mutating the persisted document or camera.
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.click(surfaceBox.x + surfaceBox.width - 20, surfaceBox.y + surfaceBox.height / 2);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    await expect(view.locator(".canvas-selection-controls, .canvas-color-palette")).toHaveCount(0);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Colors.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="a"]')).toHaveAttribute("data-canvas-color", "3");
    await expect(view.locator('.canvas-node[data-node-id="b"]')).toHaveAttribute("data-canvas-color", "3");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveAttribute("style", /stroke:/);
    await expect(view.locator(".canvas-selection-controls, .canvas-color-palette")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
