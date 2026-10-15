import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

import { CanvasBackgroundLifetimes, expectSavedCanvasClosure } from "./helpers/canvas-background-lifetimes";

const repoRoot = path.resolve(__dirname, "..", "..");

test("retains Canvas media loaded before its restored view is attached", async ({}, testInfo) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-detached-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-detached-user-"));
  fs.writeFileSync(path.join(vaultDir, "Photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  fs.writeFileSync(path.join(vaultDir, "Files.canvas"), JSON.stringify({
    nodes: [{ id: "photo", type: "file", x: 0, y: 0, width: 200, height: 200, file: "Photo.png" }], edges: [],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const loaded = await window.evaluate(async () => {
      const a = (window as any).app;
      const view = a.createCanvasView();
      // Restore loads the file before setView attaches the container. Hold
      // that interval open until the actual media request has settled.
      const originalLoad = view.loadFileMedia.bind(view);
      let settle!: () => void;
      const mediaLoaded = new Promise<void>((resolve) => { settle = resolve; });
      view.loadFileMedia = async (...args: unknown[]) => {
        try { await originalLoad(...args); } finally { settle(); }
      };
      await view.setFile(a.vault.getFileByPath("Files.canvas"));
      await mediaLoaded;
      const beforeAttach = view.containerEl.isConnected;
      await a.workspace.getLeaf(true).setView(view);
      return beforeAttach;
    });
    expect(loaded).toBe(false);
    const image = window.locator('.canvas-node[data-node-id="photo"] img');
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await window.screenshot({ path: testInfo.outputPath("restored-canvas-media.png") });
    const source = await image.getAttribute("src");
    const revoked = await window.evaluate(async () => {
      const urls: string[] = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url: string) => { urls.push(url); revoke(url); };
      try { await (window as any).app.workspace.getLeavesOfType("canvas")[0].detach(); }
      finally { URL.revokeObjectURL = revoke; }
      return urls;
    });
    expect(revoked).toContain(source);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

async function chooseFile(window: Page, actionName: string, fileName: string): Promise<void> {
  await window.getByRole("button", { name: actionName }).click();
  const input = window.locator(".prompt-input");
  await input.fill(fileName);
  await window.locator(".prompt-result", { hasText: fileName }).click();
}

test("adds filtered note and media cards with safe rendering and blob cleanup", async ({}, info) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-file-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-file-user-"));
  const canvasPath = path.join(vaultDir, "Files.canvas");
  fs.writeFileSync(path.join(vaultDir, "Sectioned.md"), "# Intro\n\nIntro text\n\n## Details\n\n**Section detail**\n");
  fs.writeFileSync(path.join(vaultDir, "Whole.md"), "# Whole note\n\nSafe **Markdown** body.\n");
  fs.writeFileSync(path.join(vaultDir, "Photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  fs.copyFileSync(path.join(__dirname, "fixtures/media/canvas-silence.mp3"), path.join(vaultDir, "Sound.mp3"));
  fs.writeFileSync(path.join(vaultDir, "Clip.mp4"), Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]));
  fs.writeFileSync(path.join(vaultDir, "Archive.bin"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [{
      id: "file-1",
      type: "file",
      x: 0,
      y: 0,
      width: 360,
      height: 280,
      file: "Sectioned.md",
      subpath: "#Details",
      vendorNode: "keep",
    }],
    edges: [],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const resources = new CanvasBackgroundLifetimes(window, "__canvasBlobTracker", info);
    const errors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const location = msg.location();
      if (resources.isExpectedProbeError(msg.text(), location.url)) return;
      errors.push(`${msg.text()} [${location.url || "unknown"}:${location.lineNumber}:${location.columnNumber}]`);
    });
    window.on("requestfailed", (request) => {
      if (resources.isExpectedProbeRequestFailure(request.url())) return;
      errors.push(`Request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
    });
    window.on("pageerror", (error) => errors.push(String(error)));
    await resources.install();

    await window.locator('.nav-file-title[data-path="Files.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const addNote = view.getByRole("button", { name: "Add note from vault" });
    const addMedia = view.getByRole("button", { name: "Add media from vault" });
    await expect(addNote).toHaveCount(1);
    await expect(addMedia).toHaveCount(1);

    // Existing generic file nodes now use the same safe note embed path and
    // honor their JSON Canvas subpath.
    const sectioned = view.locator('.canvas-node[data-node-id="file-1"]');
    await expect(sectioned.locator(".canvas-node-note h2")).toHaveText("Details");
    await expect(sectioned.locator(".canvas-node-note strong")).toHaveText("Section detail");
    await expect(sectioned.locator(".canvas-node-note")).not.toContainText("Intro text");

    // Note picker contains only Markdown files.
    await addNote.click();
    const noteResults = await window.locator(".prompt-result").allInnerTexts();
    expect(noteResults).toEqual(expect.arrayContaining(["Sectioned.md", "Whole.md"]));
    expect(noteResults.some((item) => /\.(png|mp3|mp4|bin|canvas)$/i.test(item))).toBe(false);
    await window.keyboard.press("Escape");

    // Pan/zoom before selection so the chosen note proves viewport-center
    // screen→world conversion.
    const surfaceBox = (await surface.boundingBox())!;
    await surface.hover();
    await window.keyboard.down("ControlOrMeta");
    await window.mouse.wheel(0, -250);
    await window.keyboard.up("ControlOrMeta");
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 50, surfaceBox.y + surfaceBox.height - 80);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 90, surfaceBox.y + surfaceBox.height - 110);
    await window.mouse.up({ button: "middle" });
    const transform = {
      scale: Number(await view.getAttribute("data-scale")),
      panX: Number(await view.getAttribute("data-pan-x")),
      panY: Number(await view.getAttribute("data-pan-y")),
    };
    const expectedCenter = {
      x: (surfaceBox.width / 2 - transform.panX) / transform.scale,
      y: (surfaceBox.height / 2 - transform.panY) / transform.scale,
    };
    await chooseFile(window, "Add note from vault", "Whole.md");
    const noteNode = view.locator('.canvas-node[data-node-id="file-2"]');
    await expect(noteNode.locator(".canvas-node-note h1")).toHaveText("Whole note");
    await expect(noteNode.locator(".canvas-node-note strong")).toHaveText("Markdown");
    const notePosition = await noteNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(notePosition.width).toBe(360);
    expect(notePosition.height).toBe(280);
    expect(notePosition.x + notePosition.width / 2).toBeCloseTo(expectedCenter.x, 3);
    expect(notePosition.y + notePosition.height / 2).toBeCloseTo(expectedCenter.y, 3);

    // Note-card double-click opens its note in a new tab.
    const tabsBefore = await window.locator(".workspace-split.mod-root .workspace-tab-header").count();
    await noteNode.dblclick();
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header")).toHaveCount(tabsBefore + 1);
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Whole.md");
    await window.locator('.nav-file-title[data-path="Files.canvas"]').click();

    // Media picker contains every non-Markdown representative and excludes notes.
    await addMedia.click();
    const mediaResults = await window.locator(".prompt-result").allInnerTexts();
    expect(mediaResults).toEqual(expect.arrayContaining(["Photo.png", "Sound.mp3", "Clip.mp4", "Archive.bin"]));
    expect(mediaResults.some((item) => item.endsWith(".md"))).toBe(false);
    await window.locator(".prompt-input").fill("Photo.png");
    await window.locator(".prompt-result", { hasText: "Photo.png" }).click();

    const imageNode = view.locator('.canvas-node[data-node-id="file-3"]');
    await expect(imageNode.locator("img.canvas-node-media")).toHaveAttribute("src", /^blob:/);
    const imagePosition = await imageNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(imagePosition.x + imagePosition.width / 2).toBeCloseTo(expectedCenter.x, 3);
    expect(imagePosition.y + imagePosition.height / 2).toBeCloseTo(expectedCenter.y, 3);

    const imageResource = await resources.captureMedia(view, "file-3", "image");
    await chooseFile(window, "Add media from vault", "Sound.mp3");
    await expect(view.locator('.canvas-node[data-node-id="file-4"] audio.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await chooseFile(window, "Add media from vault", "Archive.bin");
    await expect(view.locator('.canvas-node[data-node-id="file-5"] .canvas-node-file-fallback')).toHaveText("Archive.bin");

    // Unchanged media retain their actual DOM/source across unrelated edits.
    // The MP3 fixture is valid; its native loadeddata proof is separate from PNG.
    await expect.poll(() => window.evaluate(() => (window as any).__canvasBlobTracker.created.length)).toBeGreaterThanOrEqual(2);
    await resources.expectRetained(view, "file-3", imageResource);
    const audioResource = await resources.captureMedia(view, "file-4", "audio");
    await resources.expectLiveExactly([imageResource, audioResource]);
    await view.getByRole("button", { name: "Add text card" }).click();
    await view.locator(".canvas-node-text-editor").press("Escape");
    await resources.expectRetained(view, "file-3", imageResource);
    await resources.expectRetained(view, "file-4", audioResource);
    await resources.expectLiveExactly([imageResource, audioResource]);
    expect(errors, `Console errors after Canvas rerender: ${errors.join("\n")}`).toEqual([]);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["file-1", "file-2", "file-3", "file-4", "file-5"]);
    expect(saved.nodes.find((node: { id: string }) => node.id === "file-1").vendorNode).toBe("keep");

    const savedText = fs.readFileSync(canvasPath, "utf8");
    await window.locator('.workspace-tab-header[data-type="canvas"] .workspace-tab-header-inner-close-button').click();
    await resources.expectRetired([imageResource, audioResource]);
    await resources.expectAllRetired();
    await expectSavedCanvasClosure(vaultDir);
    await window.reload();
    await expect.poll(() => window.evaluate(() => (window as any).app?.workspace?.layoutReady ?? false)).toBe(true);
    await resources.install();
    await window.locator('.nav-file-title[data-path="Files.canvas"]').click();
    await expect(window.locator('.canvas-node[data-node-id="file-2"] .canvas-node-note h1')).toHaveText("Whole note");
    await expect(window.locator('.canvas-node[data-node-id="file-3"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(window.locator('.canvas-node[data-node-id="file-4"] audio.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(window.locator('.canvas-node[data-node-id="file-5"] .canvas-node-file-fallback')).toHaveText("Archive.bin");
    await expect(window.locator(".canvas-view").getByRole("button", { name: "Add note from vault" })).toHaveCount(1);
    await expect(window.locator(".canvas-view").getByRole("button", { name: "Add media from vault" })).toHaveCount(1);

    const restored = window.locator(".canvas-view");
    const restoredImage = await resources.captureMedia(restored, "file-3", "image");
    const restoredAudio = await resources.captureMedia(restored, "file-4", "audio");
    await resources.expectLiveExactly([restoredImage, restoredAudio]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(savedText);
    await window.locator('.workspace-tab-header[data-type="canvas"] .workspace-tab-header-inner-close-button').click();
    await resources.expectRetired([restoredImage, restoredAudio]);
    await resources.expectAllRetired();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(savedText);

    expect(errors, `Console errors after renderer reload: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
