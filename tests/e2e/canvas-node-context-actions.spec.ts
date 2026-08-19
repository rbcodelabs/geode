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

async function dismissMenu(view: Locator, page: Page): Promise<void> {
  await view.locator(".view-header").click();
  await expect(page.locator(".context-menu-item")).toHaveCount(0);
}

async function expectNodeMenu(view: Locator, page: Page, id: string, actions: string[]): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).toHaveText(actions);
}

async function marquee(view: Locator, surface: Locator, page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const box = (await surface.boundingBox())!;
  const scale = Number(await view.getAttribute("data-scale"));
  const panX = Number(await view.getAttribute("data-pan-x"));
  const panY = Number(await view.getAttribute("data-pan-y"));
  const screen = (point: { x: number; y: number }) => ({
    x: box.x + panX + point.x * scale,
    y: box.y + panY + point.y * scale,
  });
  const a = screen(from);
  const b = screen(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

test("exposes exact Canvas node actions and deletes the context selection", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-node-actions-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-node-actions-user-"));
  const canvasPath = path.join(vaultDir, "Node actions.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n\nSafe **Markdown**.\n");
  fs.writeFileSync(path.join(vaultDir, "Photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "text-a", type: "text", x: 0, y: 0, width: 180, height: 100, text: "A", vendorA: { keep: true } },
      { id: "text-b", type: "text", x: 220, y: 0, width: 180, height: 100, text: "B", vendorB: ["keep"] },
      { id: "group", type: "group", x: 0, y: 180, width: 300, height: 180, label: "Group", vendorGroup: true },
      { id: "note", type: "file", x: 460, y: 0, width: 300, height: 220, file: "Note.md", subpath: "#Note", vendorNote: { keep: true } },
      { id: "media", type: "file", x: 820, y: 0, width: 300, height: 220, file: "Photo.png", vendorMedia: 1 },
      { id: "web-valid", type: "link", x: 440, y: 300, width: 320, height: 160, url: "https://example.com/path", vendorWeb: "keep" },
      { id: "web-invalid", type: "link", x: 820, y: 300, width: 300, height: 160, url: "javascript:alert(1)", vendorInvalid: true },
      { id: "sole", type: "text", x: 0, y: 500, width: 180, height: 100, text: "Sole", vendorSole: true },
      { id: "keeper", type: "text", x: 260, y: 500, width: 180, height: 100, text: "Keeper", vendorKeeper: { deep: [1, 2] } },
    ],
    edges: [
      { id: "edge-internal", fromNode: "text-a", toNode: "text-b", vendorInternal: true },
      { id: "edge-a-keeper", fromNode: "text-a", toNode: "keeper", vendorAEdge: { keep: true } },
      { id: "edge-b-note", fromNode: "text-b", toNode: "note", vendorBEdge: ["keep"] },
      { id: "edge-note-keeper", fromNode: "note", toNode: "keeper", label: "Unaffected", vendorNoteEdge: true },
      { id: "edge-sole-keeper", fromNode: "sole", toNode: "keeper", vendorSoleEdge: true },
      { id: "edge-keeper-web", fromNode: "keeper", toNode: "web-valid", vendorWebEdge: { keep: true } },
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

    await window.locator('.nav-file-title[data-path="Node actions.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const cameraBeforeActions = await camera(view);
    const diskBeforeActions = fs.readFileSync(canvasPath, "utf8");

    // Every representative node type ends with Delete. Only resolved Markdown
    // and valid canonical web cards expose their respective middle actions.
    for (const [id, actions] of [
      ["text-a", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]],
      ["group", ["Zoom to selection", "Delete"]],
      ["note", ["Zoom to selection", "Swap file", "Create group", "Delete"]],
      ["media", ["Zoom to selection", "Swap file", "Create group", "Delete"]],
      ["web-valid", ["Zoom to selection", "Open in browser", "Create group", "Delete"]],
      ["web-invalid", ["Zoom to selection", "Create group", "Delete"]],
    ] as Array<[string, string[]]>) {
      await expectNodeMenu(view, window, id, actions);
      await dismissMenu(view, window);
    }

    // Open in browser always uses the OS route, even when Web Viewer is on,
    // and leaves selection, camera, renderer URL, and Canvas bytes untouched.
    const rendererUrl = await window.evaluate(() => location.href);
    await window.evaluate(() => {
      const w = window as any;
      w.__nodeActionExternal = [];
      w.__nodeActionWebViewer = [];
      w.app.settings.webViewer.openLinksInApp = true;
      w.app.openWebViewer = (url?: string) => { w.__nodeActionWebViewer.push(url ?? ""); return Promise.resolve(); };
      w.geode.openExternal = (url: string) => { w.__nodeActionExternal.push(url); return Promise.resolve(); };
    });
    await expectNodeMenu(view, window, "web-valid", ["Zoom to selection", "Open in browser", "Create group", "Delete"]);
    const selectedBeforeOpen = await selectedIds(view);
    await window.locator(".context-menu-item", { hasText: /^Open in browser$/ }).click();
    expect(await window.evaluate(() => (window as any).__nodeActionExternal)).toEqual(["https://example.com/path"]);
    expect(await window.evaluate(() => (window as any).__nodeActionWebViewer)).toEqual([]);
    expect(await window.evaluate(() => location.href)).toBe(rendererUrl);
    expect(await selectedIds(view)).toEqual(selectedBeforeOpen);
    expect(await camera(view)).toEqual(cameraBeforeActions);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBeforeActions);

    // Context Delete on a selected member removes the full node selection and
    // every incident edge, with no write before the action is chosen.
    await marquee(view, surface, window, { x: -20, y: -20 }, { x: 420, y: 120 });
    expect(await selectedIds(view)).toEqual(["text-a", "text-b"]);
    const beforeMultiDelete = fs.readFileSync(canvasPath, "utf8");
    await expectNodeMenu(view, window, "text-a", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]);
    expect(await selectedIds(view)).toEqual(["text-a", "text-b"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeMultiDelete);
    await window.locator(".context-menu-item", { hasText: /^Delete$/ }).click();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.map((node: { id: string }) => node.id) ?? null).toEqual(
      initial.nodes.filter((node) => !["text-a", "text-b"].includes(node.id)).map((node) => node.id),
    );
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual(cameraBeforeActions);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes).toEqual(initial.nodes.filter((node) => !["text-a", "text-b"].includes(node.id)));
    expect(saved.edges).toEqual(initial.edges.filter((edge) => !["text-a", "text-b"].includes(edge.fromNode) && !["text-a", "text-b"].includes(edge.toNode)));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    // Right-clicking an unselected node makes it the sole target; a prior
    // in-memory selection survives until that context click and is not deleted.
    await marquee(view, surface, window, { x: 245, y: 485 }, { x: 455, y: 620 });
    expect(await selectedIds(view)).toEqual(["keeper"]);
    const beforeSoleDelete = fs.readFileSync(canvasPath, "utf8");
    await expectNodeMenu(view, window, "sole", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]);
    expect(await selectedIds(view)).toEqual(["sole"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeSoleDelete);
    await window.locator(".context-menu-item", { hasText: /^Delete$/ }).click();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.some((node: { id: string }) => node.id === "sole") ?? null).toBe(false);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual(cameraBeforeActions);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes).toEqual(initial.nodes.filter((node) => !["text-a", "text-b", "sole"].includes(node.id)));
    expect(saved.edges).toEqual(initial.edges.filter((edge) => !["text-a", "text-b", "sole"].includes(edge.fromNode) && !["text-a", "text-b", "sole"].includes(edge.toNode)));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Node actions.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator(".canvas-node")).toHaveCount(6);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(await camera(view)).toEqual({ scale: "1", panX: "80", panY: "80" });
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
