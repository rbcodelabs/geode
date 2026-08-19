import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

type Point = { x: number; y: number };

async function worldToScreen(view: Locator, surface: Locator, point: Point): Promise<Point> {
  const box = (await surface.boundingBox())!;
  const scale = Number(await view.getAttribute("data-scale"));
  const panX = Number(await view.getAttribute("data-pan-x"));
  const panY = Number(await view.getAttribute("data-pan-y"));
  return { x: box.x + panX + point.x * scale, y: box.y + panY + point.y * scale };
}

async function marquee(
  page: Page,
  view: Locator,
  surface: Locator,
  from: Point,
  to: Point,
  shift = false,
): Promise<void> {
  const start = await worldToScreen(view, surface, from);
  const end = await worldToScreen(view, surface, to);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await expect(view.locator(".canvas-marquee")).toBeVisible();
  await page.mouse.up();
  await expect(view.locator(".canvas-marquee")).toHaveCount(0);
  if (shift) await page.keyboard.up("Shift");
}

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

test("marquee-selects intersecting Canvas nodes without persisting selection", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-marquee-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-marquee-user-"));
  const canvasPath = path.join(vaultDir, "Marquee.canvas");
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const initial = {
    vendorCanvas: { keep: true },
    nodes: [
      { id: "text", type: "text", x: 50, y: 50, width: 100, height: 80, text: "Text", vendorText: "keep" },
      { id: "file", type: "file", x: 200, y: 50, width: 100, height: 80, file: "Note.md", vendorFile: "keep" },
      { id: "link", type: "link", x: 350, y: 50, width: 100, height: 80, url: "https://example.com/", vendorLink: "keep" },
      { id: "group", type: "group", x: 200, y: 220, width: 130, height: 90, label: "Group", vendorGroup: "keep" },
      { id: "outside", type: "text", x: 550, y: 300, width: 100, height: 80, text: "Outside", vendorOutside: "keep" },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "text",
      fromSide: "right",
      toNode: "file",
      toSide: "left",
      vendorEdge: "keep",
    }],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Marquee.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 50, surfaceBox.y + surfaceBox.height - 60);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 80, surfaceBox.y + surfaceBox.height - 85);
    await window.mouse.up({ button: "middle" });
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    const diskBefore = fs.readFileSync(canvasPath, "utf8");

    // Existing edge selection is cleared by a plain forward marquee. The
    // transformed world rectangle intersects text and file only.
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    await expect(view.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveClass(/is-selected/);
    await marquee(window, view, surface, { x: 40, y: 40 }, { x: 320, y: 170 });
    expect(await selectedIds(view)).toEqual(["file", "text"]);
    await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(0);

    // Reverse Shift-marquee intersects file, link, and group, unioning them
    // with the prior text/file snapshot. All four node types are selected.
    await marquee(window, view, surface, { x: 500, y: 340 }, { x: 180, y: 30 }, true);
    expect(await selectedIds(view)).toEqual(["file", "group", "link", "text"]);

    // A plain reverse marquee replaces the selection with group only.
    await marquee(window, view, surface, { x: 340, y: 320 }, { x: 180, y: 200 });
    expect(await selectedIds(view)).toEqual(["group"]);

    // A primary click that never crosses the drag threshold retains the
    // existing empty-canvas clear behavior and creates no marquee.
    const empty = await worldToScreen(view, surface, { x: 480, y: 250 });
    await window.mouse.click(empty.x, empty.y);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    await expect(view.locator(".canvas-marquee")).toHaveCount(0);

    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "text").vendorText).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "file").vendorFile).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "link").vendorLink).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "group").vendorGroup).toBe("keep");
    expect(saved.edges[0].vendorEdge).toBe("keep");

    await window.reload();
    await window.locator('.nav-file-title[data-path="Marquee.canvas"]').click();
    await expect(window.locator(".canvas-view .canvas-node.is-selected")).toHaveCount(0);
    await expect(window.locator(".canvas-view .canvas-marquee")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
