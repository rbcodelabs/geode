import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
test("opens a static artifact in a contained, networkless ephemeral guest", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const artifactRoot = path.join(temp, "artifact");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultPath], lastVault: vaultPath,
  }));
  fs.writeFileSync(path.join(artifactRoot, "artifact.json"), JSON.stringify({
    schemaVersion: 1,
    id: "runtime-proof",
    title: "Runtime proof",
    entry: "index.html",
    runtime: "static",
    createdByThreadId: "thread-e2e",
    viewport: { preset: "custom", width: 720, height: 480 },
    permissions: { network: "none", clipboard: false },
  }));
  fs.writeFileSync(path.join(artifactRoot, "style.css"), "body { color: rgb(12, 34, 56); }");
  fs.writeFileSync(path.join(artifactRoot, "app.js"), `console.error("artifact runtime proof");`);
  fs.writeFileSync(path.join(artifactRoot, "index.html"), `<!doctype html>
    <link rel="stylesheet" href="style.css">
    <title>Untrusted runtime proof</title>
    <main id="result">ready</main>
    <script src="app.js"></script>`);

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate((root) => (window as any).app.openArtifact(root), artifactRoot);

    const view = window.locator(".artifact-view");
    const frame = view.locator(".artifact-view-frame");
    await expect(view).toBeVisible();
    await expect(frame).toHaveAttribute("partition", /^geode-artifact-[0-9a-f-]+$/);
    await expect(frame).toHaveAttribute("src", "geode-artifact://runtime-proof/index.html");
    await expect(frame).toHaveCSS("width", "720px");
    await expect(frame).toHaveCSS("height", "480px");
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title"))
      .toHaveText("Runtime proof");
    await expect.poll(() => frame.evaluate((guest) =>
      (guest as any).executeJavaScript(`({
        nodeType: typeof require,
        color: getComputedStyle(document.body).color,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null
      })`)
    )).toEqual({
      nodeType: "undefined",
      color: "rgb(12, 34, 56)",
      csp: null,
    });
    expect(await frame.evaluate((guest) => (guest as any).executeJavaScript(
      `String(window.open("https://example.com"))`
    ))).toBe("null");
    await expect.poll(() => frame.evaluate((guest) => (guest as any).executeJavaScript(
      `fetch("https://example.com/blocked").then(() => "allowed", () => "blocked")`
    ))).toBe("blocked");
    expect(await frame.evaluate((guest) => (guest as any).executeJavaScript(
      `Promise.resolve().then(() => navigator.clipboard.readText()).then(() => "allowed", () => "blocked")`
    ))).toBe("blocked");
    await frame.evaluate((guest) => (guest as any).executeJavaScript(`location.href = "https://example.com/escape"`));
    await expect.poll(() => frame.evaluate((guest) => (guest as any).getURL()))
      .toBe("geode-artifact://runtime-proof/index.html");

    fs.writeFileSync(path.join(artifactRoot, "style.css"), "body { color: rgb(78, 90, 12); }");
    await expect.poll(() => frame.evaluate((guest) => (guest as any).executeJavaScript(
      `getComputedStyle(document.body).color`
    ))).toBe("rgb(78, 90, 12)");
    await expect(view.locator(".artifact-view-status")).toContainText("Reloaded");

    await expect(view.locator(".artifact-view-diagnostics-btn")).toContainText(/Diagnostics [1-9]/);
    await view.locator(".artifact-view-diagnostics-btn").click();
    await expect(view.locator(".artifact-view-diagnostic.is-error", { hasText: "artifact runtime proof" }))
      .toBeVisible();

    await view.locator('[data-viewport="mobile"]').click();
    await expect(frame).toHaveCSS("width", "390px");
    await expect(frame).toHaveCSS("height", "844px");

    await view.getByRole("button", { name: "Capture artifact screenshot" }).click();
    await expect(view.locator(".artifact-view-status")).toContainText(/Captured \d+ × \d+/);
    await expect.poll(() => {
      const captures = path.join(artifactRoot, "captures");
      return fs.existsSync(captures) ? fs.readdirSync(captures).filter((file) => file.endsWith(".png")).length : 0;
    }).toBe(1);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("surfaces strict manifest failures without creating a guest", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-invalid-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const artifactRoot = path.join(temp, "artifact");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultPath], lastVault: vaultPath,
  }));
  fs.writeFileSync(path.join(artifactRoot, "artifact.json"), JSON.stringify({ schemaVersion: 1 }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate((root) => (window as any).app.openArtifact(root), artifactRoot);
    await expect(window.locator(".artifact-view-error")).toContainText("Artifact manifest is invalid");
    await expect(window.locator(".artifact-view-error")).toContainText("entry: Expected a string");
    await expect(window.locator(".artifact-view-error")).toContainText("permissions: Expected an object");
    await expect(window.locator(".artifact-view-frame")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("restores the artifact root and responsive viewport after relaunch", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-restore-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const artifactRoot = path.join(temp, "artifact");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultPath], lastVault: vaultPath,
  }));
  fs.writeFileSync(path.join(artifactRoot, "artifact.json"), JSON.stringify({
    schemaVersion: 1, id: "restore-proof", title: "Restore proof", entry: "index.html",
    runtime: "static", createdByThreadId: "thread-restore", viewport: { preset: "desktop", width: 1440, height: 900 },
    permissions: { network: "none", clipboard: false },
  }));
  fs.writeFileSync(path.join(artifactRoot, "index.html"), "<!doctype html><h1>restored</h1>");

  let app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    let window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate((root) => (window as any).app.openArtifact(root), artifactRoot);
    await window.locator('[data-viewport="mobile"]').click();
    await expect(window.locator(".artifact-view-frame")).toHaveCSS("width", "390px");
    await window.waitForTimeout(400);
    await app.close();

    app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    window = await app.firstWindow();
    const frame = window.locator(".artifact-view-frame");
    await expect(frame).toHaveAttribute("src", "geode-artifact://restore-proof/index.html");
    await expect(frame).toHaveCSS("width", "390px");
    await expect(frame).toHaveCSS("height", "844px");
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
