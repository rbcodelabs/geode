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

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

async function openNodeMenu(node: Locator): Promise<void> {
  await node.click({ button: "right", position: { x: 30, y: 30 } });
}

async function choosePromptResult(page: Page, name: string): Promise<void> {
  const input = page.locator(".prompt-input");
  await input.fill(name);
  await page.locator(".prompt-result", { hasText: name }).click();
}

test("swaps only resolved Markdown Canvas file cards through the exact context action", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-swap-file-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-swap-file-user-"));
  const canvasPath = path.join(vaultDir, "Swap file.canvas");
  fs.writeFileSync(path.join(vaultDir, "Old.md"), "# Intro\n\nOld intro.\n\n## Section\n\nOld **section**.\n");
  fs.writeFileSync(path.join(vaultDir, "New.md"), "# Replacement note\n\nNew **whole note**.\n");
  fs.writeFileSync(path.join(vaultDir, "Photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  fs.writeFileSync(path.join(vaultDir, "Archive.bin"), Buffer.from([1, 2, 3, 4]));
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      {
        id: "note",
        type: "file",
        x: 40,
        y: 60,
        width: 360,
        height: 280,
        file: "Old.md",
        subpath: "#Section",
        color: "4",
        vendorNode: { keep: [1, { deep: true }] },
      },
      { id: "media", type: "file", x: 480, y: 40, width: 300, height: 220, file: "Photo.png", vendorMedia: true },
      { id: "missing", type: "file", x: 40, y: 420, width: 300, height: 180, file: "Missing.md", vendorMissing: true },
      { id: "other", type: "file", x: 440, y: 380, width: 280, height: 160, file: "Archive.bin", vendorOther: true },
      { id: "text", type: "text", x: 820, y: 220, width: 200, height: 120, text: "Keep", vendorText: true },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "note",
      fromSide: "right",
      fromEnd: "none",
      toNode: "text",
      toSide: "left",
      toEnd: "arrow",
      label: "Keep edge",
      color: "2",
      vendorEdge: { keep: true },
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

    await window.locator('.nav-file-title[data-path="Swap file.canvas"]').click();
    let view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const note = view.locator('.canvas-node[data-node-id="note"]');
    await expect(note.locator(".canvas-node-note h2")).toHaveText("Section");
    await expect(note.locator(".canvas-node-note strong")).toHaveText("section");

    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 60, surfaceBox.y + surfaceBox.height - 70);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 100, surfaceBox.y + surfaceBox.height - 100);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);
    const diskBefore = fs.readFileSync(canvasPath, "utf8");

    // A selected set remains intact while opening and canceling the note-only
    // picker. Non-Markdown vault files never appear in its results.
    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    const allIds = initial.nodes.map((node) => node.id).sort();
    expect(await selectedIds(view)).toEqual(allIds);
    await openNodeMenu(note);
    await expect(window.locator(".context-menu-item")).toHaveText(["Zoom to selection", "Swap file"]);
    await window.locator(".context-menu-item", { hasText: /^Swap file$/ }).click();
    const noteResults = await window.locator(".prompt-result").allInnerTexts();
    expect(noteResults).toEqual(expect.arrayContaining(["Old.md", "New.md"]));
    expect(noteResults.some((item) => /\.(png|bin|canvas)$/i.test(item))).toBe(false);
    await window.keyboard.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(await selectedIds(view)).toEqual(allIds);
    expect(await camera(view)).toEqual(transformedCamera);

    // Media, unresolved Markdown, and other generic files expose only the
    // existing node action, never Swap file.
    await surface.click({ position: { x: 10, y: 10 } });
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    for (const id of ["media", "missing", "other"]) {
      await openNodeMenu(view.locator(`.canvas-node[data-node-id="${id}"]`));
      await expect(window.locator(".context-menu-item")).toHaveText(["Zoom to selection"]);
    }
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);

    // Right-clicking the now-unselected note selects only it. Swapping removes
    // the stale subpath while preserving camera, selection, and every other
    // node/edge field and array position.
    await openNodeMenu(note);
    expect(await selectedIds(view)).toEqual(["note"]);
    await window.locator(".context-menu-item", { hasText: /^Swap file$/ }).click();
    await choosePromptResult(window, "New.md");
    await expect(note.locator(".canvas-node-note h1")).toHaveText("Replacement note");
    await expect(note.locator(".canvas-node-note strong")).toHaveText("whole note");
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "note")?.file ?? null).toBe("New.md");
    expect(await selectedIds(view)).toEqual(["note"]);
    expect(await camera(view)).toEqual(transformedCamera);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const expectedNote = { ...initial.nodes[0], file: "New.md" } as Record<string, unknown>;
    delete expectedNote.subpath;
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.nodes[0]).toEqual(expectedNote);
    expect(saved.nodes.slice(1)).toEqual(initial.nodes.slice(1));
    expect(saved.edges).toEqual(initial.edges);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Swap file.canvas"]').click();
    view = window.locator(".canvas-view");
    const reloadedNote = view.locator('.canvas-node[data-node-id="note"]');
    await expect(reloadedNote.locator(".canvas-node-note h1")).toHaveText("Replacement note");
    await expect(reloadedNote.locator(".canvas-node-note strong")).toHaveText("whole note");
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual({ scale: "1", panX: "80", panY: "80" });
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);

    // Existing double-click behavior follows the swapped file path.
    const tabsBefore = await window.locator(".workspace-split.mod-root .workspace-tab-header").count();
    await reloadedNote.dblclick();
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header")).toHaveCount(tabsBefore + 1);
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("New.md");
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
