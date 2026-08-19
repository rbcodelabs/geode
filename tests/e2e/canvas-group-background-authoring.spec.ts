import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const noBackgroundMenu = ["Zoom to selection", "Set background", "Delete"];
const backgroundMenu = ["Zoom to selection", "Set background", "Set background style", "Remove background", "Delete"];
const styleMenu = ["Cover", "Ratio", "Repeat"];

async function camera(view: Locator): Promise<Record<string, string | null>> {
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

async function openGroupMenu(page: Page, view: Locator, id: string, expected: string[]): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).toHaveText(expected);
}

async function chooseImage(page: Page, name: string): Promise<void> {
  const input = page.locator(".prompt-input");
  await expect(input).toBeFocused();
  await input.fill(name);
  await page.locator(".prompt-result", { hasText: name }).click();
}

test("authors, restyles, and removes group backgrounds through exact context actions", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-background-author-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-background-author-user-"));
  const canvasPath = path.join(vaultDir, "Group backgrounds.canvas");
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(vaultDir, "Old.png"), pixel);
  fs.writeFileSync(path.join(vaultDir, "First.png"), pixel);
  fs.writeFileSync(path.join(vaultDir, "Replacement.png"), pixel);
  fs.writeFileSync(path.join(vaultDir, "Sound.mp3"), Buffer.from([0x49, 0x44, 0x33]));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Not an image\n");
  const initial = {
    vendorCanvas: { preserve: true },
    nodes: [
      { id: "plain", type: "group", x: 40, y: 40, width: 300, height: 220, label: "Plain", color: "1", vendorPlain: { deep: [1] } },
      { id: "existing", type: "group", x: 400, y: 40, width: 300, height: 220, label: "Existing", color: "2", background: "Old.png", backgroundStyle: "cover", vendorExisting: [2] },
      { id: "text", type: "text", x: 80, y: 340, width: 220, height: 120, text: "Text", color: "3", vendorText: { keep: true } },
    ],
    edges: [],
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
    await expect(window.locator('.nav-file-title[data-path="Group backgrounds.canvas"]')).toBeVisible();
    await window.evaluate(() => {
      const created: string[] = [];
      const revoked: string[] = [];
      const createObjectURL = URL.createObjectURL.bind(URL);
      const revokeObjectURL = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob) => {
        const url = createObjectURL(blob);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        revoked.push(url);
        revokeObjectURL(url);
      };
      (window as any).__groupBackgroundUrls = { created, revoked };
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__groupBackgroundWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Group backgrounds.canvas") (window as any).__groupBackgroundWrites += 1;
        return modify(file, data);
      };
    });

    await window.locator('.nav-file-title[data-path="Group backgrounds.canvas"]').click();
    let view = window.locator(".canvas-view");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const cameraBefore = await camera(view);
    const plain = view.locator('.canvas-node[data-node-id="plain"]');
    await expect(plain).toHaveCSS("background-image", "none");
    await expect(view.locator('.canvas-node[data-node-id="existing"]')).toHaveCSS("background-size", "cover");
    await expect.poll(() => window.evaluate(() => (window as any).__groupBackgroundUrls.created.length)).toBe(1);

    // Only groups gain the exact background actions; existing node menus keep
    // their established order and wording.
    await openGroupMenu(window, view, "plain", noBackgroundMenu);
    await openGroupMenu(window, view, "existing", backgroundMenu);
    await view.locator('.canvas-node[data-node-id="text"]').click({ button: "right", position: { x: 30, y: 30 } });
    await expect(window.locator(".context-menu-item")).toHaveText([
      "Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete",
    ]);

    await openGroupMenu(window, view, "plain", noBackgroundMenu);
    const selectedBefore = await selectedIds(view);
    expect(selectedBefore).toEqual(["plain"]);
    const diskBefore = fs.readFileSync(canvasPath, "utf8");
    await window.locator(".context-menu-item", { hasText: /^Set background$/ }).click();
    const pickerResults = await window.locator(".prompt-result").allInnerTexts();
    expect(pickerResults).toEqual(expect.arrayContaining(["Old.png", "First.png", "Replacement.png"]));
    expect(pickerResults.some((item) => /\.(md|mp3|canvas)$/i.test(item))).toBe(false);
    await window.keyboard.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(await selectedIds(view)).toEqual(selectedBefore);
    expect(await camera(view)).toEqual(cameraBefore);
    expect(await window.evaluate(() => (window as any).__groupBackgroundWrites)).toBe(0);

    // Picking an image is still transient until an explicit style is chosen.
    await openGroupMenu(window, view, "plain", noBackgroundMenu);
    await window.locator(".context-menu-item", { hasText: /^Set background$/ }).click();
    await chooseImage(window, "First.png");
    await expect(window.locator(".context-menu-item")).toHaveText(styleMenu);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    await window.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await expect(window.locator(".context-menu-item")).toHaveCount(0);
    await expect(plain).toHaveCSS("background-image", "none");
    expect(await selectedIds(view)).toEqual(selectedBefore);
    expect(await camera(view)).toEqual(cameraBefore);
    expect(await window.evaluate(() => (window as any).__groupBackgroundWrites)).toBe(0);

    // Image + style commit atomically in one Canvas write and rerender through
    // the managed blob lifecycle.
    const urlsBeforeAuthoring = await window.evaluate(() => [...(window as any).__groupBackgroundUrls.created] as string[]);
    await openGroupMenu(window, view, "plain", noBackgroundMenu);
    await window.locator(".context-menu-item", { hasText: /^Set background$/ }).click();
    await chooseImage(window, "First.png");
    await window.locator(".context-menu-item", { hasText: /^Ratio$/ }).click();
    await expect(plain).toHaveCSS("background-size", "contain");
    await expect(plain).toHaveCSS("background-position", "50% 50%");
    await expect(plain).toHaveCSS("background-repeat", "no-repeat");
    await expect.poll(() => window.evaluate(() => (window as any).__groupBackgroundWrites)).toBe(1);
    await expect.poll(async () => {
      const revoked = await window.evaluate(() => [...(window as any).__groupBackgroundUrls.revoked] as string[]);
      return urlsBeforeAuthoring.every((url) => revoked.includes(url));
    }).toBe(true);
    let saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.find((node: { id: string }) => node.id === "plain")).toMatchObject({
      background: "First.png", backgroundStyle: "ratio", vendorPlain: { deep: [1] },
    });
    expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(saved.nodes.find((node: { id: string }) => node.id === "existing")).toEqual(initial.nodes[1]);
    expect(saved.nodes.find((node: { id: string }) => node.id === "text")).toEqual(initial.nodes[2]);
    expect(saved.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(await selectedIds(view)).toEqual(selectedBefore);
    expect(await camera(view)).toEqual(cameraBefore);

    // Existing backgrounds can replace only their style, with cancellation
    // remaining byte-identical and a successful style change writing once.
    await openGroupMenu(window, view, "plain", backgroundMenu);
    const beforeStyleCancel = fs.readFileSync(canvasPath, "utf8");
    await window.locator(".context-menu-item", { hasText: /^Set background style$/ }).click();
    await expect(window.locator(".context-menu-item")).toHaveText(styleMenu);
    await window.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeStyleCancel);
    expect(await window.evaluate(() => (window as any).__groupBackgroundWrites)).toBe(1);
    await openGroupMenu(window, view, "plain", backgroundMenu);
    await window.locator(".context-menu-item", { hasText: /^Set background style$/ }).click();
    await window.locator(".context-menu-item", { hasText: /^Repeat$/ }).click();
    await expect(plain).toHaveCSS("background-size", "auto");
    await expect(plain).toHaveCSS("background-position", "0% 0%");
    await expect(plain).toHaveCSS("background-repeat", "repeat");
    await expect.poll(() => window.evaluate(() => (window as any).__groupBackgroundWrites)).toBe(2);
    saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.nodes.find((node: { id: string }) => node.id === "plain")).toMatchObject({
      background: "First.png", backgroundStyle: "repeat", vendorPlain: { deep: [1] },
    });
    expect(await selectedIds(view)).toEqual(selectedBefore);
    expect(await camera(view)).toEqual(cameraBefore);

    // A renderer reload proves authored schema/render persistence before the
    // exact removal action deletes both optional fields atomically.
    const repeatText = fs.readFileSync(canvasPath, "utf8");
    await window.reload();
    await window.locator('.nav-file-title[data-path="Group backgrounds.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="plain"]')).toHaveCSS("background-repeat", "repeat");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(repeatText);
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__groupBackgroundRemovalWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Group backgrounds.canvas") (window as any).__groupBackgroundRemovalWrites += 1;
        return modify(file, data);
      };
    });
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const removeCamera = await camera(view);
    await openGroupMenu(window, view, "plain", backgroundMenu);
    await window.locator(".context-menu-item", { hasText: /^Remove background$/ }).click();
    await expect(view.locator('.canvas-node[data-node-id="plain"]')).toHaveCSS("background-image", "none");
    await expect.poll(() => window.evaluate(() => (window as any).__groupBackgroundRemovalWrites)).toBe(1);
    const removed = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    const removedPlain = removed.nodes.find((node: { id: string }) => node.id === "plain");
    expect(removedPlain.background).toBeUndefined();
    expect(removedPlain.backgroundStyle).toBeUndefined();
    expect(removedPlain.vendorPlain).toEqual({ deep: [1] });
    expect(removed.nodes.map((node: { id: string }) => node.id)).toEqual(initial.nodes.map((node) => node.id));
    expect(removed.nodes.find((node: { id: string }) => node.id === "existing")).toEqual(initial.nodes[1]);
    expect(removed.nodes.find((node: { id: string }) => node.id === "text")).toEqual(initial.nodes[2]);
    expect(removed.vendorCanvas).toEqual(initial.vendorCanvas);
    expect(await selectedIds(view)).toEqual(["plain"]);
    expect(await camera(view)).toEqual(removeCamera);

    const removedText = fs.readFileSync(canvasPath, "utf8");
    await window.reload();
    await window.locator('.nav-file-title[data-path="Group backgrounds.canvas"]').click();
    await expect(window.locator('.canvas-node[data-node-id="plain"]')).toHaveCSS("background-image", "none");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(removedText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
