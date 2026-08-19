import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const contextActions = ["Add note from vault", "Add media from vault", "Add web page", "Create group"];

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<{ scale: number; panX: number; panY: number }> {
  return {
    scale: Number(await view.getAttribute("data-scale")),
    panX: Number(await view.getAttribute("data-pan-x")),
    panY: Number(await view.getAttribute("data-pan-y")),
  };
}

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

async function openEmptyMenu(page: Page, surface: Locator): Promise<{ x: number; y: number }> {
  const box = (await surface.boundingBox())!;
  const point = { x: Math.round(box.x + box.width * 0.78), y: Math.round(box.y + box.height * 0.74) };
  await page.mouse.click(point.x, point.y, { button: "right" });
  return point;
}

async function expectedWorld(view: Locator, surface: Locator, point: { x: number; y: number }) {
  const box = (await surface.boundingBox())!;
  const transform = await camera(view);
  return {
    x: (point.x - box.x - transform.panX) / transform.scale,
    y: (point.y - box.y - transform.panY) / transform.scale,
  };
}

async function expectCentered(node: Locator, world: { x: number; y: number }, width: number, height: number) {
  const geometry = await node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
  expect(geometry.width).toBe(width);
  expect(geometry.height).toBe(height);
  expect(geometry.x + geometry.width / 2).toBeCloseTo(world.x, 3);
  expect(geometry.y + geometry.height / 2).toBeCloseTo(world.y, 3);
}

async function panCreatedCardAway(page: Page, surface: Locator): Promise<void> {
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.35);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, Math.round(box.width * 0.45));
  await page.keyboard.up("Shift");
}

test("authors Canvas cards and groups from the exact empty-surface context menu", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-empty-context-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-empty-context-user-"));
  const canvasPath = path.join(vaultDir, "Context authoring.canvas");
  fs.writeFileSync(path.join(vaultDir, "Context note.md"), "# Context note\n\nSafe **Markdown**.\n");
  fs.writeFileSync(path.join(vaultDir, "Context image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "source", type: "text", x: 0, y: 0, width: 180, height: 100, text: "Source", vendorSource: { keep: true } },
      { id: "target", type: "text", x: 320, y: 0, width: 180, height: 100, text: "Target", vendorTarget: ["keep"] },
    ],
    edges: [{
      id: "edge-1", fromNode: "source", fromSide: "right", fromEnd: "none",
      toNode: "target", toSide: "left", toEnd: "arrow", vendorEdge: { keep: true },
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

    await window.locator('.nav-file-title[data-path="Context authoring.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    const menuItems = window.locator(".context-menu-item");

    // Node and edge context menus remain exact and never leak authoring actions.
    await view.locator('.canvas-node[data-node-id="source"]').dispatchEvent("contextmenu", { clientX: 120, clientY: 120 });
    await expect(menuItems).toHaveText(["Zoom to selection", "Convert to file…", "Delete"]);
    await window.keyboard.press("Escape");
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("contextmenu", { clientX: 300, clientY: 130 });
    await expect(menuItems).toHaveText(["Edit label", "Go to target", "Go to source", "Remove"]);
    await window.keyboard.press("Escape");

    await view.locator('[data-canvas-action="zoom-in"]').click();
    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    const selectionBeforeCancel = await selectedIds(view);
    const cameraBeforeCancel = await camera(view);
    const diskBeforeCancel = fs.readFileSync(canvasPath, "utf8");

    // Every empty-surface authoring path is cancel-safe, including the right
    // click itself: selection, camera, memory, and disk remain unchanged.
    for (const action of contextActions) {
      await openEmptyMenu(window, surface);
      await expect(menuItems).toHaveText(contextActions);
      await menuItems.filter({ hasText: new RegExp(`^${action}$`) }).click();
      await expect(window.locator(".prompt-input")).toBeFocused();
      await window.keyboard.press("Escape");
      expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeCancel);
      expect(await selectedIds(view)).toEqual(selectionBeforeCancel);
      expect(await camera(view)).toEqual(cameraBeforeCancel);
      await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length);
    }

    // Note placement is the transformed context point, not viewport center.
    let point = await openEmptyMenu(window, surface);
    let world = await expectedWorld(view, surface, point);
    await menuItems.filter({ hasText: /^Add note from vault$/ }).click();
    await window.locator(".prompt-input").fill("Context note.md");
    await window.locator(".prompt-result", { hasText: "Context note.md" }).click();
    const note = view.locator('.canvas-node[data-node-id="file-1"]');
    await expect(note.locator(".canvas-node-note h1")).toHaveText("Context note");
    await expectCentered(note, world, 360, 280);
    await panCreatedCardAway(window, surface);

    // Media placement uses the same captured transformed context point.
    point = await openEmptyMenu(window, surface);
    world = await expectedWorld(view, surface, point);
    await menuItems.filter({ hasText: /^Add media from vault$/ }).click();
    await window.locator(".prompt-input").fill("Context image.png");
    await window.locator(".prompt-result", { hasText: "Context image.png" }).click();
    const media = view.locator('.canvas-node[data-node-id="file-2"]');
    await expect(media.locator("img.canvas-node-media")).toHaveAttribute("src", /^blob:/);
    await expectCentered(media, world, 360, 240);
    await panCreatedCardAway(window, surface);

    // Web URLs normalize exactly and groups ignore selected-card bounds when
    // invoked from empty space, using the context point and default size.
    point = await openEmptyMenu(window, surface);
    world = await expectedWorld(view, surface, point);
    await menuItems.filter({ hasText: /^Add web page$/ }).click();
    await window.locator(".prompt-input").fill(" HTTPS://Example.COM:443/context ");
    await window.locator(".prompt-input").press("Enter");
    const link = view.locator('.canvas-node[data-node-id="link-1"]');
    await expect(link.locator(".canvas-node-web-url")).toHaveText("https://example.com/context");
    await expectCentered(link, world, 360, 180);
    await panCreatedCardAway(window, surface);

    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    point = await openEmptyMenu(window, surface);
    world = await expectedWorld(view, surface, point);
    await menuItems.filter({ hasText: /^Create group$/ }).click();
    await window.locator(".prompt-input").fill("  Context group  ");
    await window.locator(".prompt-input").press("Enter");
    const group = view.locator('.canvas-node[data-node-id="group-1"]');
    await expect(group.locator(".canvas-group-label")).toHaveText("Context group");
    await expectCentered(group, world, 400, 300);

    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(6);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.filter((node: { id: string }) => ["source", "target"].includes(node.id))).toEqual(initial.nodes);
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.nodes.filter((node: { id: string }) => node.id.startsWith("file-")).map((node: { id: string }) => node.id)).toEqual(["file-1", "file-2"]);
    expect(saved.nodes.find((node: { id: string }) => node.id === "link-1").url).toBe("https://example.com/context");
    expect(saved.nodes.find((node: { id: string }) => node.id === "group-1").label).toBe("Context group");
    const cameraBeforeReload = await camera(view);
    expect(cameraBeforeReload).not.toEqual({ scale: 1, panX: 80, panY: 80 });

    await window.reload();
    await window.locator('.nav-file-title[data-path="Context authoring.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-node[data-node-id="file-1"] .canvas-node-note h1')).toHaveText("Context note");
    await expect(view.locator('.canvas-node[data-node-id="file-2"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="link-1"] .canvas-node-web-url')).toHaveText("https://example.com/context");
    await expect(view.locator('.canvas-node[data-node-id="group-1"] .canvas-group-label')).toHaveText("Context group");
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual({ scale: 1, panX: 80, panY: 80 });
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);

    // Toolbar actions remain singleton entry points after reload.
    for (const label of ["Add note from vault", "Add media from vault", "Add web page", "Add group"]) {
      await expect(view.getByRole("button", { name: label })).toHaveCount(1);
    }
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
