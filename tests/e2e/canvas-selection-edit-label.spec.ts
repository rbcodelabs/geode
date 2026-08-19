import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";

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

async function controlNames(view: Locator): Promise<string[]> {
  return view.locator(".canvas-selection-controls > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? ""));
}

test("edits the selected Canvas edge label through floating selection controls", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-edit-label-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-selection-edit-label-user-"));
  const canvasPath = path.join(vaultDir, "Selection label.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "source", type: "text", x: -300, y: -100, width: 220, height: 140, text: "Source", color: "1", vendorSource: [1, 2] },
      { id: "target", type: "text", x: 520, y: 260, width: 260, height: 180, text: "Target", color: "tomato", vendorTarget: { keep: true } },
    ],
    edges: [
      {
        id: "edge-edit", fromNode: "source", fromSide: "right", fromEnd: "none",
        toNode: "target", toSide: "left", toEnd: "arrow", label: "Original", color: "5",
        vendorEdge: { deep: ["keep"] },
      },
      {
        id: "edge-keep", fromNode: "target", fromSide: "top", fromEnd: "none",
        toNode: "source", toSide: "bottom", toEnd: "arrow", color: "2", vendorKeepEdge: true,
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

    await window.locator('.nav-file-title[data-path="Selection label.canvas"]').click();
    let view = window.locator(".canvas-view");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    await window.evaluate(() => {
      const w = window as any;
      w.__canvasLabelWrites = 0;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Selection label.canvas") w.__canvasLabelWrites += 1;
        return modify(file, data);
      };
    });

    // Node selections retain the established exact two-button controls.
    await view.locator('.canvas-node[data-node-id="target"]').click({ position: { x: 40, y: 40 } });
    await expect(view.locator('.canvas-node[data-node-id="target"]')).toHaveClass(/is-selected/);
    expect(await controlNames(view)).toEqual(["Set color", "Remove"]);
    await expect(view.getByRole("button", { name: "Edit label", exact: true })).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    // Selecting an edge switches the fixed controls to the exact edge-only
    // action set without altering the document or transformed camera.
    await view.locator('.canvas-edge-hit[data-edge-id="edge-edit"]').dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-edit"]')).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);
    const editLabel = view.getByRole("button", { name: "Edit label", exact: true });
    await expect(editLabel).toHaveCount(1);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(await window.evaluate(() => (window as any).__canvasLabelWrites)).toBe(0);

    // Opening the shared label editor is prefilled and Escape is entirely
    // inert: selection, camera, bytes, and write count do not change.
    await editLabel.click();
    let prompt = window.locator(".prompt-input");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAttribute("placeholder", "Edge label…");
    await expect(prompt).toHaveValue("Original");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await prompt.fill("Must not persist");
    await prompt.press("Escape");
    await expect(prompt).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-edit"]')).toHaveClass(/is-selected/);
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);
    expect(await window.evaluate(() => (window as any).__canvasLabelWrites)).toBe(0);

    // Enter trims and persists exactly once while preserving every unrelated
    // field, array position, selection, and camera coordinate.
    await editLabel.click();
    prompt = window.locator(".prompt-input");
    await prompt.fill("  Updated label  ");
    await prompt.press("Enter");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-edit"]')).toHaveText("Updated label");
    await expect.poll(() => readCanvas(canvasPath)?.edges[0]?.label ?? null).toBe("Updated label");
    expect(await window.evaluate(() => (window as any).__canvasLabelWrites)).toBe(1);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-edit"]')).toHaveClass(/is-selected/);
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved).toEqual({
      ...initial,
      edges: [{ ...initial.edges[0], label: "Updated label" }, initial.edges[1]],
    });

    // An empty submission removes only the optional label and performs one
    // further write. The edge and its controls stay selected immediately.
    await view.getByRole("button", { name: "Edit label", exact: true }).click();
    prompt = window.locator(".prompt-input");
    await expect(prompt).toHaveValue("Updated label");
    await prompt.fill("   ");
    await prompt.press("Enter");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-edit"]')).toHaveCount(0);
    await expect.poll(() => Object.hasOwn(readCanvas(canvasPath)?.edges[0] ?? {}, "label")).toBe(false);
    expect(await window.evaluate(() => (window as any).__canvasLabelWrites)).toBe(2);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-edit"]')).toHaveClass(/is-selected/);
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const { label: _removed, ...edgeWithoutLabel } = initial.edges[0];
    expect(saved).toEqual({ ...initial, edges: [edgeWithoutLabel, initial.edges[1]] });

    await window.reload();
    await window.locator('.nav-file-title[data-path="Selection label.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-edge-label[data-edge-id="edge-edit"]')).toHaveCount(0);
    await expect(view.locator(".canvas-selection-controls")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
