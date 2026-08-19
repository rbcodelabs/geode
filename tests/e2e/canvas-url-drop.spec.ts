import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const vaultPathMime = "application/x-geode-vault-path";

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<{ scale: number; panX: number; panY: number }> {
  return {
    scale: Number(await view.getAttribute("data-scale")),
    panX: Number(await view.getAttribute("data-pan-x")),
    panY: Number(await view.getAttribute("data-pan-y")),
  };
}

async function emptySurfacePoint(surface: Locator): Promise<{ x: number; y: number }> {
  return surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = element.querySelector(".canvas-viewport");
    for (const yRatio of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const xRatio of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const x = Math.round(rect.width * xRatio);
        const y = Math.round(rect.height * yRatio);
        const target = document.elementFromPoint(rect.left + x, rect.top + y);
        if (target === element || target === viewport) return { x, y };
      }
    }
    throw new Error("No true empty Canvas surface point found");
  });
}

async function dispatchDrop(target: Locator, entries: Array<[string, string]>, point?: { x: number; y: number }): Promise<boolean> {
  return target.evaluate((element, payload) => {
    const transfer = new DataTransfer();
    for (const [type, value] of payload.entries) transfer.setData(type, value);
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: rect.left + (payload.point?.x ?? rect.width / 2),
      clientY: rect.top + (payload.point?.y ?? rect.height / 2),
    };
    element.dispatchEvent(new DragEvent("dragover", init));
    const drop = new DragEvent("drop", init);
    element.dispatchEvent(drop);
    return drop.defaultPrevented;
  }, { entries, point });
}

async function dragoverPrevented(target: Locator, type: string, value: string): Promise<boolean> {
  return target.evaluate((element, payload) => {
    const transfer = new DataTransfer();
    transfer.setData(payload.type, payload.value);
    const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, value });
}

async function expectLinkCard(view: Locator, id: string, canonical: string): Promise<Locator> {
  const node = view.locator(`.canvas-node[data-node-id="${id}"]`);
  await expect(node.locator(".canvas-node-web-url")).toHaveText(canonical);
  await expect(node.locator(".canvas-node-web-host")).toHaveText(new URL(canonical).hostname);
  const action = node.locator("button.canvas-node-web-link");
  await expect(action).toHaveAttribute("aria-label", canonical);
  await expect(action).not.toHaveAttribute("href");
  await expect(node).toHaveClass(/is-selected/);
  await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
  await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);
  return node;
}

test("drops standard browser URLs onto empty transformed Canvas space", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-url-drop-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-url-drop-user-"));
  const canvasPath = path.join(vaultDir, "URL drop.canvas");
  const initial = {
    vendorCanvas: { keep: { deep: true } },
    nodes: [
      { id: "keeper", type: "text", x: -320, y: -160, width: 200, height: 120, text: "Keeper", color: "1", vendorKeeper: [1, 2] },
      { id: "link-1", type: "link", x: 80, y: 30, width: 360, height: 180, url: "https://existing.example/", color: "4", vendorExisting: { keep: true } },
    ],
    edges: [{
      id: "edge-1", fromNode: "keeper", fromSide: "right", fromEnd: "none",
      toNode: "link-1", toSide: "left", toEnd: "arrow", color: "6", vendorEdge: "keep",
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

    await window.locator('.nav-file-title[data-path="URL drop.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await window.evaluate(() => {
      const source = document.createElement("a");
      source.id = "browser-url-drag-source";
      source.href = "HTTPS://Example.COM:443/from-anchor?query=1#part";
      source.textContent = "Drag browser URL";
      source.draggable = true;
      Object.assign(source.style, {
        position: "fixed", zIndex: "10000", top: "8px", left: "460px",
        padding: "6px", background: "white", color: "black",
      });
      source.addEventListener("dragstart", (event) => {
        const transfer = event.dataTransfer!;
        (window as any).__canvasUrlSource = {
          types: [...transfer.types],
          uri: transfer.getData("text/uri-list"),
          plain: transfer.getData("text/plain"),
        };
      });
      document.body.appendChild(source);
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasUrlWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "URL drop.canvas") (window as any).__canvasUrlWrites += 1;
        return modify(file, data);
      };
    });
    const source = window.locator("#browser-url-drag-source");
    await expect(source).toBeVisible();

    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + 40, surfaceBox.y + 70);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + 90, surfaceBox.y + 105);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);
    const rendererUrl = window.url();
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);

    // Invalid and unrelated payloads, private-file priority, and nonempty
    // targets are byte/write/selection/camera inert.
    const guardedTargets = [
      view.locator('.canvas-node[data-node-id="link-1"]'),
      view.locator('.canvas-edge-hit[data-edge-id="edge-1"]'),
      view.getByRole("button", { name: "Set color", exact: true }),
    ];
    for (const target of guardedTargets) {
      expect(await dispatchDrop(target, [["text/uri-list", "https://guarded.example/"]])).toBe(false);
    }
    for (const entries of [
      [] as Array<[string, string]>,
      [["text/html", "<a href='https://ignored.example'>ignored</a>"]] as Array<[string, string]>,
      [["text/uri-list", "# only a comment\n"]] as Array<[string, string]>,
      [["text/uri-list", "javascript:alert(1)\nfile:///tmp/nope\ndata:text/plain,nope"]] as Array<[string, string]>,
      [["text/plain", "https://one.example/\nhttps://two.example/"]] as Array<[string, string]>,
      [["text/plain", "javascript:alert(1)"]] as Array<[string, string]>,
      [[vaultPathMime, "URL drop.canvas"], ["text/uri-list", "https://must-not-fallback.example/"]] as Array<[string, string]>,
    ]) {
      expect(await dispatchDrop(surface, entries)).toBe(entries.some(([type]) => type === vaultPathMime));
    }
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__canvasUrlWrites)).toBe(0);
    await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(window.url()).toBe(rendererUrl);

    // A real Chromium link drag exposes standard URL data and creates one
    // canonical web card centered on the transformed drop cursor.
    const anchorPoint = await emptySurfacePoint(surface);
    const anchorWorld = {
      x: (anchorPoint.x - transformedCamera.panX) / transformedCamera.scale,
      y: (anchorPoint.y - transformedCamera.panY) / transformedCamera.scale,
    };
    await surface.evaluate((element) => {
      element.addEventListener("dragover", (event) => {
        const drag = event as DragEvent;
        if (drag.dataTransfer?.types.includes("text/uri-list")) {
          (window as any).__canvasUrlDragover = {
            prevented: drag.defaultPrevented,
            dropEffect: drag.dataTransfer.dropEffect,
          };
        }
      });
    });
    await source.dragTo(surface, { targetPosition: anchorPoint });
    const anchorCanonical = "https://example.com/from-anchor?query=1#part";
    const anchorNode = await expectLinkCard(view, "link-2", anchorCanonical);
    const sourceData = await window.evaluate(() => (window as any).__canvasUrlSource);
    expect(sourceData.types).toContain("text/uri-list");
    expect(sourceData.uri).toContain(anchorCanonical);
    expect(await window.evaluate(() => (window as any).__canvasUrlDragover)).toEqual({ prevented: true, dropEffect: "copy" });
    const anchorGeometry = await anchorNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(anchorGeometry).toMatchObject({ width: 360, height: 180 });
    expect(anchorGeometry.x + 180).toBeCloseTo(anchorWorld.x, 0);
    expect(anchorGeometry.y + 90).toBeCloseTo(anchorWorld.y, 0);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(3);
    expect(await window.evaluate(() => (window as any).__canvasUrlWrites)).toBe(1);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(window.url()).toBe(rendererUrl);

    // URI lists skip comments and unsafe entries, choosing the first valid
    // http(s) line; plain text is accepted only as one valid trimmed line.
    const uriPoint = await emptySurfacePoint(surface);
    const uriWorld = {
      x: (uriPoint.x - transformedCamera.panX) / transformedCamera.scale,
      y: (uriPoint.y - transformedCamera.panY) / transformedCamera.scale,
    };
    expect(await dispatchDrop(surface, [[
      "text/uri-list",
      "# exported browser selection\njavascript:alert(1)\n HTTPS://Example.ORG:443/commented?q=2 \nhttps://later.example/",
    ]], uriPoint)).toBe(true);
    const uriCanonical = "https://example.org/commented?q=2";
    await expectLinkCard(view, "link-3", uriCanonical);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(4);
    expect(await window.evaluate(() => (window as any).__canvasUrlWrites)).toBe(2);

    const plainPoint = await emptySurfacePoint(surface);
    const plainWorld = {
      x: (plainPoint.x - transformedCamera.panX) / transformedCamera.scale,
      y: (plainPoint.y - transformedCamera.panY) / transformedCamera.scale,
    };
    expect(await dispatchDrop(surface, [["text/plain", "  http://Plain.Example:80/path#ok  "]], plainPoint)).toBe(true);
    const plainCanonical = "http://plain.example/path#ok";
    await expectLinkCard(view, "link-4", plainCanonical);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(5);
    expect(await window.evaluate(() => (window as any).__canvasUrlWrites)).toBe(3);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(window.url()).toBe(rendererUrl);

    // Dragover advertises copy eligibility only for the private or standard
    // URL candidate types; strict payload parsing remains a drop concern.
    expect(await dragoverPrevented(surface, vaultPathMime, "Missing.md")).toBe(true);
    expect(await dragoverPrevented(surface, "text/uri-list", "javascript:alert(1)")).toBe(true);
    expect(await dragoverPrevented(surface, "text/plain", "not yet readable")).toBe(true);
    expect(await dragoverPrevented(surface, "text/html", "https://ignored.example/")).toBe(false);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.slice(0, 2)).toEqual(initial.nodes);
    expect(saved.nodes.slice(2)).toEqual([
      { id: "link-2", type: "link", x: anchorWorld.x - 180, y: anchorWorld.y - 90, width: 360, height: 180, url: anchorCanonical },
      { id: "link-3", type: "link", x: uriWorld.x - 180, y: uriWorld.y - 90, width: 360, height: 180, url: uriCanonical },
      { id: "link-4", type: "link", x: plainWorld.x - 180, y: plainWorld.y - 90, width: 360, height: 180, url: plainCanonical },
    ]);
    expect(saved.edges).toEqual(initial.edges);

    await window.reload();
    await window.locator('.nav-file-title[data-path="URL drop.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="link-2"] .canvas-node-web-url')).toHaveText(anchorCanonical);
    await expect(view.locator('.canvas-node[data-node-id="link-3"] .canvas-node-web-url')).toHaveText(uriCanonical);
    await expect(view.locator('.canvas-node[data-node-id="link-4"] .canvas-node-web-url')).toHaveText(plainCanonical);
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
