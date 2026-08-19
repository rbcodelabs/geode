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

async function openConvert(view: Locator, page: Page): Promise<Locator> {
  await view.locator('.canvas-node[data-node-id="convert-me"]').click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).toHaveText(["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]);
  await page.locator(".context-menu-item", { hasText: /^Convert to file…$/ }).click();
  const prompt = page.locator(".prompt-input");
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveAttribute("placeholder", "File name…");
  await expect(prompt).toHaveValue("Untitled");
  return prompt;
}

test("converts a Canvas text card in place to a collision-safe sibling note", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-convert-file-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-convert-file-user-"));
  const boardsDir = path.join(vaultDir, "Boards");
  fs.mkdirSync(boardsDir, { recursive: true });
  const canvasPath = path.join(boardsDir, "Ideas.canvas");
  const textBytes = "# Converted\n\nUnicode café\n\nTrailing spaces  \n";
  fs.writeFileSync(path.join(boardsDir, "Converted.md"), "Existing\n");
  fs.writeFileSync(path.join(boardsDir, "Converted 1.md"), "Existing collision\n");
  fs.writeFileSync(path.join(boardsDir, "Existing.md"), "# Existing\n");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      {
        id: "convert-me", type: "text", x: 40, y: 60, width: 310, height: 190,
        text: textBytes, color: "4", vendorNode: { keep: [1, { deep: true }] },
      },
      { id: "group", type: "group", x: 430, y: 40, width: 260, height: 180, label: "Keep group", vendorGroup: true },
      { id: "existing-note", type: "file", x: 760, y: 40, width: 300, height: 220, file: "Boards/Existing.md", vendorFile: ["keep"] },
      { id: "web", type: "link", x: 430, y: 320, width: 320, height: 160, url: "https://example.com/", vendorWeb: true },
    ],
    edges: [
      { id: "edge-1", fromNode: "convert-me", fromSide: "right", toNode: "group", toSide: "left", label: "Keep", vendorEdge: { deep: true } },
      { id: "edge-2", fromNode: "group", toNode: "web", vendorOtherEdge: ["keep"] },
    ],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-folder-title:has-text("Boards")').click();
    await window.locator('.nav-file-title[data-path="Boards/Ideas.canvas"]').click();
    let view = window.locator(".canvas-view");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    const originalDisk = fs.readFileSync(canvasPath, "utf8");
    const originalFiles = fs.readdirSync(boardsDir).sort();

    // Only text cards expose the action, immediately before Delete.
    for (const [id, actions] of [
      ["group", ["Zoom to selection", "Set background", "Delete"]],
      ["existing-note", ["Zoom to selection", "Swap file", "Create group", "Delete"]],
      ["web", ["Zoom to selection", "Open in browser", "Create group", "Delete"]],
    ] as Array<[string, string[]]>) {
      await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
      await expect(window.locator(".context-menu-item")).toHaveText(actions);
      await view.locator(".view-header").click();
    }

    // Cancel, empty, path-separator, and invalid-character submissions create
    // no file and leave Canvas bytes, selection, and camera untouched.
    let prompt = await openConvert(view, window);
    const selectionBeforeCancel = await view.locator(".canvas-node.is-selected").getAttribute("data-node-id");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(originalDisk);
    expect(fs.readdirSync(boardsDir).sort()).toEqual(originalFiles);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(await view.locator(".canvas-node.is-selected").getAttribute("data-node-id")).toBe(selectionBeforeCancel);

    for (const invalid of ["   ", "Bad/name.md", "Bad:name.md"]) {
      prompt = await openConvert(view, window);
      await prompt.fill(invalid);
      await prompt.press("Enter");
      await expect(window.locator(".notice", { hasText: "valid file name" }).last()).toBeVisible();
      expect(fs.readFileSync(canvasPath, "utf8")).toBe(originalDisk);
      expect(fs.readdirSync(boardsDir).sort()).toEqual(originalFiles);
      expect(await camera(view)).toEqual(transformedCamera);
      await expect(view.locator('.canvas-node[data-node-id="convert-me"]')).toHaveClass(/canvas-node-text/);
    }

    // One trailing .md is stripped before collision-safe sibling placement.
    prompt = await openConvert(view, window);
    await prompt.fill("  Converted.md  ");
    await prompt.press("Enter");
    const createdRelativePath = "Boards/Converted 2.md";
    const createdPath = path.join(vaultDir, createdRelativePath);
    await expect.poll(() => fs.existsSync(createdPath)).toBe(true);
    expect(fs.readFileSync(createdPath, "utf8")).toBe(textBytes);

    const converted = view.locator('.canvas-node[data-node-id="convert-me"]');
    await expect(converted).toHaveClass(/canvas-node-file/);
    await expect(converted.locator(".canvas-node-note h1")).toHaveText("Converted");
    await expect(converted.locator(".canvas-node-note")).toContainText("Unicode café");
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    await expect(converted).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "convert-me")?.type ?? null).toBe("file");
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const expectedConverted = { ...initial.nodes[0], type: "file", file: createdRelativePath } as Record<string, unknown>;
    delete expectedConverted.text;
    expect(Object.hasOwn(expectedConverted, "subpath")).toBe(false);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.nodes[0]).toEqual(expectedConverted);
    expect(saved.nodes.slice(1)).toEqual(initial.nodes.slice(1));
    expect(saved.edges).toEqual(initial.edges);
    await converted.click({ button: "right", position: { x: 30, y: 30 } });
    await expect(window.locator(".context-menu-item")).toHaveText(["Zoom to selection", "Swap file", "Create group", "Delete"]);
    await view.locator(".view-header").click();

    await window.reload();
    await window.locator('.nav-folder-title:has-text("Boards")').click();
    await window.locator('.nav-file-title[data-path="Boards/Ideas.canvas"]').click();
    view = window.locator(".canvas-view");
    const reloaded = view.locator('.canvas-node[data-node-id="convert-me"]');
    await expect(reloaded.locator(".canvas-node-note h1")).toHaveText("Converted");
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual({ scale: "1", panX: "80", panY: "80" });
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);

    const tabsBefore = await window.locator(".workspace-split.mod-root .workspace-tab-header").count();
    await reloaded.dblclick();
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header")).toHaveCount(tabsBefore + 1);
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path ?? null)).toBe(createdRelativePath);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
