import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

test("authors, selects, and deletes directed Canvas connections at transformed coordinates", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-connections-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-connections-user-"));
  const canvasPath = path.join(vaultDir, "Connections.canvas");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [
      { id: "target", type: "text", x: 480, y: 120, width: 220, height: 120, text: "Target", vendorTarget: "keep" },
      { id: "group", type: "group", x: 780, y: 360, width: 180, height: 120, label: "Group", vendorGroup: "keep" },
      { id: "source", type: "text", x: 40, y: 120, width: 220, height: 120, text: "Source", vendorSource: "keep" },
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
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Connections.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const source = view.locator('.canvas-node[data-node-id="source"]');
    const target = view.locator('.canvas-node[data-node-id="target"]');
    const group = view.locator('.canvas-node[data-node-id="group"]');

    await view.locator('[data-canvas-action="zoom-in"]').click();
    expect(Number(await view.getAttribute("data-scale"))).toBeGreaterThan(1);
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    await source.click();
    await expect(source).toHaveClass(/is-selected/);
    await expect(source.locator(".canvas-node-connection-handle")).toHaveCount(4);
    await expect(group.locator(".canvas-node-connection-handle")).toHaveCount(4);
    await expect(source.getByRole("button", { name: "Connect from top" })).toBeVisible();

    const initialText = fs.readFileSync(canvasPath, "utf8");
    const sourceRight = source.getByRole("button", { name: "Connect from right" });
    let sourceBox = (await sourceRight.boundingBox())!;

    // Empty-space release offers the exact chooser; the text action starts the
    // attached transaction and Escape rolls it back so the remaining
    // connection regressions retain their stable IDs.
    await window.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await window.mouse.down();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height - 80);
    await expect(view.locator(".canvas-edge-preview")).toBeVisible();
    await window.mouse.up();
    await expect(view.locator(".canvas-edge-preview")).toHaveCount(0);
    await expect(window.locator(".context-menu-item")).toHaveText([
      "Add text card", "Add note from vault", "Add media from vault", "Add web page",
    ]);
    await window.locator(".context-menu-item", { hasText: /^Add text card$/ }).click();
    const pendingEditor = view.locator('.canvas-node[data-node-id="text-1"] .canvas-node-text-editor');
    await expect(pendingEditor).toBeFocused();
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await pendingEditor.press("Escape");
    await expect(view.locator('.canvas-node[data-node-id="text-1"]')).toHaveCount(0);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    // A handle on the source itself is not a valid target.
    sourceBox = (await sourceRight.boundingBox())!;
    await window.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await window.mouse.down();
    const sourceLeft = source.getByRole("button", { name: "Connect from left" });
    await expect(sourceLeft).toBeVisible();
    const selfBox = (await sourceLeft.boundingBox())!;
    await window.mouse.move(selfBox.x + selfBox.width / 2, selfBox.y + selfBox.height / 2);
    await window.mouse.up();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    // Source-right to target-left creates a fully explicit directed edge.
    sourceBox = (await sourceRight.boundingBox())!;
    await window.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await window.mouse.down();
    const targetLeft = target.getByRole("button", { name: "Connect from left" });
    await expect(targetLeft).toBeVisible();
    const targetBox = (await targetLeft.boundingBox())!;
    await window.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
    await window.mouse.up();

    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    await expect(view.locator('.canvas-edge-hit[data-edge-id="edge-2"]')).toHaveCount(1);
    await expect.poll(() => readCanvas(canvasPath)?.edges.length ?? null).toBe(2);
    const created = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(created.edges.find((edge: { id: string }) => edge.id === "edge-2")).toEqual({
      id: "edge-2",
      fromNode: "source",
      fromSide: "right",
      fromEnd: "none",
      toNode: "target",
      toSide: "left",
      toEnd: "arrow",
    });
    expect(created.vendorCanvas).toEqual({ keep: true });
    expect(created.nodes.find((node: { id: string }) => node.id === "source").vendorSource).toBe("keep");
    expect(created.edges.find((edge: { id: string }) => edge.id === "edge-1").vendorEdge).toEqual({ keep: true });
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    // The wide hit path owns selection without moving either card.
    const beforeNodes = created.nodes.map((node: { id: string; x: number; y: number }) => ({ id: node.id, x: node.x, y: node.y }));
    const edgeHit = view.locator('.canvas-edge-hit[data-edge-id="edge-2"]');
    const edgePoint = await edgeHit.evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    await window.mouse.click(edgePoint.x, edgePoint.y);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.map((node: { id: string; x: number; y: number }) => ({ id: node.id, x: node.x, y: node.y }))).toEqual(beforeNodes);

    await target.click();
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
    await expect(target).toHaveClass(/is-selected/);
    await edgeHit.dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    await window.keyboard.press("Delete");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveCount(1);
    await expect(view.locator(".canvas-node")).toHaveCount(3);
    await expect.poll(() => readCanvas(canvasPath)?.edges.map((edge: { id: string }) => edge.id) ?? null).toEqual(["edge-1"]);

    // Background selection clears an edge selection without changing disk.
    const existingHit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
    const existingPoint = await existingHit.evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    await window.mouse.click(existingPoint.x, existingPoint.y);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await surface.click({ position: { x: 20, y: surfaceBox.height - 20 } });
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Connections.canvas"]').click();
    const reloaded = window.locator(".canvas-view");
    await expect(reloaded.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveCount(1);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "target").vendorTarget).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toBe("keep");
    expect(saved.edges[0].vendorEdge).toEqual({ keep: true });
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
