import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function readCanvas(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

test("creates normalized persistent web cards and routes activation without renderer navigation", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-web-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-web-user-"));
  const canvasPath = path.join(vaultDir, "Web.canvas");
  fs.writeFileSync(canvasPath, JSON.stringify({
    vendorCanvas: { keep: true },
    nodes: [{
      id: "link-1",
      type: "link",
      x: 0,
      y: 0,
      width: 360,
      height: 180,
      url: "https://existing.test/",
      vendorNode: "keep",
    }],
    edges: [],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    await window.locator('.nav-file-title[data-path="Web.canvas"]').click();
    const view = window.locator(".canvas-view");
    const surface = view.locator(".canvas-surface");
    const addWebPage = view.getByRole("button", { name: "Add web page" });
    await expect(addWebPage).toHaveCount(1);

    const initialOnDisk = fs.readFileSync(canvasPath, "utf8");
    await addWebPage.click();
    await window.locator(".prompt-input").fill("javascript:alert(1)");
    await window.locator(".prompt-input").press("Enter");
    await expect(window.locator(".notice", { hasText: "valid http:// or https:// URL" }).last()).toBeVisible();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialOnDisk);
    await expect(view.locator(".canvas-node")).toHaveCount(1);

    await addWebPage.click();
    await window.locator(".prompt-input").press("Enter");
    await expect(window.locator(".notice", { hasText: "valid http:// or https:// URL" }).last()).toBeVisible();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(initialOnDisk);

    // Pan and zoom before submission so placement proves current viewport
    // center conversion rather than fixed canvas coordinates.
    const surfaceBox = (await surface.boundingBox())!;
    await surface.hover();
    await window.keyboard.down("ControlOrMeta");
    await window.mouse.wheel(0, -280);
    await window.keyboard.up("ControlOrMeta");
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 50, surfaceBox.y + surfaceBox.height - 80);
    await window.mouse.down({ button: "middle" });
    await window.mouse.move(surfaceBox.x + surfaceBox.width - 100, surfaceBox.y + surfaceBox.height - 105);
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

    const canonicalUrl = "https://example.com/path?q=hello%20world#frag";
    await addWebPage.click();
    await window.locator(".prompt-input").fill("  HTTPS://Example.COM:443/a/../path?q=hello%20world#frag  ");
    await window.locator(".prompt-input").press("Enter");

    const linkNode = view.locator('.canvas-node[data-node-id="link-2"]');
    const linkAction = linkNode.getByRole("button", { name: canonicalUrl });
    await expect(linkNode).toHaveClass(/is-selected/);
    await expect(linkNode.locator(".canvas-node-web-host")).toHaveText("example.com");
    await expect(linkNode.locator(".canvas-node-web-url")).toHaveText(canonicalUrl);
    await expect(linkNode.locator("webview.canvas-node-web-preview")).toHaveCount(1);
    const position = await linkNode.evaluate((element) => ({
      x: Number.parseFloat((element as HTMLElement).style.left),
      y: Number.parseFloat((element as HTMLElement).style.top),
      width: Number.parseFloat((element as HTMLElement).style.width),
      height: Number.parseFloat((element as HTMLElement).style.height),
    }));
    expect(position.width).toBe(360);
    expect(position.height).toBe(180);
    expect(position.x + position.width / 2).toBeCloseTo(expectedCenter.x, 3);
    expect(position.y + position.height / 2).toBeCloseTo(expectedCenter.y, 3);

    await expect.poll(() => readCanvas(canvasPath)?.nodes.length ?? null).toBe(2);
    const saved = JSON.parse(fs.readFileSync(canvasPath, "utf8"));
    expect(saved.vendorCanvas).toEqual({ keep: true });
    expect(saved.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["link-1", "link-2"]);
    expect(saved.nodes.find((node: { id: string }) => node.id === "link-1").vendorNode).toBe("keep");
    expect(saved.nodes.find((node: { id: string }) => node.id === "link-2").url).toBe(canonicalUrl);

    const initialRendererUrl = await window.evaluate(() => location.href);
    await window.evaluate(() => {
      const w = window as any;
      w.__canvasWebViewerOpens = [];
      w.__canvasExternalOpens = [];
      w.app.settings.webViewer.openLinksInApp = true;
      w.app.openWebViewer = (url?: string) => {
        w.__canvasWebViewerOpens.push(url ?? "");
        return Promise.resolve();
      };
      w.geode.openExternal = (url: string) => {
        w.__canvasExternalOpens.push(url);
        return Promise.resolve();
      };
    });

    // Pointer activation must not begin node dragging.
    const positionBeforePointerMove = await linkNode.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));
    const actionBox = (await linkAction.boundingBox())!;
    await window.mouse.move(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(actionBox.x + actionBox.width / 2 + 50, actionBox.y + actionBox.height / 2 + 30);
    await window.mouse.up();
    expect(await linkNode.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }))).toEqual(positionBeforePointerMove);
    await window.evaluate(() => {
      (window as any).__canvasWebViewerOpens = [];
      (window as any).__canvasExternalOpens = [];
    });

    await linkAction.click();
    await linkAction.focus();
    await linkAction.press("Enter");
    expect(await window.evaluate(() => (window as any).__canvasWebViewerOpens)).toEqual([canonicalUrl, canonicalUrl]);
    expect(await window.evaluate(() => (window as any).__canvasExternalOpens)).toEqual([]);

    await linkAction.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    expect(await window.evaluate(() => (window as any).__canvasExternalOpens)).toEqual([canonicalUrl]);
    expect(await window.evaluate(() => (window as any).__canvasWebViewerOpens)).toEqual([canonicalUrl, canonicalUrl]);
    expect(await window.evaluate(() => location.href)).toBe(initialRendererUrl);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Web.canvas"]').click();
    await expect(window.locator('.canvas-node[data-node-id="link-2"] .canvas-node-web-host')).toHaveText("example.com");
    await expect(window.locator('.canvas-node[data-node-id="link-2"] .canvas-node-web-url')).toHaveText(canonicalUrl);
    await expect(window.locator(".canvas-view").getByRole("button", { name: "Add web page" })).toHaveCount(1);

    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
