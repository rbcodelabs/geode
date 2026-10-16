import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";

import { CanvasBackgroundLifetimes } from "./helpers/canvas-background-lifetimes";

const repoRoot = path.resolve(__dirname, "..", "..");

async function expectBackground(
  scope: Locator,
  id: string,
  expected: { size: string; position: string; repeat: string },
): Promise<void> {
  const node = scope.locator(`.canvas-node[data-node-id="${id}"]`);
  await expect(node).toHaveCSS("background-image", /^url\("blob:/);
  await expect(node).toHaveCSS("background-size", expected.size);
  await expect(node).toHaveCSS("background-position", expected.position);
  await expect(node).toHaveCSS("background-repeat", expected.repeat);
}

test("renders documented group image backgrounds with safe Canvas-owned blob lifecycle", async ({}, info) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-background-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-group-background-user-"));
  const canvasPath = path.join(vaultDir, "Backgrounds.canvas");
  const initial = {
    vendorCanvas: { preserve: true },
    nodes: [
      { id: "cover", type: "group", x: 0, y: 0, width: 240, height: 160, label: "Cover", color: "1", background: "pixel.png", backgroundStyle: "cover", vendorCover: [1] },
      { id: "ratio", type: "group", x: 280, y: 0, width: 240, height: 160, label: "Ratio", color: "2", background: "pixel.png", backgroundStyle: "ratio", vendorRatio: { keep: true } },
      { id: "repeat", type: "group", x: 560, y: 0, width: 240, height: 160, label: "Repeat", color: "3", background: "pixel.png", backgroundStyle: "repeat", vendorRepeat: "keep" },
      { id: "missing", type: "group", x: 0, y: 220, width: 240, height: 160, label: "Missing", background: "missing.png", backgroundStyle: "cover" },
      { id: "not-image", type: "group", x: 280, y: 220, width: 240, height: 160, label: "Not image", background: "Note.md", backgroundStyle: "repeat" },
    ],
    edges: [],
  };
  const diskBefore = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(canvasPath, diskBefore);
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Not an image\n");
  fs.writeFileSync(path.join(vaultDir, "Host.md"), "# Host\n\n![[Backgrounds.canvas]]\n");
  fs.writeFileSync(
    path.join(vaultDir, "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const resources = new CanvasBackgroundLifetimes(window, "__canvasGroupBackgroundUrls", info);
    const errors: string[] = [];
    window.on("console", (message) => {
      if (message.type() === "error" && !resources.isExpectedProbeError(message.text(), message.location().url)) errors.push(message.text());
    });
    window.on("pageerror", (error) => errors.push(String(error)));
    await expect(window.locator('.nav-file-title[data-path="Backgrounds.canvas"]')).toBeVisible();
    await resources.install();
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      (window as any).__canvasGroupBackgroundWrites = 0;
      vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Backgrounds.canvas") (window as any).__canvasGroupBackgroundWrites += 1;
        return modify(file, data);
      };
    });

    await window.locator('.nav-file-title[data-path="Backgrounds.canvas"]').click();
    let view = window.locator(".canvas-view");
    const initialCamera = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    await expectBackground(view, "cover", { size: "cover", position: "50% 50%", repeat: "no-repeat" });
    await expectBackground(view, "ratio", { size: "contain", position: "50% 50%", repeat: "no-repeat" });
    await expectBackground(view, "repeat", { size: "auto", position: "0% 0%", repeat: "repeat" });
    await expect(view.locator('.canvas-node[data-node-id="missing"]')).toHaveCSS("background-image", "none");
    await expect(view.locator('.canvas-node[data-node-id="not-image"]')).toHaveCSS("background-image", "none");
    await expect(view.locator('.canvas-node[data-node-id="cover"] .canvas-group-label')).toHaveText("Cover");
    await expect(view.locator('.canvas-node[data-node-id="cover"]')).toHaveAttribute("data-canvas-color", "1");
    await expect(view.locator(".canvas-node.is-selected")).toHaveCount(0);
    await expect.poll(async () => (await resources.tracker()).created.length).toBe(3);
    const direct = await Promise.all(["cover", "ratio", "repeat"].map((id) => resources.capture(view, id)));
    await resources.expectLiveExactly(direct);

    // An unrelated transient card must retain the connected group presentations
    // and their still-decodable browser resources without a vault write.
    await view.getByRole("button", { name: "Add text card" }).click();
    await view.locator(".canvas-node-text-editor").press("Escape");
    for (const [index, id] of ["cover", "ratio", "repeat"].entries()) {
      await resources.expectRetained(view, id, direct[index]);
    }
    await expectBackground(view, "cover", { size: "cover", position: "50% 50%", repeat: "no-repeat" });
    expect((await resources.tracker()).created.sort()).toEqual(direct.map(({ url }) => url).sort());
    await resources.expectLiveExactly(direct);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(initialCamera);

    // Closing the direct Canvas view revokes all of its currently active URLs.
    // The same Canvas rendered as a Markdown embed retains the background
    // behavior through the shared CanvasView lifecycle.
    await window.locator('.nav-file-title[data-path="Host.md"]').click();
    await resources.expectRetired(direct);
    const embedded = window.locator(".cm-embed-widget.canvas-embed-widget .canvas-embed-view");
    await expectBackground(embedded, "cover", { size: "cover", position: "50% 50%", repeat: "no-repeat" });
    await expectBackground(embedded, "ratio", { size: "contain", position: "50% 50%", repeat: "no-repeat" });
    await expectBackground(embedded, "repeat", { size: "auto", position: "0% 0%", repeat: "repeat" });
    const embeddedBackgrounds = await Promise.all(["cover", "ratio", "repeat"].map((id) => resources.capture(embedded, id)));
    await resources.expectLiveExactly(embeddedBackgrounds);
    await window.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    await expect(embedded).toHaveCount(0);
    await resources.expectRetired(embeddedBackgrounds);
    await resources.expectAllRetired();

    expect(fs.readFileSync(canvasPath, "utf8")).toBe(diskBefore);
    expect(await window.evaluate(() => (window as any).__canvasGroupBackgroundWrites)).toBe(0);
    expect(await window.locator(".canvas-node.is-selected").count()).toBe(0);
    expect(initial.nodes.map((node) => node.id)).toEqual(JSON.parse(fs.readFileSync(canvasPath, "utf8")).nodes.map((node: { id: string }) => node.id));
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
