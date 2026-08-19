import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const vaultPathMime = "application/x-geode-vault-path";

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

async function dispatchDrop(target: Locator, type: string, value: string): Promise<void> {
  await target.evaluate((element, payload) => {
    const transfer = new DataTransfer();
    transfer.setData(payload.type, payload.value);
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { type, value });
}

async function expectOnlySelected(view: Locator, id: string): Promise<void> {
  await expect(view.locator(`.canvas-node[data-node-id="${id}"]`)).toHaveClass(/is-selected/);
  await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
  await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
}

async function emptySurfacePoint(surface: Locator): Promise<{ x: number; y: number }> {
  return surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = element.querySelector(".canvas-viewport");
    for (const yRatio of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const xRatio of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const x = Math.round(rect.width * xRatio);
        const y = Math.round(rect.height * yRatio);
        const target = document.elementFromPoint(rect.left + x, rect.top + y);
        if (target === element || target === viewport) return { x, y };
      }
    }
    throw new Error("No true empty Canvas surface point found");
  });
}

test("drags one vault file from File Explorer onto empty transformed Canvas space", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-explorer-drop-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-explorer-drop-user-"));
  const canvasPath = path.join(vaultDir, "Drop.canvas");
  fs.writeFileSync(path.join(vaultDir, "Existing.md"), "# Existing\n");
  fs.writeFileSync(path.join(vaultDir, "Dragged note.md"), "# Dragged note\n\nSafe **Markdown**.\n");
  fs.writeFileSync(path.join(vaultDir, "Dragged image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "keeper", type: "text", x: -340, y: -180, width: 200, height: 120, text: "Keeper", color: "2", vendorKeeper: [1, 2] },
      { id: "file-1", type: "file", x: 40, y: 20, width: 360, height: 280, file: "Existing.md", vendorExisting: { keep: true } },
    ],
    edges: [{
      id: "edge-1", fromNode: "keeper", fromSide: "right", fromEnd: "none",
      toNode: "file-1", toSide: "left", toEnd: "arrow", color: "4", vendorEdge: "keep",
    }],
  };
  const initialText = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(canvasPath, initialText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Drop.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    const noteRow = window.locator('.nav-file-title[data-path="Dragged note.md"]');
    const imageRow = window.locator('.nav-file-title[data-path="Dragged image.png"]');
    await expect(noteRow).toHaveAttribute("draggable", "true");
    await expect(imageRow).toHaveAttribute("draggable", "true");
    await window.evaluate((mime) => {
      const row = document.querySelector<HTMLElement>('.nav-file-title[data-path="Dragged note.md"]')!;
      row.addEventListener("dragstart", (event) => {
        const transfer = event.dataTransfer!;
        (window as any).__canvasExplorerDrag = {
          path: transfer.getData(mime),
          types: [...transfer.types],
          effectAllowed: transfer.effectAllowed,
        };
      });
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasExplorerWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Drop.canvas") (window as any).__canvasExplorerWrites += 1;
        return modify(file, data);
      };
    }, vaultPathMime);

    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + 45, surfaceBox.y + 75);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + 95, surfaceBox.y + 110);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);

    // A real drag exposes only the private vault-relative path contract. A
    // drop on a card is rejected and drag start itself does not open, select,
    // reorder, or persist anything.
    await noteRow.dragTo(view.locator('.canvas-node[data-node-id="file-1"]'), { targetPosition: { x: 50, y: 50 } });
    expect(await window.evaluate(() => (window as any).__canvasExplorerDrag)).toEqual({
      path: "Dragged note.md",
      types: [vaultPathMime],
      effectAllowed: "copy",
    });
    expect(await window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Drop.canvas");
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__canvasExplorerWrites)).toBe(0);
    expect(await camera(view)).toEqual(transformedCamera);

    // Unrelated, malformed, missing, and the currently open Canvas path are
    // all inert even when dispatched through a genuine DataTransfer object.
    for (const [type, value] of [
      ["text/plain", "Dragged note.md"],
      [vaultPathMime, "../Dragged note.md"],
      [vaultPathMime, "Missing.md"],
      [vaultPathMime, "Drop.canvas"],
    ]) {
      await dispatchDrop(surface, type, value);
      expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
      expect(await window.evaluate(() => (window as any).__canvasExplorerWrites)).toBe(0);
      await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length);
      await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
      expect(await camera(view)).toEqual(transformedCamera);
    }

    // A real empty-surface drop uses the transformed cursor as the new note
    // card center, appends a collision-safe ID, exclusively selects it, and
    // performs exactly one Canvas write.
    const notePoint = await emptySurfacePoint(surface);
    const noteWorld = {
      x: (notePoint.x - transformedCamera.panX) / transformedCamera.scale,
      y: (notePoint.y - transformedCamera.panY) / transformedCamera.scale,
    };
    await noteRow.dragTo(surface, { targetPosition: notePoint });
    const noteNode = view.locator('.canvas-node[data-node-id="file-2"]');
    await expect(noteNode.locator(".canvas-node-note h1")).toHaveText("Dragged note");
    await expect(noteNode.locator(".canvas-node-note strong")).toHaveText("Markdown");
    const noteGeometry = await noteNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(noteGeometry).toMatchObject({ width: 360, height: 280 });
    expect(noteGeometry.x + noteGeometry.width / 2).toBeCloseTo(noteWorld.x, 0);
    expect(noteGeometry.y + noteGeometry.height / 2).toBeCloseTo(noteWorld.y, 0);
    await expectOnlySelected(view, "file-2");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(3);
    expect(await window.evaluate(() => (window as any).__canvasExplorerWrites)).toBe(1);
    expect(await camera(view)).toEqual(transformedCamera);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.slice(0, 2)).toEqual(initial.nodes);
    expect(saved.nodes[2]).toEqual({
      id: "file-2", type: "file", x: noteWorld.x - 180, y: noteWorld.y - 140,
      width: 360, height: 280, file: "Dragged note.md",
    });
    expect(saved.edges).toEqual(initial.edges);

    // A representative image follows the same real drag path and existing
    // media sizing/rendering while replacing the in-memory selection only.
    const imagePoint = await emptySurfacePoint(surface);
    const imageWorld = {
      x: (imagePoint.x - transformedCamera.panX) / transformedCamera.scale,
      y: (imagePoint.y - transformedCamera.panY) / transformedCamera.scale,
    };
    await imageRow.dragTo(surface, { targetPosition: imagePoint });
    const imageNode = view.locator('.canvas-node[data-node-id="file-3"]');
    await expect(imageNode.locator("img.canvas-node-media")).toHaveAttribute("src", /^blob:/);
    const imageGeometry = await imageNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(imageGeometry).toMatchObject({ width: 360, height: 240 });
    expect(imageGeometry.x + imageGeometry.width / 2).toBeCloseTo(imageWorld.x, 0);
    expect(imageGeometry.y + imageGeometry.height / 2).toBeCloseTo(imageWorld.y, 0);
    await expectOnlySelected(view, "file-3");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(4);
    expect(await window.evaluate(() => (window as any).__canvasExplorerWrites)).toBe(2);
    expect(await camera(view)).toEqual(transformedCamera);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.slice(0, 3)).toEqual([
      ...initial.nodes,
      { id: "file-2", type: "file", x: noteWorld.x - 180, y: noteWorld.y - 140, width: 360, height: 280, file: "Dragged note.md" },
    ]);
    expect(saved.nodes[3]).toEqual({
      id: "file-3", type: "file", x: imageWorld.x - 180, y: imageWorld.y - 120,
      width: 360, height: 240, file: "Dragged image.png",
    });
    expect(saved.edges).toEqual(initial.edges);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Drop.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="file-2"] .canvas-node-note h1')).toHaveText("Dragged note");
    await expect(view.locator('.canvas-node[data-node-id="file-3"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
