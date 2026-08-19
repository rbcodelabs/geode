import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<{ scale: string | null; panX: string | null; panY: string | null }> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function openMenu(page: Page, view: Locator, id: string, expected: string[]): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).toHaveText(expected);
}

async function dismissMenu(page: Page, view: Locator): Promise<void> {
  await view.locator(".view-header").click();
  await expect(page.locator(".context-menu-item")).toHaveCount(0);
}

test("edits only Canvas text cards through the exact context action", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-text-context-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-text-context-user-"));
  const canvasPath = path.join(vaultDir, "Text context.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const originalText = "# Original\n\nExact **text**.";
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "text-edit", type: "text", x: 0, y: 0, width: 260, height: 150, text: originalText, color: "3", vendorText: { deep: [1, { keep: true }] } },
      { id: "note", type: "file", x: 340, y: 0, width: 300, height: 220, file: "Note.md", color: "2", vendorNote: ["keep"] },
      { id: "web", type: "link", x: 0, y: 280, width: 320, height: 160, url: "https://example.com/path", color: "4", vendorWeb: true },
      { id: "group", type: "group", x: 390, y: 300, width: 280, height: 180, label: "Group", color: "5", vendorGroup: { keep: true } },
    ],
    edges: [{
      id: "edge-1", fromNode: "text-edit", fromSide: "right", fromEnd: "none",
      toNode: "note", toSide: "left", toEnd: "arrow", color: "6", vendorEdge: { keep: true },
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

    await window.locator('.nav-file-title[data-path="Text context.canvas"]').click();
    let view = window.locator(".canvas-view");
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__textContextWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Text context.canvas") (window as any).__textContextWrites += 1;
        return modify(file, data);
      };
    });
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    expect(Number(transformedCamera.scale)).not.toBe(1);

    // Edit is exact and text-only; established actions retain their order.
    await openMenu(window, view, "note", ["Zoom to selection", "Swap file", "Create group", "Delete"]);
    await dismissMenu(window, view);
    await openMenu(window, view, "web", ["Zoom to selection", "Open in browser", "Create group", "Delete"]);
    await dismissMenu(window, view);
    await openMenu(window, view, "group", ["Zoom to selection", "Set background", "Delete"]);
    await dismissMenu(window, view);

    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    await openMenu(window, view, "text-edit", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await window.locator(".context-menu-item", { hasText: /^Edit$/ }).click();

    let textNode = view.locator('.canvas-node[data-node-id="text-edit"]');
    let editor = textNode.locator(".canvas-node-text-editor");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(originalText);
    expect(await editor.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    }))).toEqual({ start: 0, end: originalText.length });
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    await expect(textNode).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
    expect(await window.evaluate(() => (window as any).__textContextWrites)).toBe(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await camera(view)).toEqual(transformedCamera);

    // Escape restores the exact pre-edit node and never writes the draft.
    await editor.fill("Changed draft");
    await editor.press("Escape");
    await expect(textNode.locator(".canvas-node-text h1")).toHaveText("Original");
    await expect(textNode.locator(".canvas-node-text strong")).toHaveText("text");
    expect(await window.evaluate(() => (window as any).__textContextWrites)).toBe(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await expect(textNode).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    // Ctrl/Cmd+Enter commits once, safely rerenders Markdown, and retains
    // context selection and camera without changing any non-text fields.
    const keyboardText = "# Keyboard commit\n\nSafe **bold** <script>window.__canvasTextScript = true</script>";
    await openMenu(window, view, "text-edit", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]);
    await window.locator(".context-menu-item", { hasText: /^Edit$/ }).click();
    editor = textNode.locator(".canvas-node-text-editor");
    await expect(editor).toHaveValue(originalText);
    await editor.fill(keyboardText);
    await editor.press("ControlOrMeta+Enter");
    await expect(textNode.locator(".canvas-node-text h1")).toHaveText("Keyboard commit");
    await expect(textNode.locator(".canvas-node-text strong")).toHaveText("bold");
    expect(await window.evaluate(() => (window as any).__canvasTextScript)).toBeUndefined();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "text-edit")?.text ?? null).toBe(keyboardText);
    expect(await window.evaluate(() => (window as any).__textContextWrites)).toBe(1);
    await expect(textNode).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    // Outside blur uses the same single-write commit path.
    const blurText = "Outside *blur* commit";
    await openMenu(window, view, "text-edit", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]);
    await window.locator(".context-menu-item", { hasText: /^Edit$/ }).click();
    editor = textNode.locator(".canvas-node-text-editor");
    await expect(editor).toHaveValue(keyboardText);
    await editor.fill(blurText);
    await editor.evaluate((element) => (element as HTMLTextAreaElement).blur());
    await expect(textNode.locator(".canvas-node-text em")).toHaveText("blur");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "text-edit")?.text ?? null).toBe(blurText);
    expect(await window.evaluate(() => (window as any).__textContextWrites)).toBe(2);
    await expect(textNode).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.nodes.slice(1)).toEqual(initial.nodes.slice(1));
    expect(saved.nodes[0]).toEqual({ ...initial.nodes[0], text: blurText });

    await window.reload();
    await window.locator('.nav-file-title[data-path="Text context.canvas"]').click();
    view = window.locator(".canvas-view");
    textNode = view.locator('.canvas-node[data-node-id="text-edit"]');
    await expect(textNode.locator(".canvas-node-text em")).toHaveText("blur");
    await expect(textNode.locator(".canvas-node-text")).toContainText("Outside blur commit");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(persistedText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
