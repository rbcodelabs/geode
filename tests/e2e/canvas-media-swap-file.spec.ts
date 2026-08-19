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

async function openMenu(page: Page, view: Locator, id: string, expected: string[]): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).toHaveText(expected);
}

async function openSwap(page: Page, view: Locator, id: string): Promise<string[]> {
  await openMenu(page, view, id, ["Zoom to selection", "Swap file", "Create group", "Delete"]);
  await page.locator(".context-menu-item", { hasText: /^Swap file$/ }).click();
  await expect(page.locator(".prompt-input")).toBeFocused();
  return page.locator(".prompt-result").allInnerTexts();
}

async function choose(page: Page, file: string): Promise<void> {
  await page.locator(".prompt-input").fill(file);
  await page.locator(".prompt-result", { hasText: new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).click();
}

test("swaps resolved Canvas media file cards only within their exact media kind", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-media-swap-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-media-swap-user-"));
  const canvasPath = path.join(vaultDir, "Media swap.canvas");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(vaultDir, "Old.png"), png);
  fs.writeFileSync(path.join(vaultDir, "New.png"), png);
  fs.writeFileSync(path.join(vaultDir, "Old.mp3"), Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(vaultDir, "New.mp3"), Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(vaultDir, "Old.mp4"), Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]));
  fs.writeFileSync(path.join(vaultDir, "New.mp4"), Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
  fs.writeFileSync(path.join(vaultDir, "Old.md"), "# Old note\n");
  fs.writeFileSync(path.join(vaultDir, "New.md"), "# New note\n");
  fs.writeFileSync(path.join(vaultDir, "Archive.bin"), Buffer.from([1, 2, 3]));
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "image", type: "file", x: 0, y: 0, width: 360, height: 240, file: "Old.png", subpath: "#stale", color: "1", vendorImage: { keep: [1] } },
      { id: "audio", type: "file", x: 420, y: 0, width: 360, height: 180, file: "Old.mp3", subpath: "#stale", color: "2", vendorAudio: { keep: [2] } },
      { id: "video", type: "file", x: 820, y: 0, width: 360, height: 240, file: "Old.mp4", subpath: "#stale", color: "3", vendorVideo: { keep: [3] } },
      { id: "note", type: "file", x: 0, y: 320, width: 360, height: 240, file: "Old.md", subpath: "#Old-note", color: "4", vendorNote: true },
      { id: "other", type: "file", x: 420, y: 320, width: 280, height: 160, file: "Archive.bin", vendorOther: true },
      { id: "missing", type: "file", x: 760, y: 320, width: 280, height: 160, file: "Missing.png", vendorMissing: true },
      { id: "text", type: "text", x: 0, y: 640, width: 220, height: 120, text: "Text", vendorText: true },
      { id: "link", type: "link", x: 300, y: 640, width: 300, height: 150, url: "https://example.com/", vendorLink: true },
      { id: "group", type: "group", x: 700, y: 610, width: 300, height: 180, label: "Group", vendorGroup: true },
    ],
    edges: [
      { id: "edge-1", fromNode: "image", fromSide: "right", fromEnd: "none", toNode: "audio", toSide: "left", toEnd: "arrow", color: "5", vendorEdge: { keep: true } },
      { id: "edge-2", fromNode: "audio", fromSide: "right", fromEnd: "none", toNode: "video", toSide: "left", toEnd: "arrow", label: "Media", vendorEdge2: ["keep"] },
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
    await window.evaluate(() => {
      const tracker = { created: [] as string[], revoked: [] as string[] };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob) => {
        const url = create(blob);
        tracker.created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        tracker.revoked.push(url);
        revoke(url);
      };
      (window as any).__mediaSwapBlobTracker = tracker;
    });

    await window.locator('.nav-file-title[data-path="Media swap.canvas"]').click();
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__mediaSwapWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Media swap.canvas") (window as any).__mediaSwapWrites += 1;
        return modify(file, data);
      };
    });
    let view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="image"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="audio"] audio.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="video"] video.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    expect(Number(transformedCamera.scale)).not.toBe(1);

    // Notes retain note-only swap. Missing, other, and non-file node types
    // remain excluded from the action entirely.
    let results = await openSwap(window, view, "note");
    expect(results).toEqual(expect.arrayContaining(["Old.md", "New.md"]));
    expect(results.every((item) => item.endsWith(".md"))).toBe(true);
    await window.keyboard.press("Escape");
    for (const [id, menu] of [
      ["other", ["Zoom to selection", "Create group", "Delete"]],
      ["missing", ["Zoom to selection", "Create group", "Delete"]],
      ["text", ["Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete"]],
      ["link", ["Zoom to selection", "Open in browser", "Create group", "Delete"]],
      ["group", ["Zoom to selection", "Set background", "Delete"]],
    ] as Array<[string, string[]]>) {
      await openMenu(window, view, id, menu);
      await window.keyboard.press("Escape");
    }

    const surface = view.locator(".canvas-surface");
    await surface.focus();
    await window.keyboard.press("ControlOrMeta+a");
    const allIds = initial.nodes.map((node) => node.id).sort();
    expect(await selectedIds(view)).toEqual(allIds);
    const cameraBeforeSwaps = await camera(view);

    // Opening and canceling the image-only picker is byte-, write-, selection-,
    // and camera-inert, and no cross-kind candidates are offered.
    results = await openSwap(window, view, "image");
    expect(results).toEqual(expect.arrayContaining(["Old.png", "New.png"]));
    expect(results.every((item) => item.endsWith(".png"))).toBe(true);
    await window.keyboard.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__mediaSwapWrites)).toBe(0);
    expect(await selectedIds(view)).toEqual(allIds);
    expect(await camera(view)).toEqual(cameraBeforeSwaps);

    const oldImageUrl = await view.locator('.canvas-node[data-node-id="image"] img').getAttribute("src");
    await openSwap(window, view, "image");
    await choose(window, "New.png");
    const image = view.locator('.canvas-node[data-node-id="image"] img.canvas-node-media');
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => window.evaluate((url) => (window as any).__mediaSwapBlobTracker.revoked.includes(url), oldImageUrl)).toBe(true);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "image")?.file ?? null).toBe("New.png");
    expect(await window.evaluate(() => (window as any).__mediaSwapWrites)).toBe(1);

    results = await openSwap(window, view, "audio");
    expect(results).toEqual(expect.arrayContaining(["Old.mp3", "New.mp3"]));
    expect(results.every((item) => item.endsWith(".mp3"))).toBe(true);
    const oldAudioUrl = await view.locator('.canvas-node[data-node-id="audio"] audio').getAttribute("src");
    await choose(window, "New.mp3");
    const audio = view.locator('.canvas-node[data-node-id="audio"] audio.canvas-node-media');
    await expect(audio).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => window.evaluate((url) => (window as any).__mediaSwapBlobTracker.revoked.includes(url), oldAudioUrl)).toBe(true);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "audio")?.file ?? null).toBe("New.mp3");
    expect(await window.evaluate(() => (window as any).__mediaSwapWrites)).toBe(2);

    results = await openSwap(window, view, "video");
    expect(results).toEqual(expect.arrayContaining(["Old.mp4", "New.mp4"]));
    expect(results.every((item) => item.endsWith(".mp4"))).toBe(true);
    const oldVideoUrl = await view.locator('.canvas-node[data-node-id="video"] video').getAttribute("src");
    await choose(window, "New.mp4");
    const video = view.locator('.canvas-node[data-node-id="video"] video.canvas-node-media');
    await expect(video).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => window.evaluate((url) => (window as any).__mediaSwapBlobTracker.revoked.includes(url), oldVideoUrl)).toBe(true);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "video")?.file ?? null).toBe("New.mp4");
    expect(await window.evaluate(() => (window as any).__mediaSwapWrites)).toBe(3);
    expect(await selectedIds(view)).toEqual(allIds);
    expect(await camera(view)).toEqual(cameraBeforeSwaps);

    const persistedText = fs.readFileSync(canvasPath, "utf8");
    const saved = JSON.parse(persistedText);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.edges).toEqual(initial.edges);
    for (const [index, file] of [[0, "New.png"], [1, "New.mp3"], [2, "New.mp4"]] as const) {
      const expected = { ...initial.nodes[index], file } as Record<string, unknown>;
      delete expected.subpath;
      expect(saved.nodes[index]).toEqual(expected);
    }
    expect(saved.nodes.slice(3)).toEqual(initial.nodes.slice(3));

    await window.reload();
    await window.locator('.nav-file-title[data-path="Media swap.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="image"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="audio"] audio.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="video"] video.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
