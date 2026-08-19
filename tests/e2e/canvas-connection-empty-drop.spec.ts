import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Point = { x: number; y: number };
type Camera = { scale: string | null; panX: string | null; panY: string | null };

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<Camera> {
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

async function beginConnection(page: Page, handle: Locator): Promise<void> {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

async function center(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("empty connection drops transactionally create an attached text card", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-empty-connection-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-empty-connection-user-"));
  const canvasPath = path.join(vaultDir, "Empty connection.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "source", type: "text", x: 20, y: 80, width: 220, height: 120, text: "Source", vendorSource: { keep: true } },
      { id: "target", type: "text", x: 400, y: 80, width: 220, height: 120, text: "Target", vendorTarget: { keep: true } },
      { id: "group", type: "group", x: -420, y: 420, width: 240, height: 160, label: "Group", vendorGroup: { keep: true } },
      { id: "text-1", type: "text", x: -300, y: -200, width: 180, height: 100, text: "Occupied one", vendorOne: true },
      { id: "text-2", type: "text", x: 50, y: -240, width: 180, height: 100, text: "Occupied two", vendorTwo: true },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "target",
      fromSide: "bottom",
      fromEnd: "none",
      toNode: "source",
      toSide: "bottom",
      toEnd: "arrow",
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

    await window.locator('.nav-file-title[data-path="Empty connection.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    let source = view.locator('.canvas-node[data-node-id="source"]');
    const initialText = fs.readFileSync(canvasPath, "utf8");

    // Establish a non-default camera and expose every non-group handle without
    // invoking the normal z-order-promoting node selection path.
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width * 0.75, surfaceBox.y + surfaceBox.height * 0.75);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width * 0.75 - 60, surfaceBox.y + surfaceBox.height * 0.75 + 35);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);
    expect(Number(transformedCamera.scale)).toBeGreaterThan(1);
    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    expect(await selectedIds(view)).toEqual(["group", "source", "target", "text-1", "text-2"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    const sourceRight = source.getByRole("button", { name: "Connect from right" });
    const drop = {
      x: surfaceBox.x + surfaceBox.width * 0.72,
      y: surfaceBox.y + surfaceBox.height * 0.78,
    };
    const expectedWorld = {
      x: (drop.x - surfaceBox.x - Number(transformedCamera.panX)) / Number(transformedCamera.scale),
      y: (drop.y - surfaceBox.y - Number(transformedCamera.panY)) / Number(transformedCamera.scale),
    };

    // Empty drop first offers the exact type chooser at the captured point;
    // choosing text starts the existing live card+edge transaction and keeps
    // disk byte-identical until that editor commits.
    await beginConnection(window, sourceRight);
    await window.mouse.move(drop.x, drop.y);
    await expect(view.locator(".canvas-edge-preview")).toBeVisible();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await window.mouse.up();
    await expect(window.locator(".context-menu-item")).toHaveText([
      "Add text card", "Add note from vault", "Add media from vault", "Add web page",
    ]);
    await expect(view.locator('.canvas-node[data-node-id="text-3"]')).toHaveCount(0);
    expect(await selectedIds(view)).toEqual(["source"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await window.locator(".context-menu-item", { hasText: /^Add text card$/ }).click();
    const pendingNode = view.locator('.canvas-node[data-node-id="text-3"]');
    const pendingEditor = pendingNode.locator(".canvas-node-text-editor");
    await expect(pendingEditor).toBeFocused();
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    expect(await selectedIds(view)).toEqual(["text-3"]);
    const pendingGeometry = await pendingNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(pendingGeometry.width).toBe(250);
    expect(pendingGeometry.height).toBe(140);
    expect(pendingGeometry.x + pendingGeometry.width / 2).toBeCloseTo(expectedWorld.x, 3);
    expect(pendingGeometry.y + pendingGeometry.height / 2).toBeCloseTo(expectedWorld.y, 3);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await camera(view)).toEqual(transformedCamera);

    // Escape rolls back both artifacts, restores the source selection, and
    // never writes the transient transaction.
    await pendingEditor.fill("must roll back");
    await pendingEditor.press("Escape");
    await expect(view.locator('.canvas-node[data-node-id="text-3"]')).toHaveCount(0);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(0);
    expect(await selectedIds(view)).toEqual(["source"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    // Reusing the collision-safe IDs and committing persists card and edge as
    // one document update with original arrays/extensions preserved.
    await beginConnection(window, source.getByRole("button", { name: "Connect from right" }));
    await window.mouse.move(drop.x, drop.y);
    await window.mouse.up();
    await window.locator(".context-menu-item", { hasText: /^Add text card$/ }).click();
    const committedNode = view.locator('.canvas-node[data-node-id="text-3"]');
    const committedEditor = committedNode.locator(".canvas-node-text-editor");
    await expect(committedEditor).toBeFocused();
    await committedEditor.fill("Attached **idea**");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await committedEditor.press("ControlOrMeta+Enter");
    await expect(committedNode.locator(".canvas-node-text strong")).toHaveText("idea");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length).toBe(initial.nodes.length + 1);
    await expect.poll(() => readCanvas(canvasPath)?.edges.length).toBe(initial.edges.length + 1);
    const committed = readCanvas(canvasPath)!;
    expect(committed.nodes.slice(0, initial.nodes.length)).toEqual(initial.nodes);
    expect(committed.edges.slice(0, initial.edges.length)).toEqual(initial.edges);
    expect(committed.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(committed.nodes.at(-1)).toMatchObject({
      id: "text-3",
      type: "text",
      width: 250,
      height: 140,
      text: "Attached **idea**",
    });
    expect(committed.edges.at(-1)).toEqual({
      id: "edge-2",
      fromNode: "source",
      fromSide: "right",
      fromEnd: "none",
      toNode: "text-3",
      toSide: "left",
      toEnd: "arrow",
    });
    expect(await camera(view)).toEqual(transformedCamera);

    // Dropping on any node body without a valid handle is a no-op, including
    // the source itself and a group body away from its connection handles.
    for (const body of [source, view.locator('.canvas-node[data-node-id="group"]'), view.locator('.canvas-node[data-node-id="target"]')]) {
      const beforeBodyDrop = fs.readFileSync(canvasPath, "utf8");
      await surface.focus();
      await window.keyboard.press("ControlOrMeta+a");
      await beginConnection(window, source.getByRole("button", { name: "Connect from right" }));
      const bodyCenter = await center(body);
      await window.mouse.move(bodyCenter.x, bodyCenter.y);
      await window.mouse.up();
      await expect(view.locator(".canvas-node-text-editor")).toHaveCount(0);
      expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeBodyDrop);
      await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length + 1);
      await expect(view.locator(".canvas-edge")).toHaveCount(initial.edges.length + 1);
    }

    // A valid other-card handle still creates the exact existing edge schema.
    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    await beginConnection(window, source.getByRole("button", { name: "Connect from right" }));
    const targetLeft = view.locator('.canvas-node[data-node-id="target"]').getByRole("button", { name: "Connect from left" });
    const targetPoint = await center(targetLeft);
    await window.mouse.move(targetPoint.x, targetPoint.y);
    await window.mouse.up();
    await expect.poll(() => readCanvas(canvasPath)?.edges.length).toBe(initial.edges.length + 2);
    expect(readCanvas(canvasPath)!.edges.at(-1)).toEqual({
      id: "edge-3",
      fromNode: "source",
      fromSide: "right",
      fromEnd: "none",
      toNode: "target",
      toSide: "left",
      toEnd: "arrow",
    });
    expect(await camera(view)).toEqual(transformedCamera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Empty connection.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-node[data-node-id="text-3"] .canvas-node-text strong')).toHaveText("idea");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-3"]')).toHaveCount(1);
    expect(await camera(view)).toEqual({ scale: "1", panX: "80", panY: "80" });
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    const reloaded = readCanvas(canvasPath)!;
    expect(reloaded.nodes.slice(0, initial.nodes.length)).toEqual(initial.nodes);
    expect(reloaded.edges.slice(0, initial.edges.length)).toEqual(initial.edges);
    expect(reloaded.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
