import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

interface FakeServer { port: number; hits: string[]; close(): Promise<void> }

/** Stands in for `next dev`: a plain node:http server on 127.0.0.1. */
async function listen(body: (port: number) => string, redirectTo?: () => string): Promise<FakeServer> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (redirectTo && req.url?.startsWith("/redir")) { res.writeHead(302, { location: redirectTo() }); res.end(); return; }
    // A CSP from the dev server must be replaced by Geode's, not trusted.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src *" });
    res.end(body((server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function setup(prefix: string, manifest: Record<string, unknown>) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const userDataDir = path.join(temp, "user-data");
  const artifactRoot = path.join(temp, "artifact");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(path.join(artifactRoot, "app"), { recursive: true });
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  fs.writeFileSync(path.join(artifactRoot, "app", "page.tsx"), "export default function Page() { return null; }\n");
  fs.writeFileSync(path.join(artifactRoot, "artifact.json"), JSON.stringify({
    schemaVersion: 2, id: "next-proof", title: "Next proof", entry: "app/page.tsx", runtime: "nextjs",
    createdByThreadId: "thread-e2e", viewport: { preset: "custom", width: 720, height: 480 },
    permissions: { network: "loopback", clipboard: false },
    ...manifest,
  }));
  return { temp, userDataDir, artifactRoot };
}

test("nextjs artifact loads from one loopback origin and nothing else", async () => {
  const other = await listen(() => "<h1>other</h1>");
  const dev = await listen(() => `<!doctype html><title>Dev proof</title><main id="r" style="background:#123456;color:#fff;height:100vh">ready</main>`,
    () => `http://127.0.0.1:${other.port}/from-redirect`);
  const { temp, userDataDir, artifactRoot } = setup("geode-artifact-next-e2e-", {});
  const url = `http://127.0.0.1:${dev.port}`;

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    await window.evaluate(([root, devUrl]) => (window as any).app.openArtifact(root, { url: devUrl }), [artifactRoot, url]);

    const view = window.locator(".artifact-view");
    const frame = view.locator(".artifact-view-frame");
    await expect(frame).toHaveAttribute("partition", /^geode-artifact-[0-9a-f-]+$/);
    await expect(frame).toHaveAttribute("src", `${url}/`);
    // No vault bridge / guest preload on an http origin.
    await expect(view.locator(".artifact-view-vault-badge")).toBeHidden();
    const exec = (code: string) => frame.evaluate((guest, c) => (guest as any).executeJavaScript(c), code);
    // With a user gesture, so Chromium's popup blocker does not pre-empt Geode's own handler.
    const execGesture = (code: string) => frame.evaluate((guest, c) => (guest as any).executeJavaScript(c, true), code);

    await expect.poll(() => exec(`document.title`)).toBe("Dev proof");
    expect(await exec(`typeof require`)).toBe("undefined");
    expect(await exec(`typeof window.geodeArtifact + "," + typeof window.geode`)).toBe("undefined,undefined");
    // Geode's CSP replaced the one the server sent.
    expect(await exec(`fetch(location.href).then(r => r.headers.get("content-security-policy"))`))
      .toContain("default-src 'self'");

    expect(await exec(`fetch(location.href).then(() => "allowed", () => "blocked")`)).toBe("allowed");
    expect(await exec(`fetch("http://127.0.0.1:${other.port}/x").then(() => "allowed", () => "blocked")`)).toBe("blocked");
    expect(await exec(`fetch("https://example.com/x").then(() => "allowed", () => "blocked")`)).toBe("blocked");
    expect(await exec(`new Promise((resolve) => { const ws = new WebSocket("ws://127.0.0.1:${other.port}/"); ws.onopen = () => resolve("allowed"); ws.onerror = () => resolve("blocked"); })`)).toBe("blocked");
    // Popup denial is enforced in two layers (the artifact <webview> has no allowpopups, and
    // main's window-open handler denies nextjs guests). A mutation run that removed only the
    // handler line stayed green, so this pins the combined behaviour, not the single line:
    // no popup request ever reaches the renderer and nothing reaches another origin.
    await window.evaluate(() => { (window as any).__popupRequests = []; (window as any).geode.onGuestWindowOpen((r: { url: string }) => (window as any).__popupRequests.push(r.url)); });
    expect(await execGesture(`String(window.open("https://example.com"))`)).toBe("null");
    await execGesture(`window.open("http://127.0.0.1:${other.port}/popup")`);
    await execGesture(`(() => { const a = document.createElement("a"); a.href = "http://127.0.0.1:${other.port}/anchor"; a.target = "_blank"; document.body.append(a); a.click(); })()`);
    // A server-issued 302 to another origin is blocked for both fetch and navigation.
    expect(await exec(`fetch("/redir").then(() => "allowed", () => "blocked")`)).toBe("blocked");
    await exec(`location.href = "/redir-nav"`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await window.evaluate(() => (window as any).__popupRequests)).toEqual([]);

    await exec(`location.href = "http://127.0.0.1:${other.port}/escape"`);
    await exec(`location.href = "https://example.com/escape"`);
    await expect.poll(() => frame.evaluate((guest) => (guest as any).getURL())).toBe(`${url}/`);
    expect(other.hits).toEqual([]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // Capture of the live guest.
    await view.getByRole("button", { name: "Capture artifact screenshot" }).click();
    await expect(view.locator(".artifact-view-status")).toContainText(/Captured \d+ × \d+/);
    const captures = path.join(artifactRoot, "captures");
    await expect.poll(() => (fs.existsSync(captures) ? fs.readdirSync(captures).length : 0)).toBe(1);
  } finally {
    await app.close().catch(() => {});
    await Promise.all([dev.close(), other.close()]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("captures a nextjs dev server with no open view via a hidden host window", async () => {
  const other = await listen(() => "<h1>other</h1>");
  // The page tries to reach another loopback port: the capture session must enforce the same origin filter.
  const dev = await listen(() => `<!doctype html><body style="margin:0;background:#c0392b"><h1>hidden capture</h1><script>
    fetch("http://127.0.0.1:${other.port}/f").catch(() => {});
    try { new WebSocket("ws://127.0.0.1:${other.port}/w"); } catch {}
  </script>`);
  const { temp, userDataDir, artifactRoot } = setup("geode-artifact-next-capture-e2e-", {});
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const result = await window.evaluate(([root, url]) => (window as any).geode.captureArtifact(root, { url }),
      [artifactRoot, `http://127.0.0.1:${dev.port}`]);
    expect(result.width).toBeGreaterThan(0);
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
    expect(dev.hits.length).toBeGreaterThan(0);
    // The image must actually contain the page: viewport aspect ratio and the page's colour
    // at the centre and bottom row (catches an empty image and a clipped content area).
    const px = await app.evaluate(({ nativeImage }, file) => {
      const img = nativeImage.createFromPath(file);
      const { width, height } = img.getSize();
      const bmp = img.toBitmap(); // BGRA
      const at = (x: number, y: number) => { const i = (y * width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
      return { width, height, center: at(width >> 1, height >> 1), bottom: at(width >> 1, height - 2) };
    }, result.path);
    expect(px.width % 720).toBe(0);
    expect(px.height / px.width).toBeCloseTo(480 / 720, 2);
    expect(px.center).toEqual([0xc0, 0x39, 0x2b]);
    expect(px.bottom).toEqual([0xc0, 0x39, 0x2b]);
    expect(other.hits).toEqual([]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCount);

    // A hostile URL is rejected by main before anything loads.
    const rejected = await window.evaluate(([root]) => (window as any).geode.captureArtifact(root, { url: "http://localhost:3000" })
      .then(() => "ok", (error: Error) => error.message), [artifactRoot]);
    expect(rejected).toContain("127.0.0.1");
    expect(other.hits).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await Promise.all([dev.close(), other.close()]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("main rejects dev server URLs that do not match the manifest runtime", async () => {
  const { temp, userDataDir, artifactRoot } = setup("geode-artifact-next-reject-e2e-", {});
  const staticRoot = path.join(temp, "static");
  fs.mkdirSync(staticRoot);
  fs.writeFileSync(path.join(staticRoot, "index.html"), "<h1>static</h1>");
  fs.writeFileSync(path.join(staticRoot, "artifact.json"), JSON.stringify({
    schemaVersion: 2, id: "static-v2", title: "Static v2", entry: "index.html", runtime: "static",
    createdByThreadId: "thread-e2e", viewport: { preset: "desktop", width: 1440, height: 900 },
    permissions: { network: "none", clipboard: false },
  }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const register = (root: string, devServerUrl?: string) =>
      window.evaluate(([r, u]) => (window as any).geode.registerArtifact(r, u ? { devServerUrl: u } : undefined), [root, devServerUrl]);

    expect((await register(artifactRoot)).error.code).toBe("dev_server_invalid");
    expect((await register(artifactRoot, "http://localhost:3000")).error.code).toBe("dev_server_invalid");
    expect((await register(artifactRoot, "http://127.0.0.1:80")).error.code).toBe("dev_server_invalid");
    expect((await register(staticRoot, "http://127.0.0.1:3000")).error.code).toBe("dev_server_invalid");
    const ok = await register(staticRoot);
    expect(ok.ok).toBe(true);
    expect(ok.registration.entryUrl).toBe("geode-artifact://static-v2/index.html");
    await window.evaluate((id) => (window as any).geode.unregisterArtifact(id), ok.registration.registrationId);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
