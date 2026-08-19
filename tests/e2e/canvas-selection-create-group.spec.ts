import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<Record<string, string | null>> {
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

async function controlNames(view: Locator): Promise<string[]> {
  return view.locator(".canvas-selection-controls > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? ""));
}

async function marquee(
  page: Page,
  view: Locator,
  surface: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
  shift = false,
): Promise<void> {
  const box = (await surface.boundingBox())!;
  const scale = Number(await view.getAttribute("data-scale"));
  const panX = Number(await view.getAttribute("data-pan-x"));
  const panY = Number(await view.getAttribute("data-pan-y"));
  const screen = (point: { x: number; y: number }) => ({
    x: box.x + panX + point.x * scale,
    y: box.y + panY + point.y * scale,
  });
  const start = screen(from);
  const end = screen(to);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await expect(view.locator(".canvas-marquee")).toBeVisible();
  await page.mouse.up();
  await expect(view.locator(".canvas-marquee")).toHaveCount(0);
  if (shift) await page.keyboard.up("Shift");
}

async function geometry(node: Locator): Promise<Record<string, number>> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
}

test("creates a padded group from eligible multi-node floating controls", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-group-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-group-user-"));
  const canvasPath = path.join(vaultDir, "Selection group.canvas");
  const initial = {
    vendorCanvas: { preserve: { deep: true } },
    nodes: [
      { id: "group-1", type: "group", x: 500, y: 250, width: 250, height: 180, label: "Existing", color: "1", vendorGroup: [1] },
      { id: "a", type: "text", x: 50, y: 50, width: 120, height: 80, text: "A", color: "2", vendorA: { keep: true } },
      { id: "b", type: "text", x: 250, y: 100, width: 140, height: 100, text: "B", color: "3", vendorB: ["keep"] },
      { id: "keeper", type: "text", x: 820, y: 80, width: 160, height: 100, text: "Keeper", color: "4", vendorKeeper: true },
    ],
    edges: [
      { id: "edge", fromNode: "a", fromSide: "right", fromEnd: "none", toNode: "b", toSide: "left", toEnd: "arrow", color: "5", vendorEdge: { keep: true } },
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
    await expect(window.locator('.nav-file-title[data-path="Selection group.canvas"]')).toBeVisible();
    await window.evaluate(() => {
      const w = window as any;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.__selectionGroupWrites = 0;
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Selection group.canvas") w.__selectionGroupWrites += 1;
        return modify(file, data);
      };
    });

    await window.locator('.nav-file-title[data-path="Selection group.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);

    // A transformed card-only marquee is eligible and exposes the exact
    // three-action floating surface. Cancel remains entirely transient.
    await marquee(window, view, surface, { x: 35, y: 35 }, { x: 410, y: 220 });
    expect(await selectedIds(view)).toEqual(["a", "b"]);
    expect(await controlNames(view)).toEqual(["Set color", "Create group", "Remove"]);
    const diskBeforeCancel = fs.readFileSync(canvasPath, "utf8");
    await view.getByRole("button", { name: "Create group", exact: true }).click();
    const prompt = window.locator(".prompt-input");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAttribute("placeholder", "Group label…");
    await prompt.fill("Cancelled");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeCancel);
    expect(await window.evaluate(() => (window as any).__selectionGroupWrites)).toBe(0);
    expect(await selectedIds(view)).toEqual(["a", "b"]);
    expect(await camera(view)).toEqual(transformedCamera);

    // Shift-unioning a group makes the selection ineligible and rebuilds the
    // controls. Replacing it with the original card marquee rebuilds eligibility.
    await marquee(window, view, surface, { x: 480, y: 230 }, { x: 770, y: 450 }, true);
    expect(await selectedIds(view)).toEqual(["a", "b", "group-1"]);
    expect(await controlNames(view)).toEqual(["Set color", "Remove"]);
    await marquee(window, view, surface, { x: 35, y: 35 }, { x: 410, y: 220 });
    expect(await selectedIds(view)).toEqual(["a", "b"]);
    expect(await controlNames(view)).toEqual(["Set color", "Create group", "Remove"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeCancel);
    expect(await window.evaluate(() => (window as any).__selectionGroupWrites)).toBe(0);

    // Submit trims the optional label, applies exact 40-world-unit padding,
    // inserts behind the selected cards, writes once, and selects only group-2.
    await view.getByRole("button", { name: "Create group", exact: true }).click();
    await prompt.fill("  Selected cards  ");
    await prompt.press("Enter");
    const group2 = view.locator('.canvas-node[data-node-id="group-2"]');
    await expect(group2).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    await expect(group2.locator(".canvas-group-label")).toHaveText("Selected cards");
    expect(await geometry(group2)).toEqual({ x: 10, y: 10, width: 420, height: 230 });
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Set background", "Remove"]);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect.poll(() => window.evaluate(() => (window as any).__selectionGroupWrites)).toBe(1);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.some((node: { id: string }) => node.id === "group-2") ?? null).toBe(true);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.nodes.filter((node: { id: string }) => initial.nodes.some((original) => original.id === node.id)))
      .toEqual(initial.nodes);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(["group-1", "group-2", "a", "b", "keeper"]);
    expect(saved.nodes[1]).toEqual({
      id: "group-2", type: "group", x: 10, y: 10, width: 420, height: 230, label: "Selected cards",
    });

    await window.reload();
    await window.locator('.nav-file-title[data-path="Selection group.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-node[data-node-id="group-2"] .canvas-group-label')).toHaveText("Selected cards");
    await expect(view.locator(".canvas-node.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
