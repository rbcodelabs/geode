import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

test("authors text cards from empty space and the bottom toolbar with stable persistence", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-text-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-text-user-"));
  const canvasPath = path.join(vaultDir, "Authoring.canvas");
  fs.writeFileSync(path.join(vaultDir, "Home.md"), "# Home\n");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [
      { id: "text-1", type: "text", x: 0, y: 0, width: 250, height: 140, text: "Original", vendorNode: "keep" },
    ],
    edges: [],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Authoring.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const addTextCard = view.getByRole("button", { name: "Add text card" });
    await expect(addTextCard).toHaveCount(1);
    await expect(addTextCard.locator(".lucide-file-plus")).toBeVisible();

    // Pan and zoom first so double-click placement proves screen→world conversion.
    const initialSurface = (await surface.boundingBox())!;
    await surface.hover();
    await window.keyboard.down("ControlOrMeta");
    await window.mouse.wheel(0, -300);
    await window.keyboard.up("ControlOrMeta");
    await window.mouse.move(initialSurface.x + initialSurface.width - 50, initialSurface.y + initialSurface.height - 80);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(initialSurface.x + initialSurface.width - 100, initialSurface.y + initialSurface.height - 110);
    await window.mouse.up({ button: "middle" });

    const surfaceBox = (await surface.boundingBox())!;
    const transform = {
      scale: Number(await view.getAttribute("data-scale")),
      panX: Number(await view.getAttribute("data-pan-x")),
      panY: Number(await view.getAttribute("data-pan-y")),
    };
    expect(transform.scale).toBeGreaterThan(1);
    const click = { x: surfaceBox.x + surfaceBox.width * 0.72, y: surfaceBox.y + surfaceBox.height * 0.42 };
    const expectedWorld = {
      x: (click.x - surfaceBox.x - transform.panX) / transform.scale,
      y: (click.y - surfaceBox.y - transform.panY) / transform.scale,
    };
    await window.mouse.dblclick(click.x, click.y);

    const doubleClickNode = view.locator('.canvas-node[data-node-id="text-2"]');
    const doubleClickEditor = doubleClickNode.locator(".canvas-node-text-editor");
    await expect(doubleClickEditor).toBeFocused();
    const doubleClickPosition = await doubleClickNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(doubleClickPosition.width).toBe(250);
    expect(doubleClickPosition.height).toBe(140);
    // Playwright rounds pointer coordinates to device pixels; at non-1 zoom
    // that can translate to slightly more than half a world pixel.
    expect(Math.abs(doubleClickPosition.x + doubleClickPosition.width / 2 - expectedWorld.x)).toBeLessThan(1);
    expect(Math.abs(doubleClickPosition.y + doubleClickPosition.height / 2 - expectedWorld.y)).toBeLessThan(1);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes).toHaveLength(1);

    // Textarea-local shortcuts must not select/delete Canvas nodes.
    await doubleClickEditor.fill("temporary");
    await doubleClickEditor.press("ControlOrMeta+a");
    await doubleClickEditor.press("Backspace");
    await expect(view.locator(".canvas-node")).toHaveCount(2);
    await doubleClickEditor.fill("# Created at point");
    await doubleClickEditor.press("ControlOrMeta+Enter");
    await expect(doubleClickNode.locator(".canvas-node-text h1")).toHaveText("Created at point");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(2);

    // Toolbar placement uses the center of the current viewport. Escape on a
    // fresh empty editor cancels creation without writing a transient node.
    const toolbarTransform = {
      scale: Number(await view.getAttribute("data-scale")),
      panX: Number(await view.getAttribute("data-pan-x")),
      panY: Number(await view.getAttribute("data-pan-y")),
    };
    const expectedCenter = {
      x: (surfaceBox.width / 2 - toolbarTransform.panX) / toolbarTransform.scale,
      y: (surfaceBox.height / 2 - toolbarTransform.panY) / toolbarTransform.scale,
    };
    await addTextCard.click();
    const toolbarNode = view.locator('.canvas-node[data-node-id="text-3"]');
    const toolbarEditor = toolbarNode.locator(".canvas-node-text-editor");
    await expect(toolbarEditor).toBeFocused();
    const toolbarPosition = await toolbarNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(toolbarPosition.x + toolbarPosition.width / 2).toBeCloseTo(expectedCenter.x, 3);
    expect(toolbarPosition.y + toolbarPosition.height / 2).toBeCloseTo(expectedCenter.y, 3);
    await toolbarEditor.press("Escape");
    await expect(toolbarNode).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes).toHaveLength(2);

    // Escape restores an existing card without persisting the draft.
    const existingNode = view.locator('.canvas-node[data-node-id="text-1"]');
    await existingNode.dblclick();
    const existingEditor = existingNode.locator(".canvas-node-text-editor");
    await existingEditor.fill("Changed draft");
    await existingEditor.press("Escape");
    await expect(existingNode.locator(".canvas-node-text")).toHaveText("Original");
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "text-1").text).toBe("Original");

    // Outside click commits toolbar-authored Markdown and keeps the reused
    // collision-safe id stable on disk.
    await addTextCard.click();
    const committedToolbarNode = view.locator('.canvas-node[data-node-id="text-3"]');
    const committedToolbarEditor = committedToolbarNode.locator(".canvas-node-text-editor");
    await committedToolbarEditor.fill("Toolbar **card**");
    await window.mouse.click(surfaceBox.x + 20, surfaceBox.y + 20);
    await expect(committedToolbarNode.locator(".canvas-node-text strong")).toHaveText("card");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(3);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["text-1", "text-2", "text-3"]);
    expect(saved.nodes.find((node: { id: string }) => node.id === "text-1").vendorNode).toBe("keep");

    // A full renderer reload reads the persisted cards and mounts one toolbar.
    await window.reload();
    await window.locator('.nav-file-title[data-path="Authoring.canvas"]').click();
    await expect(window.locator('.canvas-node[data-node-id="text-2"] .canvas-node-text h1')).toHaveText("Created at point");
    await expect(window.locator('.canvas-node[data-node-id="text-3"] .canvas-node-text strong')).toHaveText("card");
    await expect(window.locator(".canvas-view").getByRole("button", { name: "Add text card" })).toHaveCount(1);

    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
