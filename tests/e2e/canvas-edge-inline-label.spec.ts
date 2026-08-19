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

async function pathPoint(pathLocator: Locator): Promise<{ x: number; y: number }> {
  return pathLocator.evaluate((element) => {
    const edge = element as SVGPathElement;
    const point = edge.getPointAtLength(edge.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(edge.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
}

async function openInlineEditor(page: Page, hit: Locator): Promise<Locator> {
  const point = await pathPoint(hit);
  await page.mouse.dblclick(point.x, point.y);
  return page.locator(".canvas-edge-label-editor");
}

test("edits Canvas edge labels inline at the transformed path midpoint", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-inline-edge-label-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-inline-edge-label-user-"));
  const canvasPath = path.join(vaultDir, "Inline edge.canvas");
  const initial = {
    vendorCanvas: { preserve: { deep: true } },
    nodes: [
      { id: "source", type: "text", x: -180, y: 40, width: 220, height: 140, text: "Source", color: "2", vendorSource: [1, 2] },
      { id: "target", type: "text", x: 620, y: 360, width: 280, height: 180, text: "Target", vendorTarget: { keep: true } },
      { id: "other", type: "text", x: 560, y: -260, width: 240, height: 150, text: "Other", vendorOther: "keep" },
    ],
    edges: [
      {
        id: "edge-1", fromNode: "source", fromSide: "right", fromEnd: "none",
        toNode: "target", toSide: "left", toEnd: "arrow", label: "Initial label", color: "5",
        vendorEdge: { nested: true },
      },
      {
        id: "edge-2", fromNode: "source", fromSide: "top", fromEnd: "none",
        toNode: "other", toSide: "left", toEnd: "arrow", label: "Second", color: "#123456",
        vendorSecond: ["keep"],
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
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Inline edge.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasInlineLabelWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Inline edge.canvas") (window as any).__canvasInlineLabelWrites += 1;
        return modify(file, data);
      };
    });

    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + 90, surfaceBox.y + 80);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + 135, surfaceBox.y + 115);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);
    expect(Number(transformedCamera.scale)).toBeGreaterThan(1);

    let hit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
    const midpoint = await pathPoint(hit);
    let editor = await openInlineEditor(window, hit);
    await expect(editor).toHaveCount(1);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Initial label");
    expect(await editor.evaluate((input: HTMLInputElement) => ({ start: input.selectionStart, end: input.selectionEnd }))).toEqual({
      start: 0,
      end: "Initial label".length,
    });
    const editorBox = (await editor.boundingBox())!;
    expect(editorBox.x + editorBox.width / 2).toBeCloseTo(midpoint.x, 0);
    expect(editorBox.y + editorBox.height / 2).toBeCloseTo(midpoint.y, 0);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-1"]')).toHaveCount(2);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);

    // Opening and typing are transient; Escape cancels byte-identically while
    // retaining transformed camera and selected edge controls.
    await editor.fill("must not persist");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__canvasInlineLabelWrites)).toBe(0);
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-1"]')).toHaveText("Initial label");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-1"]')).toHaveCount(2);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    // Enter trims and commits exactly once, rerenders immediately, and
    // preserves the selected edge, endpoint controls, and camera.
    editor = await openInlineEditor(window, hit);
    await editor.fill("  Committed inline  ");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await editor.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-1"]')).toHaveText("Committed inline");
    await expect.poll(() => readCanvas(canvasPath)?.edges[0]?.label ?? null).toBe("Committed inline");
    expect(await window.evaluate(() => (window as any).__canvasInlineLabelWrites)).toBe(1);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-1"]')).toHaveCount(2);

    // Reopening the same edge cancels its prior transient editor; opening a
    // different edge also leaves exactly one editor and selects that edge.
    hit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
    editor = await openInlineEditor(window, hit);
    await editor.fill("discard same-edge transient");
    await hit.dispatchEvent("dblclick");
    await expect(view.locator(".canvas-edge-label-editor")).toHaveCount(1);
    editor = view.locator(".canvas-edge-label-editor");
    await expect(editor).toHaveValue("Committed inline");
    expect(await window.evaluate(() => (window as any).__canvasInlineLabelWrites)).toBe(1);

    const otherHit = view.locator('.canvas-edge-hit[data-edge-id="edge-2"]');
    await otherHit.dispatchEvent("dblclick");
    await expect(view.locator(".canvas-edge-label-editor")).toHaveCount(1);
    editor = view.locator(".canvas-edge-label-editor");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Second");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-2"]')).toHaveCount(2);
    expect(await window.evaluate(() => (window as any).__canvasInlineLabelWrites)).toBe(1);

    // Blur commits an empty value once by deleting the optional label field.
    await editor.fill("   ");
    await editor.evaluate((input: HTMLInputElement) => input.blur());
    await expect(editor).toHaveCount(0);
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect.poll(() => {
      const edge = readCanvas(canvasPath)?.edges.find((candidate: { id: string }) => candidate.id === "edge-2");
      return edge ? Object.hasOwn(edge, "label") : null;
    }).toBe(false);
    expect(await window.evaluate(() => (window as any).__canvasInlineLabelWrites)).toBe(2);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveClass(/is-selected/);
    await expect(view.locator('.canvas-edge-endpoint-handle.is-selected[data-edge-id="edge-2"]')).toHaveCount(2);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes).toEqual(initial.nodes);
    expect(saved.edges.map((edge: { id: string }) => edge.id)).toEqual(["edge-1", "edge-2"]);
    expect(saved.edges[0]).toEqual({ ...initial.edges[0], label: "Committed inline" });
    const expectedSecond = { ...initial.edges[1] } as Record<string, unknown>;
    delete expectedSecond.label;
    expect(saved.edges[1]).toEqual(expectedSecond);

    // A live transient editor is safely removed by reload without persistence;
    // the exact committed document and normal modal contracts survive.
    hit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
    editor = await openInlineEditor(window, hit);
    await editor.fill("reload must cancel");
    await window.reload();
    await window.locator('.nav-file-title[data-path="Inline edge.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator(".canvas-edge-label-editor")).toHaveCount(0);
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-1"]')).toHaveText("Committed inline");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
