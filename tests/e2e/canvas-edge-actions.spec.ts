import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function pathPoint(pathLocator: Locator): Promise<{ x: number; y: number }> {
  return pathLocator.evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
}

async function openEdgeMenu(page: Page, hit: Locator): Promise<void> {
  const point = await pathPoint(hit);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

function menuItem(page: Page, title: string): Locator {
  return page.locator(".context-menu-item").filter({ hasText: new RegExp(`^${title}$`) });
}

test("edits Canvas edge labels and navigates or removes through exact context actions", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-edge-actions-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-edge-actions-user-"));
  const canvasPath = path.join(vaultDir, "Edge actions.canvas");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [
      { id: "source", type: "text", x: 20, y: 100, width: 220, height: 140, text: "Source", vendorSource: "keep" },
      { id: "target", type: "text", x: 520, y: 100, width: 260, height: 180, text: "Target", vendorTarget: "keep" },
      { id: "group", type: "group", x: 850, y: 400, width: 160, height: 100, label: "Keep", vendorGroup: "keep" },
    ],
    edges: [
      {
        id: "edge-1",
        fromNode: "target",
        fromSide: "bottom",
        fromEnd: "none",
        toNode: "source",
        toSide: "bottom",
        toEnd: "arrow",
        vendorEdge: { keep: true },
      },
      {
        id: "edge-2",
        fromNode: "source",
        fromSide: "right",
        fromEnd: "none",
        toNode: "target",
        toSide: "left",
        toEnd: "arrow",
        vendorActionEdge: "keep-until-removed",
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

    await window.locator('.nav-file-title[data-path="Edge actions.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const hit = view.locator('.canvas-edge-hit[data-edge-id="edge-2"]');

    // Double-click starts focused modal-backed label editing.
    const point = await pathPoint(hit);
    await window.mouse.dblclick(point.x, point.y);
    const prompt = window.locator(".prompt-input");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue("");
    await prompt.fill("  supports  ");
    await prompt.press("Enter");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-2"]')).toHaveText("supports");
    await expect.poll(() => readCanvas(canvasPath)?.edges.find((edge: { id: string }) => edge.id === "edge-2")?.label ?? null).toBe("supports");

    // The exact context item edits and trims the current value.
    const cameraBeforeMenu = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    await openEdgeMenu(window, hit);
    await expect(window.locator(".context-menu-item")).toHaveText(["Edit label", "Go to target", "Go to source", "Remove"]);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(cameraBeforeMenu);
    await menuItem(window, "Edit label").click();
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue("supports");
    await prompt.fill("  routes  ");
    await prompt.press("Enter");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-2"]')).toHaveText("routes");

    // Empty Enter removes the optional label; Escape cancels without mutation.
    await openEdgeMenu(window, hit);
    await menuItem(window, "Edit label").click();
    await prompt.fill("   ");
    await prompt.press("Enter");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect.poll(() => {
      const edge = readCanvas(canvasPath)?.edges.find((candidate: { id: string }) => candidate.id === "edge-2");
      return edge ? Object.hasOwn(edge, "label") : null;
    }).toBe(false);
    const beforeCancel = fs.readFileSync(canvasPath, "utf8");
    await openEdgeMenu(window, hit);
    await menuItem(window, "Edit label").click();
    await prompt.fill("must not persist");
    await prompt.press("Escape");
    await expect(prompt).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeCancel);

    // Navigation selects only the endpoint, centers the entire card, and does
    // not invoke z-order persistence.
    const beforeNavigation = fs.readFileSync(canvasPath, "utf8");
    await openEdgeMenu(window, hit);
    await menuItem(window, "Go to target").click();
    const target = view.locator('.canvas-node[data-node-id="target"]');
    await expect(target).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    let surfaceBox = (await surface.boundingBox())!;
    let nodeBox = (await target.boundingBox())!;
    expect(nodeBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
    expect(nodeBox.y).toBeGreaterThanOrEqual(surfaceBox.y);
    expect(nodeBox.x + nodeBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width);
    expect(nodeBox.y + nodeBox.height).toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height);
    expect(nodeBox.x + nodeBox.width / 2).toBeCloseTo(surfaceBox.x + surfaceBox.width / 2, 0);
    expect(nodeBox.y + nodeBox.height / 2).toBeCloseTo(surfaceBox.y + surfaceBox.height / 2, 0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeNavigation);

    await openEdgeMenu(window, hit);
    await menuItem(window, "Go to source").click();
    const source = view.locator('.canvas-node[data-node-id="source"]');
    await expect(source).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    surfaceBox = (await surface.boundingBox())!;
    nodeBox = (await source.boundingBox())!;
    expect(nodeBox.x + nodeBox.width / 2).toBeCloseTo(surfaceBox.x + surfaceBox.width / 2, 0);
    expect(nodeBox.y + nodeBox.height / 2).toBeCloseTo(surfaceBox.y + surfaceBox.height / 2, 0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeNavigation);

    // Remove affects only the chosen edge and leaves the camera untouched.
    await openEdgeMenu(window, hit);
    const beforeRemoveCamera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    await menuItem(window, "Remove").click();
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveCount(1);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(beforeRemoveCamera);
    await expect.poll(() => readCanvas(canvasPath)?.edges.map((edge: { id: string }) => edge.id) ?? null).toEqual(["edge-1"]);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Edge actions.canvas"]').click();
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "source").vendorSource).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "target").vendorTarget).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toBe("keep");
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0].vendorEdge).toEqual({ keep: true });
    await expect(window.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveCount(1);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
