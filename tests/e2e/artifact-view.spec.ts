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
  fs.writeFileSync(path.join(artifactRoot, "index.html"), `<!doctype html>
    <link rel="stylesheet" href="style.css">
    <title>Untrusted runtime proof</title>
    <main id="result">ready</main>`);

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
