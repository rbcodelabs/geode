import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readText(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

async function camera(view: Locator): Promise<Record<string, string | null>> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function expectWriteCount(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as any).__canvasHistoryWrites)).toBe(count);
}

async function expectSnapshot(file: string, snapshot: string): Promise<void> {
  await expect.poll(() => readText(file)).toBe(snapshot);
}

async function pressHistory(page: Page, shortcut: string, writes: number, file: string, snapshot: string): Promise<void> {
  await page.locator(".canvas-surface").focus();
  await page.keyboard.press(shortcut);
  await expectWriteCount(page, writes);
  await expectSnapshot(file, snapshot);
}

test("undoes and redoes exact Canvas document snapshots within one view session", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-history-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-history-user-"));
  const canvasPath = path.join(vaultDir, "History.canvas");
  const initial = {
    vendorCanvas: { keep: { nested: true } },
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 180, height: 100, text: "A", color: "1", vendorA: { keep: true } },
      { id: "b", type: "text", x: 280, y: 20, width: 190, height: 110, text: "B", color: "2", vendorB: ["keep"] },
    ],
    edges: [{
      id: "edge-ab", fromNode: "a", fromSide: "right", fromEnd: "none",
      toNode: "b", toSide: "left", toEnd: "arrow", color: "3", label: "Exact", vendorEdge: { keep: [1] },
    }],
  };
  const initialText = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(canvasPath, initialText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await window.locator('.nav-file-title[data-path="History.canvas"]').click();
    let view = window.locator(".canvas-view");
    await window.evaluate(() => {
      const w = window as any;
      w.__canvasHistoryWrites = 0;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "History.canvas") w.__canvasHistoryWrites += 1;
        return modify(file, data);
      };
    });
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);

    // Author, move, then delete a card with its incident edge. Each changed
    // persist creates one exact snapshot boundary.
    await view.getByRole("button", { name: "Add text card" }).click();
    await view.locator(".canvas-node-text-editor").fill("# History card\n\nExact body");
    await view.locator(".canvas-node-text-editor").press("ControlOrMeta+Enter");
    await expectWriteCount(window, 1);
    const authoredText = readText(canvasPath)!;
    const authored = JSON.parse(authoredText);
    expect(authored.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(authored.nodes.slice(0, 2)).toEqual(initial.nodes);
    expect(authored.edges).toEqual(initial.edges);

    const authoredNode = view.locator('.canvas-node[data-node-id="text-1"]');
    const box = (await authoredNode.boundingBox())!;
    await window.mouse.move(box.x + 30, box.y + 30);
    await window.mouse.down();
    await window.mouse.move(box.x + 110, box.y + 85, { steps: 4 });
    await window.mouse.up();
    await expectWriteCount(window, 2);
    const movedText = readText(canvasPath)!;
    const moved = JSON.parse(movedText);
    expect(moved.nodes.find((node: { id: string }) => node.id === "text-1")).not.toEqual(
      authored.nodes.find((node: { id: string }) => node.id === "text-1"),
    );

    await view.locator('.canvas-node[data-node-id="a"]').click({ button: "right", position: { x: 25, y: 25 } });
    await window.locator(".context-menu-item", { hasText: /^Delete$/ }).click();
    await expectWriteCount(window, 3);
    const deletedText = readText(canvasPath)!;
    const deleted = JSON.parse(deletedText);
    expect(deleted.nodes.map((node: { id: string }) => node.id)).toEqual(["b", "text-1"]);
    expect(deleted.edges).toEqual([]);
    expect(deleted.nodes[0]).toEqual(initial.nodes[1]);
    expect(deleted.vendorCanvas).toEqual(initial.vendorCanvas);

    // The current textarea consumes Mod+Z itself; Canvas history and disk do
    // not change until the focused Canvas surface receives the shortcut.
    await view.locator('.canvas-node[data-node-id="text-1"]').click({ button: "right", position: { x: 25, y: 25 } });
    await window.locator(".context-menu-item", { hasText: /^Edit$/ }).click();
    const editor = view.locator(".canvas-node-text-editor");
    await editor.fill("Transient draft");
    await editor.press("ControlOrMeta+z");
    expect(await window.evaluate(() => (window as any).__canvasHistoryWrites)).toBe(3);
    expect(readText(canvasPath)).toBe(deletedText);
    await editor.press("Escape");

    // Multi-step undo/redo restores exact serialized snapshots, clears all
    // selection/editor state, preserves camera, and writes exactly once.
    await pressHistory(window, "ControlOrMeta+z", 4, canvasPath, movedText);
    await expect(view.locator('.canvas-node[data-node-id="a"]')).toBeVisible();
    await expect(view.locator('.canvas-edge-hit[data-edge-id="edge-ab"]')).toHaveCount(1);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected, .canvas-selection-controls, .canvas-node-text-editor")).toHaveCount(0);
    expect(await camera(view)).toEqual(transformedCamera);
    await pressHistory(window, "ControlOrMeta+z", 5, canvasPath, authoredText);
    await pressHistory(window, "ControlOrMeta+z", 6, canvasPath, initialText);
    await expect(view.locator('.canvas-node[data-node-id="text-1"]')).toHaveCount(0);
    await pressHistory(window, "ControlOrMeta+Shift+z", 7, canvasPath, authoredText);
    await pressHistory(window, "ControlOrMeta+y", 8, canvasPath, movedText);
    await pressHistory(window, "ControlOrMeta+y", 9, canvasPath, deletedText);

    // A new edit after undo invalidates redo. Reapplying the same color is a
    // no-op persist and must not consume another history step or disk write.
    await pressHistory(window, "ControlOrMeta+z", 10, canvasPath, movedText);
    await view.locator('.canvas-node[data-node-id="text-1"]').click({ button: "right", position: { x: 25, y: 25 } });
    await view.locator(".view-header").click();
    await view.getByRole("button", { name: "Set color", exact: true }).click();
    await view.getByRole("button", { name: "Color 4", exact: true }).click();
    await expectWriteCount(window, 11);
    const recoloredText = readText(canvasPath)!;
    await view.getByRole("button", { name: "Set color", exact: true }).click();
    await view.getByRole("button", { name: "Color 4", exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await window.evaluate(() => (window as any).__canvasHistoryWrites)).toBe(11);
    await view.locator(".canvas-surface").focus();
    await window.keyboard.press("ControlOrMeta+y");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await window.evaluate(() => (window as any).__canvasHistoryWrites)).toBe(11);
    expect(readText(canvasPath)).toBe(recoloredText);
    await pressHistory(window, "ControlOrMeta+z", 12, canvasPath, movedText);

    // A genuine external Canvas modification resets both stacks. The external
    // text renders without an internal write, and undo is thereafter inert.
    const external = JSON.parse(movedText);
    external.nodes.unshift({ id: "external", type: "group", x: -100, y: -100, width: 200, height: 160, label: "External", vendorExternal: true });
    const externalText = JSON.stringify(external, null, 2) + "\n";
    fs.writeFileSync(canvasPath, externalText);
    await expect(view.locator('.canvas-node[data-node-id="external"]')).toBeVisible();
    expect(await window.evaluate(() => (window as any).__canvasHistoryWrites)).toBe(12);
    await view.locator(".canvas-surface").focus();
    await window.keyboard.press("ControlOrMeta+z");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readText(canvasPath)).toBe(externalText);
    expect(await window.evaluate(() => (window as any).__canvasHistoryWrites)).toBe(12);

    // History is view-session-only: one new edit is persisted, but a reload
    // starts with empty stacks and cannot undo it.
    await view.locator('.canvas-node[data-node-id="text-1"]').click({ button: "right", position: { x: 25, y: 25 } });
    await view.locator(".view-header").click();
    await view.getByRole("button", { name: "Set color", exact: true }).click();
    await view.getByRole("button", { name: "Color 5", exact: true }).click();
    await expectWriteCount(window, 13);
    const beforeReload = readText(canvasPath)!;
    await window.reload();
    await expect.poll(() => window.evaluate(() => (window as any).app?.workspace?.layoutReady ?? false)).toBe(true);
    await window.locator('.nav-file-title[data-path="History.canvas"]').click();
    view = window.locator(".canvas-view");
    await view.locator(".canvas-surface").focus();
    await window.keyboard.press("ControlOrMeta+z");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readText(canvasPath)).toBe(beforeReload);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
