import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const chooserActions = ["Add text card", "Add note from vault", "Add media from vault", "Add web page"];

type Point = { x: number; y: number };
type Camera = { scale: number; panX: number; panY: number };

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<Camera> {
  return {
    scale: Number(await view.getAttribute("data-scale")),
    panX: Number(await view.getAttribute("data-pan-x")),
    panY: Number(await view.getAttribute("data-pan-y")),
  };
}

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

async function emptyClientPoint(surface: Locator): Promise<Point> {
  return surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = element.querySelector(".canvas-viewport");
    for (const yRatio of [0.18, 0.34, 0.5, 0.66, 0.82]) {
      for (const xRatio of [0.16, 0.32, 0.5, 0.68, 0.84]) {
        const x = rect.left + rect.width * xRatio;
        const y = rect.top + rect.height * yRatio;
        const target = document.elementFromPoint(x, y);
        const overlapsNode = [...element.querySelectorAll<HTMLElement>(".canvas-node")].some((node) => {
          const bounds = node.getBoundingClientRect();
          return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
        });
        const overlapsHandle = [...element.querySelectorAll<HTMLElement>(".canvas-node-connection-handle")].some((handle) => {
          const bounds = handle.getBoundingClientRect();
          return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
        });
        if (!overlapsNode && !overlapsHandle && (target === element || target === viewport)) return { x, y };
      }
    }
    throw new Error("No true empty Canvas point found");
  });
}

async function worldPoint(surface: Locator, view: Locator, point: Point): Promise<Point> {
  const rect = await surface.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top };
  });
  const transform = await camera(view);
  return {
    x: (point.x - rect.left - transform.panX) / transform.scale,
    y: (point.y - rect.top - transform.panY) / transform.scale,
  };
}

async function openChooser(
  page: Page,
  view: Locator,
  surface: Locator,
  sourceSide: "right" | "bottom" | "top" = "right",
): Promise<Point> {
  await surface.focus();
  await page.keyboard.press("ControlOrMeta+a");
  const point = await emptyClientPoint(surface);
  const handle = view.locator('.canvas-node[data-node-id="source"]').getByRole("button", { name: `Connect from ${sourceSide}` });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await expect(page.locator(".context-menu-item")).toHaveText(chooserActions);
  return point;
}

async function expectCentered(node: Locator, point: Point, width: number, height: number): Promise<void> {
  const geometry = await node.evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
  expect(geometry).toMatchObject({ width, height });
  expect(geometry.x + width / 2).toBeCloseTo(point.x, 3);
  expect(geometry.y + height / 2).toBeCloseTo(point.y, 3);
}

test("chooses note, media, or web cards for an empty Canvas connection drop", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-connection-chooser-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-connection-chooser-user-"));
  const canvasPath = path.join(vaultDir, "Chooser.canvas");
  fs.writeFileSync(path.join(vaultDir, "Connected note.md"), "# Connected note\n\nSafe **Markdown**.\n");
  fs.writeFileSync(path.join(vaultDir, "Connected image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const initial = {
    vendorCanvas: { preserve: { deep: true } },
    nodes: [
      { id: "source", type: "text", x: -120, y: -40, width: 220, height: 120, text: "Source", color: "3", vendorSource: [1, 2] },
      { id: "file-1", type: "file", x: 980, y: 720, width: 300, height: 120, file: "Missing.dat", vendorFile: { keep: true } },
      { id: "link-1", type: "link", x: -760, y: 680, width: 360, height: 180, url: "https://existing.example/", vendorLink: "keep" },
    ],
    edges: [{
      id: "edge-1", fromNode: "file-1", fromSide: "left", fromEnd: "none",
      toNode: "source", toSide: "right", toEnd: "arrow", color: "5", vendorEdge: { keep: true },
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

    await window.locator('.nav-file-title[data-path="Chooser.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasChooserWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Chooser.canvas") (window as any).__canvasChooserWrites += 1;
        return modify(file, data);
      };
    });

    await view.locator('[data-canvas-action="zoom-out"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + 80, surfaceBox.y + 80);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + 125, surfaceBox.y + 110);
    await window.mouse.up({ button: "middle" });
    const transformedCamera = await camera(view);
    expect(transformedCamera.scale).not.toBe(1);

    // Menu dismissal and every downstream modal cancellation are inert. The
    // note/media pickers also prove their exact file-kind filtering.
    await openChooser(window, view, surface);
    expect(await selectedIds(view)).toEqual(["source"]);
    await window.locator("body").dispatchEvent("mousedown");
    await expect(window.locator(".context-menu-item")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await camera(view)).toEqual(transformedCamera);

    await openChooser(window, view, surface);
    await window.locator(".context-menu-item", { hasText: /^Add note from vault$/ }).click();
    await window.locator('.prompt-input[placeholder="Search notes…"]').fill("Connected image.png");
    await expect(window.locator(".prompt-empty")).toHaveText("No results found.");
    await window.keyboard.press("Escape");

    await openChooser(window, view, surface);
    await window.locator(".context-menu-item", { hasText: /^Add media from vault$/ }).click();
    await window.locator('.prompt-input[placeholder="Search media…"]').fill("Connected note.md");
    await expect(window.locator(".prompt-empty")).toHaveText("No results found.");
    await window.keyboard.press("Escape");

    await openChooser(window, view, surface);
    await window.locator(".context-menu-item", { hasText: /^Add web page$/ }).click();
    await expect(window.locator('.prompt-input[placeholder="Enter web page URL…"]')).toBeFocused();
    await window.keyboard.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__canvasChooserWrites)).toBe(0);
    expect(await selectedIds(view)).toEqual(["source"]);
    expect(await camera(view)).toEqual(transformedCamera);
    await expect(view.locator(".canvas-node")).toHaveCount(initial.nodes.length);
    await expect(view.locator(".canvas-edge")).toHaveCount(initial.edges.length);

    // A note route uses the captured transformed drop point and persists the
    // canonical card plus opposite-side edge as one document write.
    let point = await openChooser(window, view, surface);
    let world = await worldPoint(surface, view, point);
    await window.locator(".context-menu-item", { hasText: /^Add note from vault$/ }).click();
    await window.locator('.prompt-input[placeholder="Search notes…"]').fill("Connected note.md");
    await window.locator(".prompt-result", { hasText: "Connected note.md" }).click();
    const note = view.locator('.canvas-node[data-node-id="file-2"]');
    await expect(note.locator(".canvas-node-note h1")).toHaveText("Connected note");
    await expectCentered(note, world, 360, 280);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(initial.nodes.length + 1);
    expect(await window.evaluate(() => (window as any).__canvasChooserWrites)).toBe(1);
    expect(await selectedIds(view)).toEqual(["file-2"]);

    // Media follows the same transaction and uses the existing media sizing.
    point = await openChooser(window, view, surface, "bottom");
    world = await worldPoint(surface, view, point);
    await window.locator(".context-menu-item", { hasText: /^Add media from vault$/ }).click();
    await window.locator('.prompt-input[placeholder="Search media…"]').fill("Connected image.png");
    await window.locator(".prompt-result", { hasText: "Connected image.png" }).click();
    const media = view.locator('.canvas-node[data-node-id="file-3"]');
    await expect(media.locator("img.canvas-node-media")).toHaveAttribute("src", /^blob:/);
    await expectCentered(media, world, 360, 240);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-3"]')).toHaveCount(1);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(initial.nodes.length + 2);
    expect(await window.evaluate(() => (window as any).__canvasChooserWrites)).toBe(2);
    expect(await selectedIds(view)).toEqual(["file-3"]);

    // Invalid web submission preserves the transaction, then a valid retry
    // canonicalizes and commits exactly one link+edge write.
    point = await openChooser(window, view, surface, "top");
    world = await worldPoint(surface, view, point);
    const beforeInvalid = fs.readFileSync(canvasPath, "utf8");
    await window.locator(".context-menu-item", { hasText: /^Add web page$/ }).click();
    await window.locator('.prompt-input[placeholder="Enter web page URL…"]').fill("javascript:alert(1)");
    await window.locator('.prompt-input[placeholder="Enter web page URL…"]').press("Enter");
    await expect(window.locator(".notice", { hasText: "valid http:// or https:// URL" }).last()).toBeVisible();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeInvalid);
    expect(await window.evaluate(() => (window as any).__canvasChooserWrites)).toBe(2);
    expect(await selectedIds(view)).toEqual(["source"]);

    point = await openChooser(window, view, surface, "top");
    world = await worldPoint(surface, view, point);
    await window.locator(".context-menu-item", { hasText: /^Add web page$/ }).click();
    await window.locator('.prompt-input[placeholder="Enter web page URL…"]').fill(" HTTPS://Example.COM:443/a/../connected?q=one ");
    await window.locator('.prompt-input[placeholder="Enter web page URL…"]').press("Enter");
    const link = view.locator('.canvas-node[data-node-id="link-2"]');
    await expect(link.locator(".canvas-node-web-url")).toHaveText("https://example.com/connected?q=one");
    await expectCentered(link, world, 360, 180);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-4"]')).toHaveCount(1);
    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(initial.nodes.length + 3);
    expect(await window.evaluate(() => (window as any).__canvasChooserWrites)).toBe(3);
    expect(await selectedIds(view)).toEqual(["link-2"]);
    expect(await camera(view)).toEqual(transformedCamera);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.slice(0, initial.nodes.length)).toEqual(initial.nodes);
    expect(saved.edges.slice(0, initial.edges.length)).toEqual(initial.edges);
    expect(saved.nodes.slice(initial.nodes.length).map((node: { id: string }) => node.id)).toEqual(["file-2", "file-3", "link-2"]);
    expect(saved.edges.slice(initial.edges.length)).toEqual([
      { id: "edge-2", fromNode: "source", fromSide: "right", fromEnd: "none", toNode: "file-2", toSide: "left", toEnd: "arrow" },
      { id: "edge-3", fromNode: "source", fromSide: "bottom", fromEnd: "none", toNode: "file-3", toSide: "top", toEnd: "arrow" },
      { id: "edge-4", fromNode: "source", fromSide: "top", fromEnd: "none", toNode: "link-2", toSide: "bottom", toEnd: "arrow" },
    ]);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Chooser.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator('.canvas-node[data-node-id="file-2"] .canvas-node-note h1')).toHaveText("Connected note");
    await expect(view.locator('.canvas-node[data-node-id="file-3"] img.canvas-node-media')).toHaveAttribute("src", /^blob:/);
    await expect(view.locator('.canvas-node[data-node-id="link-2"] .canvas-node-web-url')).toHaveText("https://example.com/connected?q=one");
    await expect(view.locator(".canvas-node.is-selected, .canvas-edge.is-selected")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
