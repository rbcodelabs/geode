import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function pathPoint(pathLocator: Locator): Promise<{ x: number; y: number }> {
  return pathLocator.evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
}

async function selectEdge(page: Page, view: Locator, edgeId: string): Promise<void> {
  const hit = view.locator(`.canvas-edge-hit[data-edge-id="${edgeId}"]`);
  const point = await pathPoint(hit);
  await page.mouse.click(point.x, point.y);
  await expect(view.locator(`.canvas-edge[data-edge-id="${edgeId}"]`)).toHaveClass(/is-selected/);
}

async function dragHandle(page: Page, handle: Locator, point: { x: number; y: number }): Promise<void> {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".canvas-edge-preview")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".canvas-edge-preview")).toHaveCount(0);
}

test("reconnects selected Canvas edge endpoints and removes only on empty drop", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-reconnect-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-reconnect-user-"));
  const canvasPath = path.join(vaultDir, "Reconnect.canvas");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [
      { id: "source", type: "text", x: 20, y: 100, width: 180, height: 120, text: "Source", vendorSource: "keep" },
      { id: "target", type: "text", x: 260, y: 100, width: 160, height: 120, text: "Target", vendorTarget: "keep" },
      { id: "replacement", type: "text", x: 480, y: 100, width: 180, height: 140, text: "Replacement", vendorReplacement: "keep" },
      { id: "group", type: "group", x: 300, y: 380, width: 220, height: 120, label: "Invalid target", vendorGroup: "keep" },
    ],
    edges: [
      {
        id: "edge-1",
        fromNode: "replacement",
        fromSide: "bottom",
        fromEnd: "none",
        toNode: "source",
        toSide: "bottom",
        toEnd: "arrow",
        vendorKeeper: { keep: true },
      },
      {
        id: "edge-2",
        fromNode: "source",
        fromSide: "right",
        fromEnd: "none",
        toNode: "target",
        toSide: "left",
        toEnd: "arrow",
        label: "preserve me",
        color: "4",
        vendorReconnect: { keep: true },
      },
    ],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Reconnect.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 60, surfaceBox.y + surfaceBox.height - 70);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 90, surfaceBox.y + surfaceBox.height - 90);
    await window.mouse.up({ button: "middle" });
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    expect(Number(camera.scale)).not.toBe(1);

    await selectEdge(window, view, "edge-2");
    const sourceHandle = view.getByRole("button", { name: "Reconnect source of edge-2" });
    const targetHandle = view.getByRole("button", { name: "Reconnect target of edge-2" });
    await expect(view.locator('.canvas-edge-endpoint-handle[data-edge-id="edge-2"]')).toHaveCount(2);
    await expect(sourceHandle).toBeVisible();
    await expect(targetHandle).toBeVisible();

    // Reconnect target near the replacement's left boundary so the chosen
    // JSON Canvas side is deterministic under pan and zoom.
    const replacement = view.locator('.canvas-node[data-node-id="replacement"]');
    const replacementBox = (await replacement.boundingBox())!;
    await dragHandle(window, targetHandle, {
      x: replacementBox.x + 6,
      y: replacementBox.y + replacementBox.height / 2,
    });
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).edges.find((edge: { id: string }) => edge.id === "edge-2"))
      .toEqual({
        id: "edge-2",
        fromNode: "source",
        fromSide: "right",
        fromEnd: "none",
        toNode: "replacement",
        toSide: "left",
        toEnd: "arrow",
        label: "preserve me",
        color: "4",
        vendorReconnect: { keep: true },
      });
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    // Reconnect the source to the original target's right side. The target
    // endpoint must remain attached to replacement and all other fields stay
    // byte-for-byte equivalent.
    const originalTarget = view.locator('.canvas-node[data-node-id="target"]');
    const originalTargetBox = (await originalTarget.boundingBox())!;
    await dragHandle(window, sourceHandle, {
      x: originalTargetBox.x + originalTargetBox.width - 6,
      y: originalTargetBox.y + originalTargetBox.height / 2,
    });
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).edges.find((edge: { id: string }) => edge.id === "edge-2"))
      .toEqual({
        id: "edge-2",
        fromNode: "target",
        fromSide: "right",
        fromEnd: "none",
        toNode: "replacement",
        toSide: "left",
        toEnd: "arrow",
        label: "preserve me",
        color: "4",
        vendorReconnect: { keep: true },
      });
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    // Reload proves both reconnected endpoints, the same edge id, and every
    // non-endpoint field survive.
    await window.reload();
    await window.locator('.nav-file-title[data-path="Reconnect.canvas"]').click();
    const reloaded = window.locator(".canvas-view");
    await expect(reloaded.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    await expect(reloaded.locator('.canvas-edge-label[data-edge-id="edge-2"]')).toHaveText("preserve me");

    // Reconnecting source to the current target would make a self edge. It is
    // rejected unchanged, as is dropping onto a group.
    await reloaded.locator('.canvas-edge-hit[data-edge-id="edge-2"]').dispatchEvent("click");
    await expect(reloaded.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveClass(/is-selected/);
    const reloadedCamera = {
      scale: await reloaded.getAttribute("data-scale"),
      panX: await reloaded.getAttribute("data-pan-x"),
      panY: await reloaded.getAttribute("data-pan-y"),
    };
    const unchanged = fs.readFileSync(canvasPath, "utf8");
    const reloadedSourceHandle = reloaded.getByRole("button", { name: "Reconnect source of edge-2" });
    const replacementAfterReload = reloaded.locator('.canvas-node[data-node-id="replacement"]');
    let box = (await replacementAfterReload.boundingBox())!;
    await dragHandle(window, reloadedSourceHandle, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(unchanged);
    expect({
      scale: await reloaded.getAttribute("data-scale"),
      panX: await reloaded.getAttribute("data-pan-x"),
      panY: await reloaded.getAttribute("data-pan-y"),
    }).toEqual(reloadedCamera);
    const group = reloaded.locator('.canvas-node[data-node-id="group"]');
    box = (await group.boundingBox())!;
    await dragHandle(window, reloadedSourceHandle, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(unchanged);

    // Empty drop removes only the edited edge.
    const reloadedTargetHandle = reloaded.getByRole("button", { name: "Reconnect target of edge-2" });
    const reloadedSurface = reloaded.locator(".canvas-surface");
    const reloadedSurfaceBox = (await reloadedSurface.boundingBox())!;
    await dragHandle(window, reloadedTargetHandle, {
      x: reloadedSurfaceBox.x + 24,
      y: reloadedSurfaceBox.y + reloadedSurfaceBox.height - 24,
    });
    await expect(reloaded.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect(reloaded.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveCount(1);
    await expect(reloaded.locator(".canvas-node")).toHaveCount(4);
    expect({
      scale: await reloaded.getAttribute("data-scale"),
      panX: await reloaded.getAttribute("data-pan-x"),
      panY: await reloaded.getAttribute("data-pan-y"),
    }).toEqual(reloadedCamera);
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).edges.map((edge: { id: string }) => edge.id)).toEqual(["edge-1"]);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "source").vendorSource).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "target").vendorTarget).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "replacement").vendorReplacement).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toBe("keep");
    expect(saved.edges[0].vendorKeeper).toEqual({ keep: true });
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
