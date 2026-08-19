import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function geometry(node: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
}

async function camera(view: Locator): Promise<Record<string, string | null>> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function dispatchPointer(page: Page, target: Locator, type: "pointerdown" | "pointerup", shiftKey = false): Promise<void> {
  const box = (await target.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (type === "pointerdown") {
    await target.dispatchEvent(type, { button: 0, buttons: 1, clientX: point.x, clientY: point.y, shiftKey });
  } else {
    await page.evaluate(({ x, y, shift }) => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, clientX: x, clientY: y, shiftKey: shift }));
    }, { ...point, shift: shiftKey });
  }
}

test("auto-expands only snapshotted containing groups around dragged selected cards", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-auto-expand-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-auto-expand-user-"));
  const canvasPath = path.join(vaultDir, "Auto expand.canvas");
  const initial = {
    vendorCanvas: { preserve: { document: true } },
    nodes: [
      {
        id: "container", type: "group", x: 0, y: 0, width: 600, height: 400,
        label: "Container", color: "1", vendorContainer: { deep: [1] },
      },
      {
        id: "entered", type: "group", x: 760, y: 440, width: 350, height: 220,
        label: "Entered later", color: "2", vendorEntered: ["keep"],
      },
      {
        id: "peer", type: "text", x: 1350, y: 100, width: 180, height: 120,
        text: "Peer", color: "3", vendorPeer: true,
      },
      {
        id: "card-a", type: "text", x: 100, y: 100, width: 120, height: 80,
        text: "A", color: "4", vendorA: { keep: true },
      },
      {
        id: "card-b", type: "text", x: 350, y: 220, width: 140, height: 100,
        text: "B", color: "5", vendorB: [1, 2, 3],
      },
    ],
    edges: [
      {
        id: "group-edge", fromNode: "container", fromSide: "right", fromEnd: "none",
        toNode: "peer", toSide: "left", toEnd: "arrow", label: "Live", color: "6",
        vendorEdge: { preserve: true },
      },
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
    await expect(window.locator('.nav-file-title[data-path="Auto expand.canvas"]')).toBeVisible();
    await window.evaluate(() => {
      const w = window as any;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.__autoExpandWrites = 0;
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Auto expand.canvas") w.__autoExpandWrites += 1;
        return modify(file, data);
      };
    });

    await window.locator('.nav-file-title[data-path="Auto expand.canvas"]').click();
    let view = window.locator(".canvas-view");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    const scale = Number(transformedCamera.scale);
    const cardA = view.locator('.canvas-node[data-node-id="card-a"]');
    const cardB = view.locator('.canvas-node[data-node-id="card-b"]');
    await dispatchPointer(window, cardA, "pointerdown");
    await dispatchPointer(window, cardA, "pointerup");
    await dispatchPointer(window, cardB, "pointerdown", true);
    await dispatchPointer(window, cardB, "pointerup", true);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(2);
    await expect.poll(() => window.evaluate(() => (window as any).__autoExpandWrites)).toBe(2);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.map((node: { id: string }) => node.id) ?? null)
      .toEqual(initial.nodes.map((node) => node.id));
    const baseline = fs.readFileSync(canvasPath, "utf8");
    const baselineDocument = JSON.parse(baseline);
    await window.evaluate(() => { (window as any).__autoExpandWrites = 0; });

    const container = view.locator('.canvas-node[data-node-id="container"]');
    const entered = view.locator('.canvas-node[data-node-id="entered"]');
    const enteredBefore = await geometry(entered);
    const edge = view.locator('.canvas-edge[data-edge-id="group-edge"]');
    const edgePathBefore = await edge.getAttribute("d");
    const cardBox = (await cardA.boundingBox())!;
    const pointerStart = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };

    // Space bypass preserves the exact transformed world delta. The selected
    // member union first overflows right/bottom, requiring 40 world units of
    // established padding while disk bytes remain untouched mid-drag.
    await cardA.dispatchEvent("pointerdown", {
      button: 0, buttons: 1, clientX: pointerStart.x, clientY: pointerStart.y,
    });
    await window.keyboard.down("Space");
    await window.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1, clientX: x, clientY: y }));
    }, { x: pointerStart.x + 700 * scale, y: pointerStart.y + 400 * scale });
    await expect.poll(() => geometry(container)).toEqual({ x: 0, y: 0, width: 1230, height: 760 });
    expect(await geometry(cardA)).toEqual({ x: 800, y: 500, width: 120, height: 80 });
    expect(await geometry(cardB)).toEqual({ x: 1050, y: 620, width: 140, height: 100 });
    expect(await geometry(entered)).toEqual(enteredBefore);
    await expect.poll(() => edge.getAttribute("d")).not.toBe(edgePathBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(baseline);
    expect(await window.evaluate(() => (window as any).__autoExpandWrites)).toBe(0);
    expect(await camera(view)).toEqual(transformedCamera);

    // Moving the same stable card snapshot past left/top expands monotonically:
    // the already-expanded opposite right/bottom bounds remain at 1230/760.
    // The group entered during this drag remains ineligible and unchanged.
    await window.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1, clientX: x, clientY: y }));
    }, { x: pointerStart.x - 300 * scale, y: pointerStart.y - 250 * scale });
    await expect.poll(() => geometry(container)).toEqual({ x: -240, y: -190, width: 1470, height: 950 });
    expect(await geometry(cardA)).toEqual({ x: -200, y: -150, width: 120, height: 80 });
    expect(await geometry(cardB)).toEqual({ x: 50, y: -30, width: 140, height: 100 });
    expect(await geometry(entered)).toEqual(enteredBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(baseline);
    expect(await window.evaluate(() => (window as any).__autoExpandWrites)).toBe(0);
    await window.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, clientX: x, clientY: y }));
    }, { x: pointerStart.x - 300 * scale, y: pointerStart.y - 250 * scale });
    await window.keyboard.up("Space");

    await expect.poll(() => window.evaluate(() => (window as any).__autoExpandWrites)).toBe(1);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "container")?.x ?? null)
      .toBeCloseTo(-240, 8);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const savedContainer = saved.nodes.find((node: { id: string }) => node.id === "container");
    const savedA = saved.nodes.find((node: { id: string }) => node.id === "card-a");
    const savedB = saved.nodes.find((node: { id: string }) => node.id === "card-b");
    expect(savedContainer.x).toBeCloseTo(-240, 8);
    expect(savedContainer.y).toBeCloseTo(-190, 8);
    expect(savedContainer.width).toBeCloseTo(1470, 8);
    expect(savedContainer.height).toBeCloseTo(950, 8);
    expect(savedA.x).toBeCloseTo(-200, 8);
    expect(savedA.y).toBeCloseTo(-150, 8);
    expect(savedB.x).toBeCloseTo(50, 8);
    expect(savedB.y).toBeCloseTo(-30, 8);
    const normalizedNodes = structuredClone(saved.nodes);
    Object.assign(normalizedNodes.find((node: { id: string }) => node.id === "container"), {
      x: -240, y: -190, width: 1470, height: 950,
    });
    Object.assign(normalizedNodes.find((node: { id: string }) => node.id === "card-a"), { x: -200, y: -150 });
    Object.assign(normalizedNodes.find((node: { id: string }) => node.id === "card-b"), { x: 50, y: -30 });
    expect(normalizedNodes).toEqual([
      { ...baselineDocument.nodes[0], x: -240, y: -190, width: 1470, height: 950 },
      baselineDocument.nodes[1],
      baselineDocument.nodes[2],
      { ...baselineDocument.nodes[3], x: -200, y: -150 },
      { ...baselineDocument.nodes[4], x: 50, y: -30 },
    ]);
    expect(saved.edges).toEqual(baselineDocument.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    await expect(view.locator('.canvas-node[data-node-id="card-a"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-node[data-node-id="card-b"]')).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Auto expand.canvas"]').click();
    view = window.locator(".canvas-view");
    const reloadedGeometry = await geometry(view.locator('.canvas-node[data-node-id="container"]'));
    expect(reloadedGeometry.x).toBeCloseTo(-240, 8);
    expect(reloadedGeometry.y).toBeCloseTo(-190, 8);
    expect(reloadedGeometry.width).toBeCloseTo(1470, 8);
    expect(reloadedGeometry.height).toBeCloseTo(950, 8);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    await expect(view.locator(".canvas-node.is-selected, .canvas-selection-controls")).toHaveCount(0);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
