import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function selectNodeWithoutWrite(page: Page, node: Locator): Promise<void> {
  await node.dispatchEvent("contextmenu");
  await page.locator("body").dispatchEvent("mousedown");
  await expect(node).toHaveClass(/is-selected/);
}

async function connect(page: Page, source: Locator, target: Locator): Promise<void> {
  const start = await center(source);
  const end = await center(target);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await expect(page.locator(".canvas-edge-preview")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".canvas-edge-preview")).toHaveCount(0);
}

async function reconnect(page: Page, endpoint: Locator, target: Locator): Promise<void> {
  const start = await center(endpoint);
  const end = await center(target);
  await endpoint.dispatchEvent("pointerdown", { button: 0, clientX: start.x, clientY: start.y });
  await page.mouse.move(end.x, end.y);
  await expect(page.locator(".canvas-edge-preview")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".canvas-edge-preview")).toHaveCount(0);
}

async function camera(view: Locator): Promise<{ scale: string | null; panX: string | null; panY: string | null }> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

test("authors and reconnects Canvas edges with groups as first-class endpoints", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-connections-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-connections-user-"));
  const canvasPath = path.join(vaultDir, "Group connections.canvas");
  const initial = {
    vendorCanvas: { preserve: true },
    nodes: [
      { id: "group-a", type: "group", x: 330, y: 60, width: 230, height: 160, label: "Group A", vendorGroupA: { keep: 1 } },
      { id: "group-b", type: "group", x: 330, y: 400, width: 230, height: 160, label: "Group B", vendorGroupB: [2] },
      { id: "group-c", type: "group", x: 700, y: 390, width: 200, height: 150, label: "Group C", vendorGroupC: "keep" },
      { id: "card-a", type: "text", x: 20, y: 90, width: 190, height: 110, text: "Card A", vendorCardA: true },
      { id: "card-b", type: "text", x: 700, y: 90, width: 190, height: 110, text: "Card B", vendorCardB: { keep: true } },
    ],
    edges: [{
      id: "edge-1",
      fromNode: "card-a",
      fromSide: "right",
      fromEnd: "none",
      toNode: "card-b",
      toSide: "left",
      toEnd: "arrow",
      label: "Preserve me",
      color: "4",
      vendorEdge: { deep: [1, 2] },
    }],
  };
  const initialText = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(canvasPath, initialText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Group connections.canvas"]').click();
    let view = window.locator(".canvas-view");
    let surface = view.locator(".canvas-surface");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    expect(Number(transformedCamera.scale)).not.toBe(1);

    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__groupConnectionWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Group connections.canvas") (window as any).__groupConnectionWrites += 1;
        return modify(file, data);
      };
    });
    const writeCount = () => window.evaluate(() => (window as any).__groupConnectionWrites as number);
    const groupA = view.locator('.canvas-node[data-node-id="group-a"]');
    const groupB = view.locator('.canvas-node[data-node-id="group-b"]');
    const groupC = view.locator('.canvas-node[data-node-id="group-c"]');
    const cardA = view.locator('.canvas-node[data-node-id="card-a"]');
    const cardB = view.locator('.canvas-node[data-node-id="card-b"]');

    // Groups expose the same four accessible side handles. An empty drop from
    // a group opens the existing chooser and Escape rolls back its text-card
    // transaction without a Canvas write.
    await selectNodeWithoutWrite(window, groupA);
    await expect(groupA.locator(".canvas-node-connection-handle")).toHaveCount(4);
    for (const side of ["top", "right", "bottom", "left"]) {
      await expect(groupA.getByRole("button", { name: `Connect from ${side}` })).toBeVisible();
    }
    const surfaceBox = (await surface.boundingBox())!;
    const emptyPoint = { x: surfaceBox.x + 30, y: surfaceBox.y + surfaceBox.height - 30 };
    const groupTop = groupA.getByRole("button", { name: "Connect from top" });
    const groupTopPoint = await center(groupTop);
    await window.mouse.move(groupTopPoint.x, groupTopPoint.y);
    await window.mouse.down();
    await window.mouse.move(emptyPoint.x, emptyPoint.y);
    await window.mouse.up();
    await expect(window.locator(".context-menu-item")).toHaveText([
      "Add text card", "Add note from vault", "Add media from vault", "Add web page",
    ]);
    await window.locator(".context-menu-item", { hasText: /^Add text card$/ }).click();
    const pending = view.locator('.canvas-node[data-node-id="text-1"] .canvas-node-text-editor');
    await expect(pending).toBeFocused();
    await expect(view.locator('.canvas-edge[data-edge-id="edge-2"]')).toHaveCount(1);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await pending.press("Escape");
    await expect(view.locator('.canvas-node[data-node-id="text-1"], .canvas-edge[data-edge-id="edge-2"]')).toHaveCount(0);
    await expect(groupA).toHaveClass(/is-selected/);
    expect(await writeCount()).toBe(0);
    expect(await camera(view)).toEqual(transformedCamera);

    // Group body and self-handle drops remain inert.
    await connect(window, groupA.getByRole("button", { name: "Connect from right" }), groupB);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    await connect(window, groupA.getByRole("button", { name: "Connect from right" }), groupA.getByRole("button", { name: "Connect from left" }));
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await writeCount()).toBe(0);

    // Card→group, group→card, and group→group use the canonical explicit
    // schema, stable collision-safe IDs, one write, and sole edge selection.
    const creationCases = [
      { sourceNode: cardA, source: "right", targetNode: groupA, target: "left", id: "edge-2", from: "card-a", to: "group-a" },
      { sourceNode: groupA, source: "right", targetNode: cardB, target: "left", id: "edge-3", from: "group-a", to: "card-b" },
      { sourceNode: groupA, source: "bottom", targetNode: groupB, target: "top", id: "edge-4", from: "group-a", to: "group-b" },
    ];
    for (const [index, item] of creationCases.entries()) {
      await selectNodeWithoutWrite(window, item.sourceNode);
      await connect(
        window,
        item.sourceNode.getByRole("button", { name: `Connect from ${item.source}` }),
        item.targetNode.getByRole("button", { name: `Connect from ${item.target}` }),
      );
      await expect.poll(() => readCanvas(canvasPath)?.edges.find((edge: { id: string }) => edge.id === item.id) ?? null).toEqual({
        id: item.id,
        fromNode: item.from,
        fromSide: item.source,
        fromEnd: "none",
        toNode: item.to,
        toSide: item.target,
        toEnd: "arrow",
      });
      expect(await writeCount()).toBe(index + 1);
      await expect(view.locator(`.canvas-edge[data-edge-id="${item.id}"]`)).toHaveClass(/is-selected/);
      await expect(view.locator(".canvas-edge.is-selected")).toHaveCount(1);
      await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
      await expect(view.locator(`.canvas-edge-endpoint-handle.is-selected[data-edge-id="${item.id}"]`)).toHaveCount(2);
      expect(await camera(view)).toEqual(transformedCamera);
    }

    // Reconnect both endpoints of the pre-existing edge onto group handles.
    // The edge identity and every non-endpoint/extension field remain exact.
    await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("click");
    let endpoint = view.getByRole("button", { name: "Reconnect target of edge-1" });
    await expect(endpoint).toBeVisible();
    await reconnect(window, endpoint, groupC.getByRole("button", { name: "Connect from left" }));
    await expect.poll(() => readCanvas(canvasPath)?.edges[0] ?? null).toEqual({
      ...initial.edges[0],
      toNode: "group-c",
      toSide: "left",
    });
    expect(await writeCount()).toBe(4);
    endpoint = view.getByRole("button", { name: "Reconnect source of edge-1" });
    await reconnect(window, endpoint, groupB.getByRole("button", { name: "Connect from top" }));
    const reconnected = {
      ...initial.edges[0],
      fromNode: "group-b",
      fromSide: "top",
      toNode: "group-c",
      toSide: "left",
    };
    await expect.poll(() => readCanvas(canvasPath)?.edges[0] ?? null).toEqual(reconnected);
    expect(await writeCount()).toBe(5);
    expect(await camera(view)).toEqual(transformedCamera);

    // Unchanged, self, and group-body reconnect drops do not write or corrupt.
    const unchanged = fs.readFileSync(canvasPath, "utf8");
    endpoint = view.getByRole("button", { name: "Reconnect target of edge-1" });
    await reconnect(window, endpoint, groupC.getByRole("button", { name: "Connect from left" }));
    await reconnect(window, endpoint, groupB.getByRole("button", { name: "Connect from right" }));
    await reconnect(window, endpoint, groupA);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(unchanged);
    expect(await writeCount()).toBe(5);

    // Existing group movement redraws incident edges live and persists without
    // rewriting any edge metadata.
    const edge4Path = await view.locator('.canvas-edge[data-edge-id="edge-4"]').getAttribute("d");
    const groupBBox = (await groupB.boundingBox())!;
    await window.mouse.move(groupBBox.x + groupBBox.width / 2, groupBBox.y + groupBBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(groupBBox.x + groupBBox.width / 2 + 30, groupBBox.y + groupBBox.height / 2 + 20);
    await window.mouse.up();
    await expect.poll(writeCount).toBe(6);
    await expect(view.locator('.canvas-edge[data-edge-id="edge-4"]')).not.toHaveAttribute("d", edge4Path!);
    const saved = readCanvas(canvasPath)!;
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(saved.nodes.find((node: { id: string }) => node.id === "group-a").vendorGroupA).toEqual({ keep: 1 });
    expect(saved.nodes.find((node: { id: string }) => node.id === "group-b").vendorGroupB).toEqual([2]);
    expect(saved.nodes.find((node: { id: string }) => node.id === "group-c").vendorGroupC).toBe("keep");
    expect(saved.edges[0]).toEqual(reconnected);
    expect(saved.edges.slice(1).map((edge: { id: string }) => edge.id)).toEqual(["edge-2", "edge-3", "edge-4"]);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Group connections.canvas"]').click();
    view = window.locator(".canvas-view");
    surface = view.locator(".canvas-surface");
    await expect(view.locator(".canvas-node-group .canvas-node-connection-handle")).toHaveCount(12);
    await expect(view.locator(".canvas-edge")).toHaveCount(4);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
