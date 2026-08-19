import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const plainGroupMenu = ["Zoom to selection", "Edit label", "Set background", "Delete"];
const backgroundGroupMenu = [
  "Zoom to selection", "Edit label", "Set background", "Set background style", "Remove background", "Delete",
];
const plainGroupControls = ["Set color", "Edit label", "Set background", "Remove"];
const backgroundGroupControls = [
  "Set color", "Edit label", "Set background", "Set background style", "Remove background", "Remove",
];

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

async function selectedIds(view: Locator): Promise<string[]> {
  return view.locator(".canvas-node.is-selected").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.nodeId!).sort());
}

async function controlNames(view: Locator): Promise<string[]> {
  return view.locator(".canvas-selection-controls > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? ""));
}

async function openGroupMenu(page: Page, view: Locator, id: string, expected: string[]): Promise<void> {
  await view.locator(`.canvas-node[data-node-id="${id}"]`).click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".context-menu-item")).toHaveText(expected);
}

async function dismissMenu(page: Page, view: Locator): Promise<void> {
  await view.locator(".view-header").click();
  await expect(page.locator(".context-menu-item")).toHaveCount(0);
}

async function chooseImage(page: Page, name: string): Promise<void> {
  const input = page.locator(".prompt-input");
  await expect(input).toBeFocused();
  await input.fill(name);
  await page.locator(".prompt-result", { hasText: name }).click();
}

test("exposes exact group label and background actions in context and sole-selection controls", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-actions-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-actions-user-"));
  const canvasPath = path.join(vaultDir, "Group actions.canvas");
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  fs.writeFileSync(path.join(vaultDir, "Old.png"), pixel);
  fs.writeFileSync(path.join(vaultDir, "New.png"), pixel);
  fs.writeFileSync(path.join(vaultDir, "Not image.md"), "# Not an image\n");
  const initial = {
    vendorCanvas: { preserve: ["top"] },
    nodes: [
      {
        id: "plain", type: "group", x: 40, y: 40, width: 300, height: 220,
        label: "Plain", color: "1", vendorPlain: { deep: true },
      },
      {
        id: "existing", type: "group", x: 400, y: 40, width: 300, height: 220,
        label: "Existing", color: "2", background: "Old.png", backgroundStyle: "cover",
        vendorExisting: ["keep"],
      },
      {
        id: "text", type: "text", x: 100, y: 340, width: 240, height: 140,
        text: "Text", color: "3", vendorText: { keep: true },
      },
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
    await expect(window.locator('.nav-file-title[data-path="Group actions.canvas"]')).toBeVisible();
    await window.evaluate(() => {
      const w = window as any;
      const modify = w.app.vault.modify.bind(w.app.vault);
      w.__groupActionWrites = 0;
      w.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Group actions.canvas") w.__groupActionWrites += 1;
        return modify(file, data);
      };
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
      w.__groupActionUrls = { created, revoked };
    });

    await window.locator('.nav-file-title[data-path="Group actions.canvas"]').click();
    let view = window.locator(".canvas-view");
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const transformedCamera = await camera(view);
    await expect.poll(() => window.evaluate(() => (window as any).__groupActionUrls.created.length)).toBe(1);

    // Group-only context menus expose Edit label immediately before the
    // existing background actions, while non-group menus remain exact.
    await openGroupMenu(window, view, "plain", plainGroupMenu);
    await openGroupMenu(window, view, "existing", backgroundGroupMenu);
    await view.locator('.canvas-node[data-node-id="text"]').click({ button: "right", position: { x: 30, y: 30 } });
    await expect(window.locator(".context-menu-item")).toHaveText([
      "Zoom to selection", "Edit", "Convert to file…", "Create group", "Delete",
    ]);

    // Context-selecting a plain group builds the exact sole-group controls.
    // Opening the new context label action and cancelling the shared prompt
    // is byte/camera inert.
    await openGroupMenu(window, view, "plain", plainGroupMenu);
    expect(await controlNames(view)).toEqual(plainGroupControls);
    expect(await selectedIds(view)).toEqual(["plain"]);
    const beforeLabelCancel = fs.readFileSync(canvasPath, "utf8");
    await window.locator(".context-menu-item", { hasText: /^Edit label$/ }).click();
    let prompt = window.locator(".prompt-input");
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveAttribute("placeholder", "Group label…");
    await expect(prompt).toHaveValue("Plain");
    await prompt.fill("Do not persist");
    await prompt.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeLabelCancel);
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(0);
    expect(await selectedIds(view)).toEqual(["plain"]);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(await controlNames(view)).toEqual(plainGroupControls);

    // A trimmed control label commit writes once and retains the sole group,
    // camera, ordering, and arbitrary document/node fields.
    await view.getByRole("button", { name: "Edit label", exact: true }).click();
    prompt = window.locator(".prompt-input");
    await prompt.fill("  Renamed plain  ");
    await prompt.press("Enter");
    await expect(view.locator('.canvas-node[data-node-id="plain"] .canvas-group-label')).toHaveText("Renamed plain");
    await expect.poll(() => readCanvas(canvasPath)?.nodes[0]?.label ?? null).toBe("Renamed plain");
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(1);
    expect(await selectedIds(view)).toEqual(["plain"]);
    expect(await camera(view)).toEqual(transformedCamera);
    expect(await controlNames(view)).toEqual(plainGroupControls);

    // Switching sole group selection must rebuild group-specific closures:
    // this editor must target existing, not the previously selected plain.
    await openGroupMenu(window, view, "existing", backgroundGroupMenu);
    await dismissMenu(window, view);
    expect(await controlNames(view)).toEqual(backgroundGroupControls);
    expect(await selectedIds(view)).toEqual(["existing"]);
    await view.getByRole("button", { name: "Edit label", exact: true }).click();
    prompt = window.locator(".prompt-input");
    await expect(prompt).toHaveValue("Existing");
    await prompt.press("Escape");
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(1);

    // Returning to plain proves the action closures rebuild again. The image
    // picker and style-stage cancellations remain byte-identical.
    await openGroupMenu(window, view, "plain", plainGroupMenu);
    await dismissMenu(window, view);
    const beforeBackgroundCancel = fs.readFileSync(canvasPath, "utf8");
    await view.getByRole("button", { name: "Set background", exact: true }).click();
    await expect(window.locator(".prompt-input")).toHaveAttribute("placeholder", "Search images…");
    expect(await window.locator(".prompt-result").allInnerTexts()).toEqual(expect.arrayContaining(["Old.png", "New.png"]));
    expect((await window.locator(".prompt-result").allInnerTexts()).some((item) => item.endsWith(".md"))).toBe(false);
    await window.keyboard.press("Escape");
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeBackgroundCancel);
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(1);
    expect(await selectedIds(view)).toEqual(["plain"]);
    expect(await camera(view)).toEqual(transformedCamera);

    await view.getByRole("button", { name: "Set background", exact: true }).click();
    await chooseImage(window, "New.png");
    await expect(window.locator(".context-menu-item")).toHaveText(["Cover", "Ratio", "Repeat"]);
    const styleMenuBox = await window.locator(".context-menu").boundingBox();
    expect(styleMenuBox).not.toBeNull();
    expect(Number.isFinite(styleMenuBox!.x) && Number.isFinite(styleMenuBox!.y)).toBe(true);
    await window.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeBackgroundCancel);
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(1);

    // A successful staged control action commits background and style once,
    // rerenders through managed blob URLs, and expands the same controls.
    const createdBefore = await window.evaluate(() => [...(window as any).__groupActionUrls.created] as string[]);
    await view.getByRole("button", { name: "Set background", exact: true }).click();
    await chooseImage(window, "New.png");
    await window.locator(".context-menu-item", { hasText: /^Ratio$/ }).click();
    const plain = view.locator('.canvas-node[data-node-id="plain"]');
    await expect(plain).toHaveCSS("background-size", "contain");
    await expect.poll(() => readCanvas(canvasPath)?.nodes[0]?.backgroundStyle ?? null).toBe("ratio");
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(2);
    expect(await controlNames(view)).toEqual(backgroundGroupControls);
    await expect.poll(async () => {
      const revoked = await window.evaluate(() => [...(window as any).__groupActionUrls.revoked] as string[]);
      return createdBefore.every((url) => revoked.includes(url));
    }).toBe(true);
    expect(await selectedIds(view)).toEqual(["plain"]);
    expect(await camera(view)).toEqual(transformedCamera);

    // Control-based style replacement retains selection and writes once;
    // Remove background deletes both optional fields in one further write and
    // collapses the conditional actions immediately.
    const beforeStyleCancel = fs.readFileSync(canvasPath, "utf8");
    await view.getByRole("button", { name: "Set background style", exact: true }).click();
    await window.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(beforeStyleCancel);
    await view.getByRole("button", { name: "Set background style", exact: true }).click();
    await window.locator(".context-menu-item", { hasText: /^Repeat$/ }).click();
    await expect(plain).toHaveCSS("background-repeat", "repeat");
    await expect.poll(() => readCanvas(canvasPath)?.nodes[0]?.backgroundStyle ?? null).toBe("repeat");
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(3);
    await view.getByRole("button", { name: "Remove background", exact: true }).click();
    await expect(plain).toHaveCSS("background-image", "none");
    await expect.poll(() => {
      const group = readCanvas(canvasPath)?.nodes[0];
      return group && !Object.hasOwn(group, "background") && !Object.hasOwn(group, "backgroundStyle");
    }).toBe(true);
    expect(await window.evaluate(() => (window as any).__groupActionWrites)).toBe(4);
    expect(await controlNames(view)).toEqual(plainGroupControls);
    expect(await selectedIds(view)).toEqual(["plain"]);
    expect(await camera(view)).toEqual(transformedCamera);

    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved).toEqual({
      ...initial,
      nodes: [{ ...initial.nodes[0], label: "Renamed plain" }, initial.nodes[1], initial.nodes[2]],
    });

    // Other node selection surfaces retain their exact non-group actions.
    await view.locator('.canvas-node[data-node-id="text"]').click({ position: { x: 30, y: 30 } });
    expect(await controlNames(view)).toEqual(["Set color", "Edit", "Convert to file…", "Remove"]);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Group actions.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="plain"] .canvas-group-label')).toHaveText("Renamed plain");
    await expect(view.locator('.canvas-node[data-node-id="plain"]')).toHaveCSS("background-image", "none");
    await expect(view.locator('.canvas-node[data-node-id="existing"]')).toHaveCSS("background-size", "cover");
    expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(saved);
    await expect(view.locator(".canvas-selection-controls")).toHaveCount(0);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
