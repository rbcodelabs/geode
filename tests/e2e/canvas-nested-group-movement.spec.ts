import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function geometry(node: Locator): Promise<{ x: number; y: number }> {
  return node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
  }));
}

async function camera(view: Locator): Promise<{ scale: string | null; panX: string | null; panY: string | null }> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function installWriteCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vault = (window as any).app.vault;
    const modify = vault.modify.bind(vault);
    (window as any).__nestedGroupWrites = 0;
    vault.modify = async (file: { path: string }, data: string) => {
      if (file.path === "Nested movement.canvas") (window as any).__nestedGroupWrites += 1;
      return modify(file, data);
    };
  });
}

test("moves fully-contained nested groups exactly once from a stable geometric snapshot", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-nested-groups-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-nested-groups-user-"));
  const canvasPath = path.join(vaultDir, "Nested movement.canvas");
  const background = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const initial = {
    vendorCanvas: { preserve: { deeply: true } },
    nodes: [
      { id: "outer", type: "group", x: 100, y: 50, width: 600, height: 400, label: "Outer", color: "1", background, vendorOuter: [1] },
      { id: "nested", type: "group", x: 220, y: 120, width: 260, height: 200, label: "Nested", color: "2", background, vendorNested: { keep: true } },
      { id: "deep", type: "group", x: 260, y: 150, width: 100, height: 80, label: "Deep", color: "3", vendorDeep: "keep" },
      { id: "nested-card", type: "text", x: 280, y: 170, width: 90, height: 60, text: "Nested card", vendorNestedCard: true },
      { id: "outer-card", type: "text", x: 500, y: 80, width: 100, height: 70, text: "Outer card", vendorOuterCard: { keep: 4 } },
      { id: "partial-group", type: "group", x: 650, y: 300, width: 100, height: 200, label: "Partial", vendorPartial: [5] },
      { id: "outside", type: "text", x: 760, y: 170, width: 80, height: 60, text: "Outside", vendorOutside: "keep" },
    ],
    edges: [
      { id: "edge-1", fromNode: "nested", fromSide: "right", fromEnd: "none", toNode: "outside", toSide: "left", toEnd: "arrow", color: "4", vendorEdge1: { keep: 1 } },
      { id: "edge-2", fromNode: "deep", fromSide: "right", fromEnd: "none", toNode: "outer-card", toSide: "left", toEnd: "arrow", label: "keep", vendorEdge2: [2] },
    ],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Nested movement.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const firstCamera = await camera(view);
    expect(Number(firstCamera.scale)).toBe(1.2);
    await installWriteCounter(window);

    const outer = view.locator('.canvas-node[data-node-id="outer"]');
    const nested = view.locator('.canvas-node[data-node-id="nested"]');
    const deep = view.locator('.canvas-node[data-node-id="deep"]');
    const nestedCard = view.locator('.canvas-node[data-node-id="nested-card"]');
    const outerCard = view.locator('.canvas-node[data-node-id="outer-card"]');
    const partial = view.locator('.canvas-node[data-node-id="partial-group"]');
    const outside = view.locator('.canvas-node[data-node-id="outside"]');
    const edge1Before = await view.locator('.canvas-edge[data-edge-id="edge-1"]').getAttribute("d");
    const edge2Before = await view.locator('.canvas-edge[data-edge-id="edge-2"]').getAttribute("d");
    const diskBefore = fs.readFileSync(canvasPath, "utf8");

    // At transformed scale, +60,+48 screen pixels is +50,+40 world units.
    let box = (await outer.boundingBox())!;
    let start = { x: box.x + 20, y: box.y + box.height - 26 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 60, start.y + 48);
    expect(await geometry(outer)).toEqual({ x: 150, y: 90 });
    expect(await geometry(nested)).toEqual({ x: 270, y: 160 });
    expect(await geometry(deep)).toEqual({ x: 310, y: 190 });
    expect(await geometry(nestedCard)).toEqual({ x: 330, y: 210 });
    expect(await geometry(outerCard)).toEqual({ x: 550, y: 120 });
    expect(await geometry(partial)).toEqual({ x: 650, y: 300 });
    expect(await geometry(outside)).toEqual({ x: 760, y: 170 });
    await expect(view.locator('.canvas-node.is-selected[data-node-id="outer"]')).toHaveCount(1);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    expect(await view.locator('.canvas-edge[data-edge-id="edge-1"]').getAttribute("d")).not.toBe(edge1Before);
    expect(await view.locator('.canvas-edge[data-edge-id="edge-2"]').getAttribute("d")).not.toBe(edge2Before);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(await window.evaluate(() => (window as any).__nestedGroupWrites)).toBe(0);
    await window.mouse.up();

    await expect.poll(() => readCanvas(canvasPath)?.nodes.map((node: { id: string; x: number; y: number }) => [node.id, node.x, node.y]) ?? null).toEqual([
      ["outer", 150, 90], ["nested", 270, 160], ["deep", 310, 190], ["nested-card", 330, 210],
      ["outer-card", 550, 120], ["partial-group", 650, 300], ["outside", 760, 170],
    ]);
    expect(await window.evaluate(() => (window as any).__nestedGroupWrites)).toBe(1);
    expect(await camera(view)).toEqual(firstCamera);
    let saved = readCanvas(canvasPath)!;
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    // Reconfigure geometry independently, then drag the nested group. Its new
    // pointer-down snapshot excludes the card moved out and includes the card
    // moved fully in, while the outer group is never carried by its child.
    saved.nodes.find((node: { id: string }) => node.id === "nested-card").y = 40;
    Object.assign(saved.nodes.find((node: { id: string }) => node.id === "outside"), { x: 300, y: 190 });
    fs.writeFileSync(canvasPath, JSON.stringify(saved, null, 2) + "\n");
    await window.reload();
    await window.locator('.nav-file-title[data-path="Nested movement.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const secondCamera = await camera(view);
    expect(Number(secondCamera.scale)).toBe(1.2);
    await installWriteCounter(window);
    const secondDiskBefore = fs.readFileSync(canvasPath, "utf8");
    const nestedAgain = view.locator('.canvas-node[data-node-id="nested"]');
    const secondEdge1Before = await view.locator('.canvas-edge[data-edge-id="edge-1"]').getAttribute("d");
    box = (await nestedAgain.boundingBox())!;
    start = { x: box.x + 20, y: box.y + box.height - 26 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    // This membership-only drag intentionally preserves its exact raw delta;
    // Space bypasses the peer-alignment snap introduced for node movement.
    await window.keyboard.down("Space");
    await window.mouse.move(start.x - 24, start.y + 36);
    expect(await geometry(nestedAgain)).toEqual({ x: 250, y: 190 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="deep"]'))).toEqual({ x: 290, y: 220 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="outside"]'))).toEqual({ x: 280, y: 220 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="nested-card"]'))).toEqual({ x: 330, y: 40 });
    expect(await geometry(view.locator('.canvas-node[data-node-id="outer"]'))).toEqual({ x: 150, y: 90 });
    await expect(view.locator('.canvas-node.is-selected[data-node-id="nested"]')).toHaveCount(1);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    expect(await view.locator('.canvas-edge[data-edge-id="edge-1"]').getAttribute("d")).not.toBe(secondEdge1Before);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(secondDiskBefore);
    expect(await window.evaluate(() => (window as any).__nestedGroupWrites)).toBe(0);
    await window.mouse.up();
    await window.keyboard.up("Space");

    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "nested")?.x ?? null).toBe(250);
    expect(await window.evaluate(() => (window as any).__nestedGroupWrites)).toBe(1);
    expect(await camera(view)).toEqual(secondCamera);
    const final = readCanvas(canvasPath)!;
    expect(final.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(final.edges).toEqual(initial.edges);
    expect(final.vendorCanvas).toEqual(initial.vendorCanvas);
    for (const original of initial.nodes) {
      const current = final.nodes.find((node: { id: string }) => node.id === original.id);
      for (const [key, value] of Object.entries(original)) {
        if (key !== "x" && key !== "y") expect(current[key]).toEqual(value);
      }
    }

    await window.reload();
    await window.locator('.nav-file-title[data-path="Nested movement.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="nested"]')).toHaveCSS("left", "250px");
    await expect(view.locator('.canvas-node[data-node-id="deep"]')).toHaveCSS("left", "290px");
    await expect(view.locator('.canvas-node[data-node-id="outside"]')).toHaveCSS("left", "280px");
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(final);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
