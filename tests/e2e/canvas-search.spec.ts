import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("searches semantic Canvas content and opens the selected Canvas result", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-search-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-search-user-"));
  fs.mkdirSync(path.join(vaultDir, "Boards"));
  fs.mkdirSync(path.join(vaultDir, "Notes"));
  fs.writeFileSync(path.join(vaultDir, "Notes", "Plan.md"), "# Goal\n");
  fs.writeFileSync(path.join(vaultDir, "Boards", "Research.canvas"), JSON.stringify({
    vendorDocument: "raw-only secret",
    nodes: [
      { id: "text", type: "text", x: 0, y: 0, width: 220, height: 120, text: "Semantic needle" },
      { id: "file", type: "file", x: 300, y: 0, width: 220, height: 120, file: "Notes/Plan.md", subpath: "#Goal" },
      { id: "link", type: "link", x: 0, y: 180, width: 240, height: 120, url: "https://example.com/research" },
      { id: "group", type: "group", x: -30, y: -30, width: 600, height: 400, label: "Planning group" },
    ],
    edges: [{ id: "edge", fromNode: "text", toNode: "file", label: "supports milestone" }],
  }, null, 2));
  fs.writeFileSync(path.join(vaultDir, "Boards", "Malformed.canvas"), '{"nodes":[{"text":"Semantic needle"}]');
  fs.writeFileSync(path.join(vaultDir, "Markdown.md"), "Markdown behavior remains searchable.\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await expect(window.locator('.nav-folder-title[data-path="Boards"]')).toBeVisible();

    await window.evaluate(() => (window as any).app.openSearch("semantic needle"));
    const search = window.locator(".search-view");
    await expect(search).toBeVisible();
    await expect(search.locator(".search-result")).toHaveCount(1);
    await expect(search.locator(".search-result-file")).toContainText("Research");
    await expect(search.locator(".search-result-snippet").first()).toContainText("Semantic needle");
    await search.locator(".search-result-file").click();
    await expect(window.locator(".canvas-view .view-header-title")).toHaveText("Research");
    await expect(window.locator('.canvas-node[data-node-id="text"]')).toBeVisible();

    // Filename/path operators find Canvas files without requiring semantic
    // content, malformed JSON never produces a content hit, and Markdown
    // remains on the existing search path.
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const cachedRead = vault.cachedRead.bind(vault);
      (window as any).__canvasSearchReads = 0;
      vault.cachedRead = async (file: { extension: string }) => {
        if (file.extension === "canvas") (window as any).__canvasSearchReads += 1;
        return cachedRead(file);
      };
    });
    await window.evaluate(() => (window as any).app.openSearch("file:research.canvas path:boards/"));
    await expect(search.locator(".search-result-file")).toHaveText("Research");
    expect(await window.evaluate(() => (window as any).__canvasSearchReads)).toBe(0);
    await window.evaluate(() => (window as any).app.openSearch("raw-only secret"));
    await expect(search.locator(".search-result")).toHaveCount(0);
    await window.evaluate(() => (window as any).app.openSearch("tag:fabricated"));
    await expect(search.locator(".search-result")).toHaveCount(0);
    await window.evaluate(() => (window as any).app.openSearch("markdown behavior"));
    await expect(search.locator(".search-result-file")).toHaveText("Markdown");
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
