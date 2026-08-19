import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function geometry(node: Locator): Promise<{ x: number; y: number }> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}

test("moves the stable geometric membership snapshot with a dragged Canvas group", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-membership-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-membership-user-"));
  const canvasPath = path.join(vaultDir, "Membership.canvas");
  const initial = {
    vendorCanvas: { keep: true },
    nodes: [
      { id: "outer", type: "group", x: 100, y: 100, width: 500, height: 300, label: "Outer", vendorOuter: "keep" },
      { id: "nested", type: "group", x: 420, y: 300, width: 100, height: 70, label: "Nested", vendorNested: "keep" },
      { id: "inside-a", type: "text", x: 100, y: 100, width: 80, height: 60, text: "Inclusive boundary", vendorA: "keep" },
      { id: "inside-b", type: "text", x: 250, y: 220, width: 120, height: 80, text: "Inside", vendorB: "keep" },
      { id: "partial", type: "text", x: 560, y: 180, width: 100, height: 80, text: "Partial", vendorPartial: "keep" },
      { id: "outside", type: "text", x: 650, y: 180, width: 100, height: 80, text: "Outside", vendorOutside: "keep" },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "inside-b",
      fromSide: "right",
      fromEnd: "none",
      toNode: "outside",
      toSide: "left",
      toEnd: "arrow",
      label: "metadata stays",
      color: "5",
      vendorEdge: { keep: true },
    }],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Membership.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 50, surfaceBox.y + surfaceBox.height - 70);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 80, surfaceBox.y + surfaceBox.height - 90);
    await window.mouse.up({ button: "middle" });
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    expect(Number(camera.scale)).toBe(1.2);

    const outer = view.locator('.canvas-node[data-node-id="outer"]');
    const insideA = view.locator('.canvas-node[data-node-id="inside-a"]');
    const insideB = view.locator('.canvas-node[data-node-id="inside-b"]');
    const partial = view.locator('.canvas-node[data-node-id="partial"]');
    const outside = view.locator('.canvas-node[data-node-id="outside"]');
    const nested = view.locator('.canvas-node[data-node-id="nested"]');
    const edge = view.locator('.canvas-edge[data-edge-id="edge-1"]');
    const edgePathBefore = await edge.getAttribute("d");
    const diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");
    const orderBeforeDrag = initial.nodes.map((node) => node.id);

    // A 60x48 screen delta at 1.2 zoom is exactly +50,+40 world units.
    let box = (await outer.boundingBox())!;
    const start = { x: box.x + 20, y: box.y + box.height - 22 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 60, start.y + 48);
    expect(await geometry(outer)).toEqual({ x: 150, y: 140 });
    expect(await geometry(insideA)).toEqual({ x: 150, y: 140 });
    expect(await geometry(insideB)).toEqual({ x: 300, y: 260 });
    expect(await geometry(partial)).toEqual({ x: 560, y: 180 });
    expect(await geometry(outside)).toEqual({ x: 650, y: 180 });
    expect(await geometry(nested)).toEqual({ x: 420, y: 300 });
    expect(await edge.getAttribute("d")).not.toBe(edgePathBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.up();

    await expect.poll(() => {
      const doc = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
      return Object.fromEntries(doc.nodes.map((node: { id: string; x: number; y: number }) => [node.id, [node.x, node.y]]));
    }).toEqual({
      outer: [150, 140],
      nested: [420, 300],
      "inside-a": [150, 140],
      "inside-b": [300, 260],
      partial: [560, 180],
      outside: [650, 180],
    });
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(orderBeforeDrag);
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Membership.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-node[data-node-id="inside-a"]')).toHaveCSS("left", "150px");
    await expect(view.locator('.canvas-node[data-node-id="inside-b"]')).toHaveCSS("left", "300px");

    // Change persisted geometry independently: inside-a moves out and outside
    // moves fully in. Reloading makes this the current geometry for the next
    // drag without coupling the membership test to card-drag mechanics.
    const reconfigured = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    reconfigured.nodes.find((node: { id: string }) => node.id === "inside-a").y = 20;
    Object.assign(reconfigured.nodes.find((node: { id: string }) => node.id === "outside"), { x: 450, y: 220 });
    fs.writeFileSync(canvasPath, JSON.stringify(reconfigured, null, 2) + "\n");
    await window.reload();
    await window.locator('.nav-file-title[data-path="Membership.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-node[data-node-id="inside-a"]')).toHaveCSS("top", "20px");
    await expect(view.locator('.canvas-node[data-node-id="outside"]')).toHaveCSS("left", "450px");
    await view.locator('[data-canvas-action="zoom-in"]').click();

    // The next group drag takes a fresh membership snapshot. A -36,+60 screen
    // delta at 1.2 zoom is -30,+50 world units.
    const secondCamera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    const beforeSecond = fs.readFileSync(canvasPath, "utf8");
    const beforeSecondOrder = JSON.parse(beforeSecond).nodes.map((node: { id: string }) => node.id);
    const outerAgain = view.locator('.canvas-node[data-node-id="outer"]');
    box = (await outerAgain.boundingBox())!;
    const secondStart = { x: box.x + 20, y: box.y + box.height - 22 };
    await window.mouse.move(secondStart.x, secondStart.y);
    await window.mouse.down();
    await window.mouse.move(secondStart.x - 36, secondStart.y + 60);
    expect(await geometry(outerAgain)).toEqual({ x: 120, y: 190 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="inside-a"]'))).toEqual({ x: 150, y: 20 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="inside-b"]'))).toEqual({ x: 270, y: 310 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="outside"]'))).toEqual({ x: 420, y: 270 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="partial"]'))).toEqual({ x: 560, y: 180 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeSecond);
    await window.mouse.up();

    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "outer").x).toBe(120);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(beforeSecondOrder);
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.nodes.find((node: { id: string }) => node.id === "nested").vendorNested).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "inside-a").vendorA).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "inside-b").vendorB).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "partial").vendorPartial).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "outside").vendorOutside).toBe("keep");
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(secondCamera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Membership.canvas"]').click();
    await expect(window.locator('.canvas-node[data-node-id="inside-b"]')).toHaveCSS("left", "270px");
    await expect(window.locator('.canvas-node[data-node-id="outside"]')).toHaveCSS("left", "420px");
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
