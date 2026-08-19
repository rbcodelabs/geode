import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

test("opens and edits a JSON Canvas from the file explorer", async () => {
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-user-"));
  const canvasPath = path.join(vaultDir, "Ideas.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Linked note\n");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [
      { id: "group", type: "group", x: -30, y: -30, width: 650, height: 340, label: "Planning" },
      { id: "text", type: "text", x: 0, y: 0, width: 220, height: 120, text: "First idea", color: "1", vendorNode: "keep" },
      { id: "file", type: "file", x: 300, y: 0, width: 220, height: 120, file: "Note.md", color: "2" },
      { id: "link", type: "link", x: 0, y: 170, width: 220, height: 100, url: "https://example.com", color: "3" },
      { id: "color4", type: "text", x: 680, y: 0, width: 120, height: 70, text: "Four", color: "4" },
      { id: "color5", type: "text", x: 680, y: 90, width: 120, height: 70, text: "Five", color: "5" },
      { id: "color6", type: "text", x: 680, y: 180, width: 120, height: 70, text: "Six", color: "6" },
    ],
    edges: [{ id: "edge", fromNode: "text", fromSide: "right", toNode: "file", toSide: "left", label: "supports" }],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Ideas.canvas"]').click();
    const view = window.locator(".canvas-view");
    await expect(view).toBeVisible();
    await expect(view.locator(".canvas-node")).toHaveCount(7);
    await expect(view.locator(".canvas-edge")).toHaveCount(1);
    await expect(view.locator(".canvas-controls")).toBeVisible();
    const canvasVariables = await view.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        "--canvas-background",
        "--canvas-card-label-color",
        "--canvas-dot-pattern",
        "--canvas-color-1",
        "--canvas-color-2",
        "--canvas-color-3",
        "--canvas-color-4",
        "--canvas-color-5",
        "--canvas-color-6",
      ].map((name) => style.getPropertyValue(name).trim());
    });
    expect(canvasVariables.every(Boolean)).toBe(true);
    for (let preset = 1; preset <= 6; preset += 1) {
      await expect(view.locator(`.canvas-node[data-node-id="${preset <= 3 ? ["text", "file", "link"][preset - 1] : `color${preset}`}"]`))
        .toHaveCSS("--canvas-node-color", canvasVariables[preset + 2]);
    }
    if (screenshotDir) {
      await window.setViewportSize({ width: 900, height: 700 });
      await window.locator(".sidebar-toggle-button.mod-left").click();
      await window.locator(".sidebar-toggle-button.mod-right").click();
      await window.screenshot({ path: path.join(screenshotDir, "json-canvas-open-small.png") });
      await window.setViewportSize({ width: 1440, height: 900 });
      await window.screenshot({ path: path.join(screenshotDir, "json-canvas-open-large.png") });
      await window.locator(".sidebar-toggle-button.mod-left").click();
      await window.locator(".sidebar-toggle-button.mod-right").click();
    }

    const textNode = view.locator('.canvas-node[data-node-id="text"]');
    await textNode.click();
    await expect(textNode).toHaveClass(/is-selected/);
    await expect.poll(() => {
      const doc = readCanvas(canvasPath);
      return doc?.nodes.at(-1)?.id ?? null;
    }).toBe("text");

    const fileNode = view.locator('.canvas-node[data-node-id="file"]');
    await fileNode.click({ modifiers: ["Shift"] });
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(2);
    await textNode.click({ modifiers: ["Shift"] });
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    await expect(fileNode).toHaveClass(/is-selected/);
    await fileNode.press("ControlOrMeta+a");
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(7);

    await textNode.click();
    await textNode.dblclick();
    const editor = textNode.locator(".canvas-node-text-editor");
    await editor.fill("Revised idea");
    await editor.press("ControlOrMeta+Enter");
    await expect(textNode.locator(".canvas-node-text")).toHaveText("Revised idea");
    const before = await textNode.boundingBox();
    await textNode.dragTo(view, { targetPosition: { x: 500, y: 360 } });
    const moved = await textNode.boundingBox();
    expect(moved!.x).toBeGreaterThan(before!.x + 100);

    const resize = textNode.locator(".canvas-node-resize-handle");
    const handle = (await resize.boundingBox())!;
    await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle.x + 60, handle.y + 40);
    await window.mouse.up();
    await expect.poll(() => textNode.evaluate((el) => Number((el as HTMLElement).dataset.width))).toBeGreaterThan(220);

    const surface = view.locator(".canvas-surface");
    const surfaceBox = (await surface.boundingBox())!;
    const panBefore = Number(await view.getAttribute("data-pan-x"));
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 30, surfaceBox.y + surfaceBox.height - 30);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 80, surfaceBox.y + surfaceBox.height - 70);
    await window.mouse.up({ button: "middle" });
    expect(Number(await view.getAttribute("data-pan-x"))).toBeLessThan(panBefore);

    const spacePanBefore = Number(await view.getAttribute("data-pan-x"));
    await window.keyboard.down("Space");
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 40, surfaceBox.y + surfaceBox.height - 40);
    await window.mouse.down();
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 70, surfaceBox.y + surfaceBox.height - 40);
    await window.mouse.up();
    await window.keyboard.up("Space");
    expect(Number(await view.getAttribute("data-pan-x"))).toBeLessThan(spacePanBefore);

    await surface.hover();
    const verticalPanBefore = Number(await view.getAttribute("data-pan-y"));
    await window.mouse.wheel(0, -400);
    expect(Number(await view.getAttribute("data-pan-y"))).toBeGreaterThan(verticalPanBefore);
    expect(await view.getAttribute("data-scale")).toBe("1");

    const horizontalPanBefore = Number(await view.getAttribute("data-pan-x"));
    await window.keyboard.down("Shift");
    await window.mouse.wheel(0, -200);
    await window.keyboard.up("Shift");
    expect(Number(await view.getAttribute("data-pan-x"))).toBeGreaterThan(horizontalPanBefore);

    const zoomCursor = { x: surfaceBox.x + surfaceBox.width / 2, y: surfaceBox.y + surfaceBox.height / 2 };
    const transformBefore = {
      scale: Number(await view.getAttribute("data-scale")),
      panX: Number(await view.getAttribute("data-pan-x")),
      panY: Number(await view.getAttribute("data-pan-y")),
    };
    const worldBefore = {
      x: (zoomCursor.x - surfaceBox.x - transformBefore.panX) / transformBefore.scale,
      y: (zoomCursor.y - surfaceBox.y - transformBefore.panY) / transformBefore.scale,
    };
    await window.mouse.move(zoomCursor.x, zoomCursor.y);
    await window.keyboard.down("ControlOrMeta");
    await window.mouse.wheel(0, -400);
    await window.keyboard.up("ControlOrMeta");
    await expect.poll(() => view.getAttribute("data-scale")).not.toBe("1");
    const transformAfter = {
      scale: Number(await view.getAttribute("data-scale")),
      panX: Number(await view.getAttribute("data-pan-x")),
      panY: Number(await view.getAttribute("data-pan-y")),
    };
    // Playwright rounds mouse coordinates to device pixels, so allow sub-pixel world-coordinate drift.
    expect((zoomCursor.x - surfaceBox.x - transformAfter.panX) / transformAfter.scale).toBeCloseTo(worldBefore.x, 0);
    expect((zoomCursor.y - surfaceBox.y - transformAfter.panY) / transformAfter.scale).toBeCloseTo(worldBefore.y, 0);

    const spaceZoomBefore = Number(await view.getAttribute("data-scale"));
    await window.keyboard.down("Space");
    await window.mouse.wheel(0, -100);
    await window.keyboard.up("Space");
    expect(Number(await view.getAttribute("data-scale"))).toBeGreaterThan(spaceZoomBefore);

    await view.locator('[data-canvas-action="zoom-in"]').click();
    const controlZoom = Number(await view.getAttribute("data-scale"));
    await view.locator('[data-canvas-action="zoom-out"]').click();
    expect(Number(await view.getAttribute("data-scale"))).toBeLessThan(controlZoom);
    await view.locator('[data-canvas-action="fit"]').click();
    expect(Number(await view.getAttribute("data-scale"))).toBeGreaterThan(0);
    await view.locator('[data-canvas-action="reset"]').click();
    expect(await view.getAttribute("data-scale")).toBe("1");
    expect(await view.getAttribute("data-pan-x")).toBe("80");
    expect(await view.getAttribute("data-pan-y")).toBe("80");

    await fileNode.click();
    await fileNode.press("Delete");
    await expect(view.locator('.canvas-node[data-node-id="file"]')).toHaveCount(0);
    await expect(view.locator(".canvas-edge")).toHaveCount(0);

    await expect.poll(() => {
      const doc = readCanvas(canvasPath);
      return doc?.nodes.find((node: { id: string }) => node.id === "text")?.width ?? null;
    }).toBeGreaterThan(220);
    await expect.poll(() => {
      const doc = readCanvas(canvasPath);
      return doc?.nodes.find((node: { id: string; text?: string }) => node.id === "text")?.text ?? null;
    }).toBe("Revised idea");
    await expect.poll(() => {
      const doc = readCanvas(canvasPath);
      if (!doc) return null;
      return { file: doc.nodes.some((node: { id: string }) => node.id === "file"), edges: doc.edges.length };
    }).toEqual({ file: false, edges: 0 });
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "text")?.vendorNode).toBe("keep");
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
