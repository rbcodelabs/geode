import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function camera(view: Locator): Promise<Record<string, string | null>> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

async function controlNames(view: Locator): Promise<string[]> {
  return view.locator(".canvas-selection-controls > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? ""));
}

async function selectNodeFromContext(page: Page, view: Locator, id: string): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 40 } });
  await view.locator(".view-header").click();
  await expect(page.locator(".context-menu-item")).toHaveCount(0);
  await expect(view.locator(`.canvas-node[data-node-id="${id}"]`)).toHaveClass(/is-selected/);
}

test("exposes capability-specific floating actions for one selected non-group Canvas node", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-node-actions-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-node-actions-user-"));
  const canvasPath = path.join(vaultDir, "Node actions.canvas");
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  fs.writeFileSync(path.join(vaultDir, "Note A.md"), "# Note A\n");
  fs.writeFileSync(path.join(vaultDir, "Note B.md"), "# Note B\n");
  fs.writeFileSync(path.join(vaultDir, "Replacement.md"), "# Replacement\n");
  fs.writeFileSync(path.join(vaultDir, "Image.png"), pixel);
  fs.writeFileSync(path.join(vaultDir, "Audio.mp3"), Buffer.from([0x49, 0x44, 0x33]));
  fs.writeFileSync(path.join(vaultDir, "Video.mp4"), Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]));
  fs.writeFileSync(path.join(vaultDir, "Other.bin"), Buffer.from([1, 2, 3]));
  const initial = {
    vendorCanvas: { preserve: ["document"] },
    nodes: [
      { id: "text", type: "text", x: 20, y: 20, width: 220, height: 140, text: "Editable text", color: "1", vendorText: { keep: true } },
      { id: "note-a", type: "file", x: 280, y: 20, width: 240, height: 180, file: "Note A.md", subpath: "#Note A", color: "2", vendorNoteA: [1] },
      { id: "note-b", type: "file", x: 560, y: 20, width: 240, height: 180, file: "Note B.md", subpath: "#Old", color: "3", vendorNoteB: { deep: "keep" } },
      { id: "image", type: "file", x: 840, y: 20, width: 240, height: 180, file: "Image.png", vendorImage: true },
      { id: "audio", type: "file", x: 20, y: 240, width: 240, height: 140, file: "Audio.mp3", vendorAudio: true },
      { id: "video", type: "file", x: 300, y: 240, width: 240, height: 180, file: "Video.mp4", vendorVideo: true },
      { id: "other", type: "file", x: 580, y: 240, width: 240, height: 140, file: "Other.bin", vendorOther: true },
      { id: "dynamic", type: "file", x: 860, y: 240, width: 240, height: 140, file: "Missing.md", vendorDynamic: { keep: true } },
      { id: "valid-link", type: "link", x: 20, y: 440, width: 300, height: 150, url: "  HTTPS://Example.com/path  ", vendorLink: ["keep"] },
      { id: "invalid-link", type: "link", x: 360, y: 440, width: 300, height: 150, url: "javascript:alert(1)", vendorInvalid: true },
      { id: "group", type: "group", x: 720, y: 440, width: 320, height: 200, label: "Group", vendorGroup: true },
    ],
    edges: [
      { id: "edge", fromNode: "text", fromSide: "right", fromEnd: "none", toNode: "note-a", toSide: "left", toEnd: "arrow", label: "Edge", vendorEdge: true },
    ],
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
    await expect(window.locator('.nav-file-title[data-path="Node actions.canvas"]')).toBeVisible();
    await window.evaluate(() => {
      const w = window as any;
      w.__nodeActionWrites = 0;
      w.__nodeActionExternal = [] as string[];
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Node actions.canvas") w.__nodeActionWrites += 1;
        return modify(file, data);
      };
      w.geode.openExternal = async (url: string) => { w.__nodeActionExternal.push(url); };
    });

    await window.locator('.nav-file-title[data-path="Node actions.canvas"]').click();
    let view = window.locator(".canvas-view");
    await view.locator('[data-canvas-action="fit"]').click();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);

    // Text cards gain exact edit/convert actions. Both editors cancel without
    // writes, selection drift, camera movement, or document mutation.
    await selectNodeFromContext(window, view, "text");
    expect(await controlNames(view)).toEqual(["Set color", "Edit", "Convert to file…", "Remove"]);
    await view.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = view.locator('.canvas-node[data-node-id="text"] textarea');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Editable text");
    await editor.fill("Do not save");
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await view.getByRole("button", { name: "Convert to file…", exact: true }).click();
    let prompt = window.locator(".prompt-input");
    await expect(prompt).toHaveAttribute("placeholder", "File name…");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialText);
    expect(await window.evaluate(() => (window as any).__nodeActionWrites)).toBe(0);
    expect(await camera(view)).toEqual(transformedCamera);

    // Resolved note and each supported media kind expose Swap file; generic,
    // missing, and unsafe link cards remain at the exact generic controls.
    for (const id of ["note-a", "note-b", "image", "audio", "video"]) {
      await selectNodeFromContext(window, view, id);
      expect(await controlNames(view)).toEqual(["Set color", "Swap file", "Remove"]);
    }
    for (const id of ["other", "dynamic", "invalid-link"]) {
      await selectNodeFromContext(window, view, id);
      expect(await controlNames(view)).toEqual(["Set color", "Remove"]);
    }

    // A same-ID resolution change must alter the capability signature and
    // rebuild controls without changing selection, camera, order, or fields.
    await selectNodeFromContext(window, view, "dynamic");
    const resolvedDynamic = structuredClone(initial);
    (resolvedDynamic.nodes.find((node) => node.id === "dynamic") as any).file = "Note A.md";
    await window.evaluate(async (nextDocument) => {
      const w = window as any;
      const file = w.app.vault.getFileByPath("Node actions.canvas");
      await w.app.vault.modify(file, JSON.stringify(nextDocument, null, 2) + "\n");
    }, resolvedDynamic);
    await expect.poll(() => controlNames(view)).toEqual(["Set color", "Swap file", "Remove"]);
    await expect(view.locator('.canvas-node[data-node-id="dynamic"]')).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);
    await window.evaluate(() => { (window as any).__nodeActionWrites = 0; });

    // Picker cancellation on note-a is byte-identical. Switching to note-b,
    // which has the same capability signature, must rebuild the node closure;
    // a successful swap changes note-b only and persists exactly once.
    await selectNodeFromContext(window, view, "note-a");
    const beforeSwapCancel = fs.readFileSync(canvasPath, "utf8");
    await view.getByRole("button", { name: "Swap file", exact: true }).click();
    prompt = window.locator(".prompt-input");
    await expect(prompt).toHaveAttribute("placeholder", "Search notes…");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeSwapCancel);
    expect(await window.evaluate(() => (window as any).__nodeActionWrites)).toBe(0);

    await selectNodeFromContext(window, view, "note-b");
    await view.getByRole("button", { name: "Swap file", exact: true }).click();
    await prompt.fill("Replacement.md");
    await window.locator(".prompt-result", { hasText: "Replacement.md" }).click();
    await expect.poll(() => readCanvas(canvasPath)?.nodes.find((node: { id: string }) => node.id === "note-b")?.file ?? null)
      .toBe("Replacement.md");
    expect(await window.evaluate(() => (window as any).__nodeActionWrites)).toBe(1);
    const swapped = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(swapped.nodes.find((node: { id: string }) => node.id === "note-a")).toEqual(initial.nodes[1]);
    expect(swapped.nodes.find((node: { id: string }) => node.id === "note-b")).toEqual({
      ...initial.nodes[2], file: "Replacement.md", subpath: undefined,
    });
    expect(swapped.nodes.find((node: { id: string }) => node.id === "dynamic")).toEqual({
      ...initial.nodes[7], file: "Note A.md",
    });
    expect(swapped.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(swapped.edges).toEqual(initial.edges);
    expect(swapped.vendorCanvas).toEqual(initial.vendorCanvas);
    await expect(view.locator('.canvas-node[data-node-id="note-b"]')).toHaveClass(/is-selected/);
    expect(await camera(view)).toEqual(transformedCamera);

    // Valid canonical links use the exact OS-external route from controls and
    // never mutate the Canvas or renderer location.
    const beforeExternal = fs.readFileSync(canvasPath, "utf8");
    const rendererUrl = window.url();
    await selectNodeFromContext(window, view, "valid-link");
    expect(await controlNames(view)).toEqual(["Set color", "Open in browser", "Remove"]);
    await view.getByRole("button", { name: "Open in browser", exact: true }).click();
    await expect.poll(() => window.evaluate(() => (window as any).__nodeActionExternal)).toEqual([
      "https://example.com/path",
    ]);
    expect(window.url()).toBe(rendererUrl);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeExternal);
    expect(await window.evaluate(() => (window as any).__nodeActionWrites)).toBe(1);
    expect(await camera(view)).toEqual(transformedCamera);

    // Group, sole-edge, and multi-node controls retain their exact established
    // surfaces and must not inherit non-group node actions.
    await selectNodeFromContext(window, view, "group");
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Set background", "Remove"]);
    await view.locator('.canvas-edge-hit[data-edge-id="edge"]').dispatchEvent("click");
    expect(await controlNames(view)).toEqual(["Set color", "Edit label", "Remove"]);
    await view.locator(".canvas-surface").focus();
    await window.keyboard.press("ControlOrMeta+A");
    expect(await controlNames(view)).toEqual(["Set color", "Remove"]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeExternal);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Node actions.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="note-b"]')).toHaveAttribute("data-file-path", "Replacement.md");
    await expect(view.locator(".canvas-selection-controls")).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(swapped);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
