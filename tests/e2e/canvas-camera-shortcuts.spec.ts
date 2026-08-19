import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
type Camera = { scale: string | null; panX: string | null; panY: string | null };

async function camera(view: Locator): Promise<Camera> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function expectedFit(surface: Locator, bounds: Bounds): Promise<{ scale: number; panX: number; panY: number }> {
  const size = await surface.evaluate((element) => ({
    width: (element as HTMLElement).clientWidth,
    height: (element as HTMLElement).clientHeight,
  }));
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(4, Math.max(0.2, Math.min((size.width - 160) / width, (size.height - 160) / height)));
  return {
    scale,
    panX: size.width / 2 - (bounds.left + width / 2) * scale,
    panY: size.height / 2 - (bounds.top + height / 2) * scale,
  };
}

async function expectCamera(view: Locator, expected: { scale: number; panX: number; panY: number }): Promise<void> {
  expect(Number(await view.getAttribute("data-scale"))).toBeCloseTo(expected.scale, 8);
  expect(Number(await view.getAttribute("data-pan-x"))).toBeCloseTo(expected.panX, 8);
  expect(Number(await view.getAttribute("data-pan-y"))).toBeCloseTo(expected.panY, 8);
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

async function shortcut(page: Page, surface: Locator, code: "Digit1" | "Digit2"): Promise<void> {
  await surface.focus();
  await page.keyboard.down("Shift");
  await page.keyboard.press(code);
  await page.keyboard.up("Shift");
}

test("Canvas camera shortcuts fit content, selected nodes, and edge endpoints", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-camera-shortcuts-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-camera-shortcuts-user-"));
  const canvasPath = path.join(vaultDir, "Camera shortcuts.canvas");
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
      color: "3",
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

    await window.locator('.nav-file-title[data-path="Camera shortcuts.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    const diskBefore = fs.readFileSync(canvasPath, "utf8");

    // Capture the existing button as the exact zoom-to-fit oracle.
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width / 2 - 70, surfaceBox.y + surfaceBox.height / 2 + 45);
    await window.mouse.up({ button: "middle" });
    await view.locator('[data-canvas-action="fit"]').click();
    const buttonFit = await camera(view);
    await view.locator('[data-canvas-action="zoom-in"]').click();
    expect(await camera(view)).not.toEqual(buttonFit);
    await shortcut(window, surface, "Digit1");
    expect(await camera(view)).toEqual(buttonFit);
    expect(await selectedIds(view)).toEqual([]);

    // The transformed marquee selects a group and a link. Shift+Digit2 fits
    // their union without changing the selection.
    await marquee(window, view, surface, { x: -650, y: -450 }, { x: 0, y: -180 });
    const nodeSelection = ["group", "link"];
    expect(await selectedIds(view)).toEqual(nodeSelection);
    await view.locator('[data-canvas-action="zoom-in"]').click();
    await shortcut(window, surface, "Digit2");
    await expectCamera(view, await expectedFit(surface, { left: -600, top: -400, right: -50, bottom: -200 }));
    expect(await selectedIds(view)).toEqual(nodeSelection);

    // Edge-only selection fits the two endpoint cards and remains edge-only.
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    await view.locator('[data-canvas-action="reset"]').click();
    await shortcut(window, surface, "Digit2");
    await expectCamera(view, await expectedFit(surface, { left: 400, top: 250, right: 1100, bottom: 860 }));
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);

    // With no valid selection, Shift+Digit2 is an exact camera no-op.
    await surface.click({ position: { x: 10, y: 10 } });
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const noSelectionCamera = await camera(view);
    await shortcut(window, surface, "Digit2");
    expect(await camera(view)).toEqual(noSelectionCamera);

    // The existing input/contenteditable guard prevents either shortcut while
    // a text-card editor owns focus, even though Shift+Digit1 produces "!".
    const textNode = view.locator('.canvas-node[data-node-id="text"]');
    await textNode.dblclick();
    const editor = view.locator(".canvas-node-text-editor");
    await expect(editor).toBeFocused();
    const inputGuardCamera = await camera(view);
    const inputGuardSelection = await selectedIds(view);
    await window.keyboard.down("Shift");
    await window.keyboard.press("Digit1");
    await window.keyboard.up("Shift");
    expect(await camera(view)).toEqual(inputGuardCamera);
    expect(await selectedIds(view)).toEqual(inputGuardSelection);
    await window.keyboard.press("Escape");

    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "link").vendorLink).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "file").vendorFile).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "text").vendorText).toEqual({ keep: true });

    await window.reload();
    await window.locator('.nav-file-title[data-path="Camera shortcuts.canvas"]').click();
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
