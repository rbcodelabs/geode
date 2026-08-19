import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

type Geometry = { x: number; y: number; width: number; height: number };

async function geometry(node: Locator): Promise<Geometry> {
  return node.evaluate((element) => {
    const el = element as HTMLElement;
    return {
      x: Number.parseFloat(el.style.left),
      y: Number.parseFloat(el.style.top),
      width: Number.parseFloat(el.style.width),
      height: Number.parseFloat(el.style.height),
    };
  });
}

async function beginResize(page: Page, node: Locator): Promise<{ x: number; y: number }> {
  const handle = node.locator(".canvas-node-resize-handle");
  const box = (await handle.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? null, start))
    .toBe("canvas-node-resize-handle");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return start;
}

test("Shift-resizes Canvas cards with a dynamically preserved aspect ratio", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-aspect-resize-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-aspect-resize-user-"));
  const canvasPath = path.join(vaultDir, "Aspect resize.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "file", type: "file", x: 50, y: 190, width: 180, height: 140, file: "Note.md", vendorFile: { deep: [1, { keep: true }] } },
      { id: "link", type: "link", x: 50, y: 350, width: 220, height: 110, url: "https://example.com/", vendorLink: { deep: [2, { keep: true }] } },
      { id: "group", type: "group", x: 110, y: 40, width: 260, height: 140, label: "Group", vendorGroup: { deep: [3, { keep: true }] } },
      { id: "text", type: "text", x: 50, y: 40, width: 240, height: 120, text: "Non-square", vendorText: { deep: [4, { keep: true }] } },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "text",
      fromSide: "right",
      fromEnd: "none",
      toNode: "file",
      toSide: "left",
      toEnd: "arrow",
      label: "Incident",
      color: "6",
      vendorEdge: { deep: [5, { keep: true }] },
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

    await window.locator('.nav-file-title[data-path="Aspect resize.canvas"]').click();
    let view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 50, surfaceBox.y + surfaceBox.height - 60);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 80, surfaceBox.y + surfaceBox.height - 85);
    await window.mouse.up({ button: "middle" });
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    expect(Number(camera.scale)).toBe(1.2);

    const text = view.locator('.canvas-node[data-node-id="text"]');
    const edge = view.locator('.canvas-edge[data-edge-id="edge-1"]');
    const edgePathBefore = await edge.getAttribute("d");
    let diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");
    const start = await beginResize(window, text);

    // Plain +80,+20 world resizing remains unconstrained.
    await window.mouse.move(start.x + 96, start.y + 24);
    expect(await geometry(text)).toEqual({ x: 50, y: 40, width: 320, height: 140 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);

    // Pressing Shift dynamically re-evaluates from the original 240x120
    // geometry. Width is the dominant proportional change: scale 4/3.
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x + 96, start.y + 25);
    expect(await geometry(text)).toEqual({ x: 50, y: 40, width: 320, height: 160 });

    // Vertical proportional change becomes dominant: scale 3/2.
    await window.mouse.move(start.x + 24, start.y + 72);
    expect(await geometry(text)).toEqual({ x: 50, y: 40, width: 360, height: 180 });

    // Releasing Shift restores plain resizing from the same start geometry.
    await window.keyboard.up("Shift");
    await window.mouse.move(start.x + 24, start.y + 60);
    expect(await geometry(text)).toEqual({ x: 50, y: 40, width: 260, height: 170 });

    // Re-pressing Shift returns to the constrained result before drop.
    await window.keyboard.down("Shift");
    await window.mouse.move(start.x + 24, start.y + 72);
    expect(await geometry(text)).toEqual({ x: 50, y: 40, width: 360, height: 180 });
    expect(await edge.getAttribute("d")).not.toBe(edgePathBefore);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "text")?.width ?? null).toBeCloseTo(360, 4);

    // A dominant negative width driver would underflow both minimums. The
    // shared scale clamps at height 50, yielding width 100 without ratio drift.
    diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");
    const shrinkStart = await beginResize(window, text);
    await window.keyboard.down("Shift");
    await window.mouse.move(shrinkStart.x - 480, shrinkStart.y - 48);
    expect(await geometry(text)).toEqual({ x: 50, y: 40, width: 100, height: 50 });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
    await window.mouse.up();
    await window.keyboard.up("Shift");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "text")?.height ?? null).toBeCloseTo(50, 4);

    // The same generic Shift-resize path applies to every remaining node type.
    const expectedFinal: Record<string, Geometry> = { text: { x: 50, y: 40, width: 100, height: 50 } };
    for (const id of ["file", "link", "group"]) {
      const node = view.locator(`.canvas-node[data-node-id="${id}"]`);
      const before = await geometry(node);
      diskBeforeDrag = fs.readFileSync(canvasPath, "utf8");
      const nodeStart = await beginResize(window, node);
      await window.keyboard.down("Shift");
      await window.mouse.move(nodeStart.x + 36, nodeStart.y + 12);
      const resized = await geometry(node);
      expect(resized.x).toBe(before.x);
      expect(resized.y).toBe(before.y);
      expect(resized.width).toBeCloseTo(before.width + 30, 4);
      expect(resized.width / resized.height).toBeCloseTo(before.width / before.height, 5);
      expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeDrag);
      await window.mouse.up();
      await window.keyboard.up("Shift");
      await expect.poll(() => readCanvas(canvasPath)?.nodes.find((candidate: { id: string }) => candidate.id === id)?.width ?? null).toBeCloseTo(before.width + 30, 4);
      expectedFinal[id] = resized;
    }

    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.find((node: { id: string }) => node.id === "file").vendorFile).toEqual(initial.nodes[0].vendorFile);
    expect(saved.nodes.find((node: { id: string }) => node.id === "link").vendorLink).toEqual(initial.nodes[1].vendorLink);
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toEqual(initial.nodes[2].vendorGroup);
    expect(saved.nodes.find((node: { id: string }) => node.id === "text").vendorText).toEqual(initial.nodes[3].vendorText);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Aspect resize.canvas"]').click();
    view = window.locator(".canvas-view");
    for (const [id, expected] of Object.entries(expectedFinal)) {
      const reloaded = await geometry(view.locator(`.canvas-node[data-node-id="${id}"]`));
      expect(reloaded.x).toBe(expected.x);
      expect(reloaded.y).toBe(expected.y);
      expect(reloaded.width).toBeCloseTo(expected.width, 4);
      expect(reloaded.height).toBeCloseTo(expected.height, 4);
    }
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(persistedText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
