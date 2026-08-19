import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Camera = { scale: number; panX: number; panY: number };

async function camera(view: Locator): Promise<Camera> {
  return {
    scale: Number(await view.getAttribute("data-scale")),
    panX: Number(await view.getAttribute("data-pan-x")),
    panY: Number(await view.getAttribute("data-pan-y")),
  };
}

async function selectInMemory(page: Page, view: Locator, id: string): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(view.locator(`.canvas-node[data-node-id="${id}"]`)).toHaveClass(/is-selected/);
}

async function wheel(page: Page, target: Locator, deltaY: number): Promise<void> {
  await target.hover();
  await page.mouse.wheel(0, deltaY);
}

async function scrollMetrics(target: Locator): Promise<{ top: number; client: number; scroll: number }> {
  return target.evaluate((element) => ({
    top: element.scrollTop,
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
}

test("routes plain wheel to selected overflowing Canvas text and note cards", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-card-scroll-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-card-scroll-user-"));
  const canvasPath = path.join(vaultDir, "Card scroll.canvas");
  const longText = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n\n");
  fs.writeFileSync(path.join(vaultDir, "Long.md"), `# Long note\n\n${longText}\n`);
  fs.writeFileSync(path.join(vaultDir, "Archive.bin"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(vaultDir, "Photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "long-text", type: "text", x: 0, y: 0, width: 260, height: 130, text: longText, color: "1", vendorText: true },
      { id: "note", type: "file", x: 340, y: 0, width: 300, height: 150, file: "Long.md", color: "2", vendorNote: true },
      { id: "media", type: "file", x: 700, y: 0, width: 260, height: 150, file: "Photo.png", vendorMedia: true },
      { id: "fallback", type: "file", x: 0, y: 230, width: 240, height: 120, file: "Archive.bin", vendorFallback: true },
      { id: "web", type: "link", x: 320, y: 230, width: 280, height: 130, url: "https://example.com/", vendorWeb: true },
      { id: "group", type: "group", x: 690, y: 230, width: 270, height: 150, label: "Group", vendorGroup: true },
      { id: "short-text", type: "text", x: 320, y: 450, width: 260, height: 130, text: "Short text", color: "3", vendorShort: true },
    ],
    edges: [{
      id: "edge-1", fromNode: "long-text", fromSide: "right", fromEnd: "none",
      toNode: "note", toSide: "left", toEnd: "arrow", color: "6", vendorEdge: true,
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

    await window.locator('.nav-file-title[data-path="Card scroll.canvas"]').click();
    let view = window.locator(".canvas-view");
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__cardScrollWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Card scroll.canvas") (window as any).__cardScrollWrites += 1;
        return modify(file, data);
      };
    });
    await view.locator('[data-canvas-action="fit"]').click();
    const diskBefore = fs.readFileSync(canvasPath, "utf8");
    const textBody = view.locator('.canvas-node[data-node-id="long-text"] .canvas-node-text');
    const noteBody = view.locator('.canvas-node[data-node-id="note"] .canvas-node-note');
    await expect.poll(async () => (await scrollMetrics(textBody)).scroll).toBeGreaterThan((await scrollMetrics(textBody)).client);
    await expect.poll(async () => (await scrollMetrics(noteBody)).scroll).toBeGreaterThan((await scrollMetrics(noteBody)).client);

    // Selected overflowing text consumes plain wheel natively without moving
    // the Canvas camera or touching persisted data.
    await selectInMemory(window, view, "long-text");
    const beforeTextScroll = await camera(view);
    await wheel(window, textBody, 320);
    await expect.poll(async () => (await scrollMetrics(textBody)).top).toBeGreaterThan(0);
    expect(await camera(view)).toEqual(beforeTextScroll);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(await window.evaluate(() => (window as any).__cardScrollWrites)).toBe(0);

    // The resolved selected note follows the same native content path.
    await selectInMemory(window, view, "note");
    const beforeNoteScroll = await camera(view);
    await wheel(window, noteBody, 320);
    await expect.poll(async () => (await scrollMetrics(noteBody)).top).toBeGreaterThan(0);
    expect(await camera(view)).toEqual(beforeNoteScroll);

    // An unselected overflowing card retains Canvas pan behavior and does not
    // consume the wheel into its own scroll state.
    await textBody.evaluate((element) => { element.scrollTop = 0; });
    const beforeUnselected = await camera(view);
    await wheel(window, textBody, 80);
    expect((await scrollMetrics(textBody)).top).toBe(0);
    expect((await camera(view)).panY).toBeCloseTo(beforeUnselected.panY - 80, 4);

    // Ctrl/Cmd and Space zoom take precedence even over selected scrollable
    // content; Shift continues horizontal Canvas panning.
    await selectInMemory(window, view, "long-text");
    const textTopBeforeZoom = (await scrollMetrics(textBody)).top;
    const beforeModifierZoom = await camera(view);
    await textBody.hover();
    await window.keyboard.down("ControlOrMeta");
    await window.mouse.wheel(0, -180);
    await window.keyboard.up("ControlOrMeta");
    expect((await camera(view)).scale).toBeGreaterThan(beforeModifierZoom.scale);
    expect((await scrollMetrics(textBody)).top).toBe(textTopBeforeZoom);

    await view.locator('[data-canvas-action="fit"]').click();
    await selectInMemory(window, view, "note");
    const noteTopBeforeSpace = (await scrollMetrics(noteBody)).top;
    const beforeSpaceZoom = await camera(view);
    await view.locator(".canvas-surface").focus();
    await window.keyboard.down("Space");
    await noteBody.hover();
    await window.mouse.wheel(0, -160);
    await window.keyboard.up("Space");
    expect((await camera(view)).scale).toBeGreaterThan(beforeSpaceZoom.scale);
    expect((await scrollMetrics(noteBody)).top).toBe(noteTopBeforeSpace);

    await view.locator('[data-canvas-action="fit"]').click();
    await selectInMemory(window, view, "note");
    const noteTopBeforeShift = (await scrollMetrics(noteBody)).top;
    const beforeShiftPan = await camera(view);
    await noteBody.hover();
    await window.keyboard.down("Shift");
    await window.mouse.wheel(0, 90);
    await window.keyboard.up("Shift");
    const afterShiftPan = await camera(view);
    expect(afterShiftPan.panX).toBeCloseTo(beforeShiftPan.panX - 90, 4);
    expect(afterShiftPan.panY).toBe(beforeShiftPan.panY);
    expect((await scrollMetrics(noteBody)).top).toBe(noteTopBeforeShift);

    // Media, web, fallback, group, and selected non-scrollable text preserve
    // the established plain-wheel Canvas pan route.
    for (const [id, selector] of [
      ["media", ".canvas-node-media"],
      ["web", ".canvas-node-web-link"],
      ["fallback", ".canvas-node-file-fallback"],
      ["group", ".canvas-group-label"],
    ] as Array<[string, string]>) {
      await view.locator('[data-canvas-action="fit"]').click();
      const target = view.locator(`.canvas-node[data-node-id="${id}"] ${selector}`);
      const before = await camera(view);
      await wheel(window, target, 40);
      expect((await camera(view)).panY).toBeCloseTo(before.panY - 40, 4);
    }

    await view.locator('[data-canvas-action="fit"]').click();
    await selectInMemory(window, view, "short-text");
    const shortBody = view.locator('.canvas-node[data-node-id="short-text"] .canvas-node-text');
    const shortMetrics = await scrollMetrics(shortBody);
    expect(shortMetrics.scroll).toBeLessThanOrEqual(shortMetrics.client);
    const beforeShort = await camera(view);
    await wheel(window, shortBody, 40);
    expect((await camera(view)).panY).toBeCloseTo(beforeShort.panY - 40, 4);

    // An active overflowing textarea keeps its established native editor
    // scrolling rather than entering the selected rendered-card route.
    await view.locator('[data-canvas-action="fit"]').click();
    const longNode = view.locator('.canvas-node[data-node-id="long-text"]');
    await longNode.click({ button: "right", position: { x: 30, y: 30 } });
    await window.locator(".context-menu-item", { hasText: /^Edit$/ }).click();
    const editor = longNode.locator(".canvas-node-text-editor");
    await expect(editor).toBeFocused();
    const editorMetrics = await scrollMetrics(editor);
    expect(editorMetrics.scroll).toBeGreaterThan(editorMetrics.client);
    const beforeEditor = await camera(view);
    await wheel(window, editor, 80);
    await expect.poll(async () => (await scrollMetrics(editor)).top).toBeGreaterThan(0);
    expect(await camera(view)).toEqual(beforeEditor);
    await editor.press("Escape");

    // Scroll state is ephemeral and never changes selection/order/schema or
    // bytes; reload resets content scroll and the Canvas camera.
    await view.locator('[data-canvas-action="fit"]').click();
    await selectInMemory(window, view, "long-text");
    await wheel(window, textBody, 200);
    await expect.poll(async () => (await scrollMetrics(textBody)).top).toBeGreaterThan(0);
    expect(await window.evaluate(() => (window as any).__cardScrollWrites)).toBe(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Card scroll.canvas"]').click();
    view = window.locator(".canvas-view");
    expect((await scrollMetrics(view.locator('.canvas-node[data-node-id="long-text"] .canvas-node-text'))).top).toBe(0);
    expect((await scrollMetrics(view.locator('.canvas-node[data-node-id="note"] .canvas-node-note'))).top).toBe(0);
    expect(await camera(view)).toEqual({ scale: 1, panX: 80, panY: 80 });
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
