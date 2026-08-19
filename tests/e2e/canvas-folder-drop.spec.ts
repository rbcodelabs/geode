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

test("recursively drops a File Explorer folder as one deterministic Canvas card batch", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-folder-drop-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-folder-drop-user-"));
  const bundleDir = path.join(vaultDir, "Bundle");
  const nestedDir = path.join(bundleDir, "Nested");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Empty"));
  fs.writeFileSync(path.join(bundleDir, "Alpha.md"), "# Alpha\n\nFirst note.\n");
  fs.writeFileSync(path.join(bundleDir, "Mid.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  fs.writeFileSync(path.join(nestedDir, "Beta.md"), "# Beta\n\nNested note.\n");
  fs.writeFileSync(path.join(nestedDir, "Zeta.pdf"), "%PDF-1.4\n% fallback fixture\n");

  const initial = {
    vendorCanvas: { keep: { nested: true } },
    nodes: [
      { id: "keeper", type: "text", x: -500, y: -300, width: 180, height: 100, text: "Keep", color: "2", vendorNode: [1, 2] },
      { id: "file-1", type: "file", x: -220, y: -180, width: 300, height: 120, file: "Missing.bin", vendorFile: { keep: true } },
      { id: "file-3", type: "file", x: 1100, y: 850, width: 300, height: 120, file: "Missing-too.bin", vendorCollision: "keep" },
    ],
    edges: [{
      id: "edge-1", fromNode: "keeper", fromSide: "right", fromEnd: "none",
      toNode: "file-1", toSide: "left", toEnd: "arrow", color: "4", vendorEdge: "keep",
    }],
  };
  const initialText = JSON.stringify(initial, null, 2) + "\n";
  const canvasPath = path.join(bundleDir, "Board.canvas");
  fs.writeFileSync(canvasPath, initialText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    const bundleRow = window.locator(".nav-folder-title", { hasText: "Bundle" }).first();
    await bundleRow.click();
    await window.locator('.nav-file-title[data-path="Bundle/Board.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await expect(view).toBeVisible();
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasFolderWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Bundle/Board.canvas") (window as any).__canvasFolderWrites += 1;
        return modify(file, data);
      };
    });

    // Collapse the source folder so its nested descendants are not rendered.
    // The folder row itself must still publish the same private drag contract.
    await bundleRow.click();
    await expect(window.locator('.nav-file-title[data-path="Bundle/Nested/Beta.md"]')).toHaveCount(0);
    await expect(bundleRow).toHaveAttribute("draggable", "true");
    await window.evaluate((mime) => {
      const row = [...document.querySelectorAll<HTMLElement>(".nav-folder-title")]
        .find((candidate) => candidate.textContent?.trim() === "Bundle")!;
      row.addEventListener("dragstart", (event) => {
        const transfer = event.dataTransfer!;
        (window as any).__canvasFolderDrag = {
          path: transfer.getData(mime),
          types: [...transfer.types],
          effectAllowed: transfer.effectAllowed,
        };
      });
    }, vaultPathMime);

    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + 50, surfaceBox.y + 70);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + 95, surfaceBox.y + 105);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);

    // Invalid sources, root, empty folders, and folder drops on a card are inert.
    const emptyRow = window.locator(".nav-folder-title", { hasText: "Empty" }).first();
    await expect(emptyRow).toHaveAttribute("draggable", "true");
    for (const [type, value] of [
      ["text/plain", "Bundle"],
      [vaultPathMime, ""],
      [vaultPathMime, "/"],
      [vaultPathMime, "../Bundle"],
      [vaultPathMime, "Missing"],
      [vaultPathMime, "Empty"],
    ]) {
      await dispatchDrop(surface, type, value);
    }
    await bundleRow.dragTo(view.locator('.canvas-node[data-node-id="file-1"]'));
    expect(await window.evaluate(() => (window as any).__canvasFolderDrag)).toEqual({
      path: "Bundle", types: [vaultPathMime], effectAllowed: "copy",
    });
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__canvasFolderWrites)).toBe(0);
    await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual(transformedCamera);

    // One folder drop gathers hidden descendants, excludes the open Canvas,
    // lexically orders paths, and appends one three-column world-space batch.
    const dropPoint = await emptySurfacePoint(surface);
    const dropWorld = {
      x: (dropPoint.x - transformedCamera.panX) / transformedCamera.scale,
      y: (dropPoint.y - transformedCamera.panY) / transformedCamera.scale,
    };
    await bundleRow.dragTo(surface, { targetPosition: dropPoint });
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(7);
    expect(await window.evaluate(() => (window as any).__canvasFolderWrites)).toBe(1);
    expect(await camera(view)).toEqual(transformedCamera);

    const expectedNew = [
      { id: "file-2", type: "file", x: dropWorld.x - 180, y: dropWorld.y - 140, width: 360, height: 280, file: "Bundle/Alpha.md" },
      { id: "file-4", type: "file", x: dropWorld.x + 400 - 180, y: dropWorld.y - 120, width: 360, height: 240, file: "Bundle/Mid.png" },
      { id: "file-5", type: "file", x: dropWorld.x + 800 - 180, y: dropWorld.y - 140, width: 360, height: 280, file: "Bundle/Nested/Beta.md" },
      { id: "file-6", type: "file", x: dropWorld.x - 150, y: dropWorld.y + 320 - 60, width: 300, height: 120, file: "Bundle/Nested/Zeta.pdf" },
    ];
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.slice(0, initial.nodes.length)).toEqual(initial.nodes);
    expect(saved.nodes.slice(initial.nodes.length)).toEqual(expectedNew);
    expect(saved.edges).toEqual(initial.edges);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(4);
    for (const node of expectedNew) await expect(view.locator(`.canvas-node[data-node-id="${node.id}"]`)).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
    await expect(view.locator('.canvas-node[data-node-id="file-2"] .canvas-node-note h1')).toHaveText("Alpha");
    await expect(view.locator('.canvas-node[data-node-id="file-4"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="file-5"] .canvas-node-note h1')).toHaveText("Beta");
    await expect(view.locator('.canvas-node[data-node-id="file-6"] .canvas-node-file-fallback')).toHaveText("Zeta.pdf");

    await window.reload();
    await window.locator(".nav-folder-title", { hasText: "Bundle" }).first().click();
    await window.locator('.nav-file-title[data-path="Bundle/Board.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator(".canvas-node")).toHaveCount(7);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
