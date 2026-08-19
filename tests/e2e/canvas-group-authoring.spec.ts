import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("authors labeled and viewport-centered Canvas groups with stable persistence", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-groups-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-groups-user-"));
  const canvasPath = path.join(vaultDir, "Groups.canvas");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [
      { id: "group-1", type: "group", x: 720, y: 360, width: 180, height: 120, label: "Existing", vendorExistingGroup: "keep" },
      { id: "card-a", type: "text", x: 100, y: 100, width: 180, height: 100, text: "A", vendorA: "keep" },
      { id: "card-b", type: "text", x: 360, y: 180, width: 200, height: 120, text: "B", vendorB: "keep" },
    ],
    edges: [],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Groups.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const addGroup = view.getByRole("button", { name: "Add group" });
    await expect(addGroup).toHaveCount(1);

    // Establish non-default camera state and select two eligible cards.
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const surfaceBox = (await surface.boundingBox())!;
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 60, surfaceBox.y + surfaceBox.height - 70);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 95, surfaceBox.y + surfaceBox.height - 90);
    await window.mouse.up({ button: "middle" });
    const camera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    const cardA = view.locator('.canvas-node[data-node-id="card-a"]');
    const cardB = view.locator('.canvas-node[data-node-id="card-b"]');
    await cardA.click();
    await cardB.click({ modifiers: ["Shift"] });
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(2);
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.at(-1).id).toBe("card-b");

    // Escape cancels the prompt without inserting or persisting a group.
    const beforeCancel = fs.readFileSync(canvasPath, "utf8");
    await addGroup.click();
    const prompt = window.locator(".prompt-input");
    await expect(prompt).toBeFocused();
    await prompt.fill("Cancelled");
    await prompt.press("Escape");
    await expect(prompt).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeCancel);
    await expect(view.locator(".canvas-node-group")).toHaveCount(1);

    // Empty Enter creates group-2 without an optional label, padded exactly
    // 40 world units around both selected card bounds and ordered behind them.
    await addGroup.click();
    await prompt.press("Enter");
    const selectedGroup = view.locator('.canvas-node[data-node-id="group-2"]');
    await expect(selectedGroup).toHaveClass(/is-selected/);
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(1);
    expect(await selectedGroup.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }))).toEqual({ x: 60, y: 60, width: 540, height: 280 });
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.some((node: { id: string }) => node.id === "group-2")).toBe(true);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const group2 = saved.nodes.find((node: { id: string }) => node.id === "group-2");
    expect(Object.hasOwn(group2, "label")).toBe(false);
    expect(saved.nodes.findIndex((node: { id: string }) => node.id === "group-2")).toBeLessThan(saved.nodes.findIndex((node: { id: string }) => node.id === "card-a"));
    expect(saved.nodes.findIndex((node: { id: string }) => node.id === "group-2")).toBeLessThan(saved.nodes.findIndex((node: { id: string }) => node.id === "card-b"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.find((node: { id: string }) => node.id === "card-a").vendorA).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "card-b").vendorB).toBe("keep");
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    // Double-click label editing is prefilled, trimmed, clearable, and
    // cancel-safe. Leave a final label for reload evidence.
    const label = selectedGroup.locator(".canvas-group-label");
    await label.dblclick();
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue("");
    await prompt.fill("  Sprint planning  ");
    await prompt.press("Enter");
    await expect(label).toHaveText("Sprint planning");
    await label.dblclick();
    await expect(prompt).toHaveValue("Sprint planning");
    await prompt.fill("   ");
    await prompt.press("Enter");
    await expect(label).toHaveText("Group");
    await expect.poll(() => Object.hasOwn(JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "group-2"), "label")).toBe(false);
    const beforeLabelCancel = fs.readFileSync(canvasPath, "utf8");
    await label.dblclick();
    await prompt.fill("Must not save");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeLabelCancel);
    await label.dblclick();
    await prompt.fill("  Roadmap  ");
    await prompt.press("Enter");
    await expect(label).toHaveText("Roadmap");

    // A selected group is not an eligible card selection, so group-3 uses a
    // stable default size centered in the transformed viewport.
    const currentSurface = (await surface.boundingBox())!;
    const expectedCenter = {
      x: (currentSurface.width / 2 - Number(camera.panX)) / Number(camera.scale),
      y: (currentSurface.height / 2 - Number(camera.panY)) / Number(camera.scale),
    };
    await addGroup.click();
    await prompt.press("Enter");
    const defaultGroup = view.locator('.canvas-node[data-node-id="group-3"]');
    const defaultGeometry = await defaultGroup.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(defaultGeometry.width).toBe(400);
    expect(defaultGeometry.height).toBe(300);
    expect(defaultGeometry.x + defaultGeometry.width / 2).toBeCloseTo(expectedCenter.x, 3);
    expect(defaultGeometry.y + defaultGeometry.height / 2).toBeCloseTo(expectedCenter.y, 3);
    await expect(defaultGroup).toHaveClass(/is-selected/);

    // Existing group drag, resize, and Delete behavior persists normally.
    let box = (await defaultGroup.boundingBox())!;
    await window.mouse.move(box.x + 18, box.y + box.height - 30);
    await window.mouse.down();
    await window.mouse.move(box.x + 68, box.y + box.height + 10);
    await window.mouse.up();
    await expect.poll(() => defaultGroup.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left))).not.toBe(defaultGeometry.x);
    const resize = defaultGroup.locator(".canvas-node-resize-handle");
    box = (await resize.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40);
    await window.mouse.up();
    await expect.poll(() => defaultGroup.evaluate((element) => Number((element as HTMLElement).dataset.width))).toBeGreaterThan(400);
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.find((node: { id: string }) => node.id === "group-3")?.width).toBeGreaterThan(400);
    await window.keyboard.press("Delete");
    await expect(defaultGroup).toHaveCount(0);
    await expect.poll(() => JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.some((node: { id: string }) => node.id === "group-3")).toBe(false);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(camera);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Groups.canvas"]').click();
    await expect(window.locator('.canvas-node[data-node-id="group-2"] .canvas-group-label')).toHaveText("Roadmap");
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.find((node: { id: string }) => node.id === "group-2").label).toBe("Roadmap");
    expect(saved.nodes.find((node: { id: string }) => node.id === "group-1").vendorExistingGroup).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "card-a").vendorA).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "card-b").vendorB).toBe("keep");
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
