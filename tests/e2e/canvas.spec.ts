import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("opens and edits a JSON Canvas from the file explorer", async () => {
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-user-"));
  const canvasPath = path.join(vaultDir, "Ideas.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Linked note\n");
  fs.writeFileSync(canvasPath, JSON.stringify({
    nodes: [
      { id: "group", type: "group", x: -30, y: -30, width: 650, height: 340, label: "Planning" },
      { id: "text", type: "text", x: 0, y: 0, width: 220, height: 120, text: "First idea" },
      { id: "file", type: "file", x: 300, y: 0, width: 220, height: 120, file: "Note.md" },
      { id: "link", type: "link", x: 0, y: 170, width: 220, height: 100, url: "https://example.com" },
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
    await expect(view.locator(".canvas-node")).toHaveCount(4);
    await expect(view.locator(".canvas-edge")).toHaveCount(1);
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
    await window.mouse.down();
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 80, surfaceBox.y + surfaceBox.height - 70);
    await window.mouse.up();
    expect(Number(await view.getAttribute("data-pan-x"))).toBeLessThan(panBefore);
    await surface.hover();
    await window.mouse.wheel(0, -400);
    await expect.poll(() => view.getAttribute("data-scale")).not.toBe("1");

    await expect.poll(() => {
      const doc = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
      return doc.nodes.find((node: { id: string }) => node.id === "text")?.width;
    }).toBeGreaterThan(220);
    await expect.poll(() => {
      const doc = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
      return doc.nodes.find((node: { id: string; text?: string }) => node.id === "text")?.text;
    }).toBe("Revised idea");
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
