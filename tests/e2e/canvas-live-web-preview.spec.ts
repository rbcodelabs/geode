import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local preview server did not bind to TCP");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("renders live isolated web-page previews in valid Canvas link cards", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>Canvas preview fixture</title></head>
      <body data-loaded="yes"><h1>Live Canvas preview</h1><script>document.body.dataset.scriptRan = "yes";</script></body></html>`);
  });
  const port = await listen(server);
  const canonical = `http://127.0.0.1:${port}/preview?source=canvas`;
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-live-web-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-live-web-user-"));
  const canvasPath = path.join(vaultDir, "Live web.canvas");
  const document = {
    vendorCanvas: { keep: true },
    nodes: [
      { id: "invalid", type: "link", x: 440, y: 0, width: 360, height: 180, url: "javascript:alert(1)", vendorInvalid: true },
      { id: "valid", type: "link", x: 0, y: 0, width: 360, height: 180, url: canonical, color: "3", vendorValid: { keep: true } },
    ],
    edges: [],
  };
  const originalText = JSON.stringify(document, null, 2) + "\n";
  fs.writeFileSync(canvasPath, originalText);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await window.locator('.nav-file-title[data-path="Live web.canvas"]').click();
    const view = window.locator(".canvas-view");
    const valid = view.locator('.canvas-node[data-node-id="valid"]');
    const invalid = view.locator('.canvas-node[data-node-id="invalid"]');
    const preview = valid.locator("webview.canvas-node-web-preview");

    await expect(preview).toHaveCount(1);
    await expect(invalid.locator("webview")).toHaveCount(0);
    await expect(preview).toHaveAttribute("partition", "persist:webviewer");
    await expect(preview).toHaveAttribute("src", canonical);
    await expect(preview).not.toHaveAttribute("nodeintegration", /.*/);
    await expect(preview).not.toHaveAttribute("preload", /.*/);
    await expect(preview).not.toHaveAttribute("allowpopups", /.*/);
    await expect(valid.getByRole("button", { name: canonical, exact: true })).toHaveCount(1);
    await expect(invalid.getByRole("button", { name: "Invalid web address", exact: true })).toBeDisabled();

    await expect.poll(() => preview.evaluate((guest) =>
      (guest as unknown as { executeJavaScript(script: string): Promise<unknown> }).executeJavaScript(`({
        title: document.title,
        heading: document.querySelector('h1')?.textContent,
        loaded: document.body.dataset.loaded,
        scriptRan: document.body.dataset.scriptRan
      })`)
    )).toEqual({
      title: "Canvas preview fixture",
      heading: "Live Canvas preview",
      loaded: "yes",
      scriptRan: "yes",
    });
    expect(await preview.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

    const bytesBefore = fs.readFileSync(canvasPath, "utf8");
    const cameraBefore = {
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    };
    await valid.click({ position: { x: 16, y: 16 } });
    await expect(valid).toHaveClass(/is-selected/);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(bytesBefore);

    await window.evaluate(() => {
      const current = window as any;
      current.__canvasWebViewerOpens = [];
      current.__canvasExternalOpens = [];
      current.app.settings.webViewer.openLinksInApp = true;
      current.app.openWebViewer = (url?: string) => {
        current.__canvasWebViewerOpens.push(url ?? "");
        return Promise.resolve();
      };
      current.geode.openExternal = (url: string) => {
        current.__canvasExternalOpens.push(url);
        return Promise.resolve();
      };
    });
    const label = valid.getByRole("button", { name: canonical, exact: true });
    await label.click();
    await label.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    expect(await window.evaluate(() => (window as any).__canvasWebViewerOpens)).toEqual([canonical]);
    expect(await window.evaluate(() => (window as any).__canvasExternalOpens)).toEqual([canonical]);

    await valid.click({ button: "right", position: { x: 16, y: 16 } });
    await window.locator(".context-menu-item", { hasText: /^Open in browser$/ }).click();
    expect(await window.evaluate(() => (window as any).__canvasExternalOpens)).toEqual([canonical, canonical]);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(bytesBefore);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(cameraBefore);
    await expect(valid).toHaveClass(/is-selected/);

    // External same-document formatting changes force full Canvas rerenders.
    // Selection/camera survive and each render owns exactly one connected guest.
    await window.evaluate(async ({ text }) => {
      const current = window as any;
      const file = current.app.vault.getFileByPath("Live web.canvas");
      await current.app.vault.modify(file, `${text}\n`);
    }, { text: originalText });
    await expect(valid.locator("webview.canvas-node-web-preview")).toHaveCount(1);
    await expect(valid).toHaveClass(/is-selected/);
    expect({
      scale: await view.getAttribute("data-scale"),
      panX: await view.getAttribute("data-pan-x"),
      panY: await view.getAttribute("data-pan-y"),
    }).toEqual(cameraBefore);
    await window.evaluate(async ({ text }) => {
      const current = window as any;
      const file = current.app.vault.getFileByPath("Live web.canvas");
      await current.app.vault.modify(file, text);
    }, { text: originalText });
    await expect(valid.locator("webview.canvas-node-web-preview")).toHaveCount(1);
    await expect(invalid.locator("webview")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(originalText);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Live web.canvas"]').click();
    const reloadedView = window.locator(".canvas-view");
    await expect(reloadedView.locator('.canvas-node[data-node-id="valid"] webview.canvas-node-web-preview')).toHaveCount(1);
    await expect(reloadedView.locator('.canvas-node[data-node-id="invalid"] webview')).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(originalText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await close(server);
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
