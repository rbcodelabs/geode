import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeVault() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-image-view-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-image-view-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Source.md"), "# Source\n\n[[Linked.svg]]\n");
  for (const name of ["Explorer.png", "Second.png", "Plugin.png"]) {
    fs.writeFileSync(path.join(vaultDir, name), onePixelPng);
  }
  fs.writeFileSync(
    path.join(vaultDir, "Linked.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="32" fill="#7c4dff"/><text x="320" y="195" fill="white" font-family="sans-serif" font-size="52" text-anchor="middle">Image view</text></svg>',
  );
  fs.writeFileSync(path.join(vaultDir, "Unsupported.bin"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  return { vaultDir, userDataDir };
}

test("vault images open as binary-backed image views through every built-in file route", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Explorer.png"]')).toBeVisible();

    await win.evaluate(() => {
      const app = (window as unknown as { app: any }).app;
      const reads: string[] = [];
      const binaryReads: string[] = [];
      const created: string[] = [];
      const revoked: string[] = [];
      const originalRead = app.vault.read.bind(app.vault);
      const originalReadBinary = app.vault.readBinary.bind(app.vault);
      const originalCreate = URL.createObjectURL.bind(URL);
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      app.vault.read = async (file: any) => {
        reads.push(file.path);
        return originalRead(file);
      };
      app.vault.readBinary = async (file: any) => {
        binaryReads.push(file.path);
        return originalReadBinary(file);
      };
      URL.createObjectURL = (blob: Blob) => {
        const url = originalCreate(blob);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        revoked.push(url);
        originalRevoke(url);
      };
      (window as any).__imageViewEvidence = { reads, binaryReads, created, revoked };
    });

    // File Explorer and the app-level opener both route images into the same
    // file-backed view, replacing its object URL when the file changes.
    await win.locator('.nav-file-title[data-path="Explorer.png"]').click();
    const active = win.locator(".workspace-leaf.mod-active");
    await expect(active.locator('.workspace-leaf-content[data-type="image"]')).toBeVisible();
    await expect(active.locator("img.image-view-image")).toHaveAttribute("src", /^blob:/);
    await expect(active.locator(".view-header-title")).toHaveText("Explorer");

    const sameView = await win.evaluate(async () => {
      const app = (window as unknown as { app: any }).app;
      const leaf = app.workspace.getActiveLeaf();
      const originalView = leaf.view;
      await app.openFile(app.vault.getFileByPath("Second.png"), false);
      return leaf.view === originalView;
    });
    expect(sameView).toBe(true);
    await expect(active.locator(".view-header-title")).toHaveText("Second");

    // A normal internal Markdown link reaches the same route.
    await win.evaluate(async () => {
      const app = (window as unknown as { app: any }).app;
      await app.openFile(app.vault.getFileByPath("Source.md"), false);
    });
    await win.locator('.cm-live-wikilink[data-href="Linked.svg"]').click();
    await expect(active.locator('.workspace-leaf-content[data-type="image"]')).toBeVisible();
    await expect(active.locator(".view-header-title")).toHaveText("Linked");
    if (screenshotDir) await win.screenshot({ path: path.join(screenshotDir, "image-file-view.png") });

    // The plugin-facing leaf API must use the extension-aware path too, and
    // `{active:false}` must preserve both active leaf and keyboard focus.
    const pluginOutcome = await win.evaluate(async () => {
      const app = (window as unknown as { app: any }).app;
      await app.openFile(app.vault.getFileByPath("Source.md"), false);
      const sourceLeaf = app.workspace.getActiveLeaf();
      const backgroundLeaf = app.workspace.getLeaf(true);
      app.workspace.setActiveLeaf(sourceLeaf, { focus: false });
      sourceLeaf.view.editor?.focus();
      const focusedBefore = document.activeElement;
      await backgroundLeaf.openFile(app.vault.getFileByPath("Plugin.png"), { active: false });
      const result = {
        viewType: backgroundLeaf.view.viewType,
        activePreserved: app.workspace.getActiveLeaf() === sourceLeaf,
        focusPreserved: document.activeElement === focusedBefore,
      };
      await backgroundLeaf.detach();
      return result;
    });
    expect(pluginOutcome).toEqual({ viewType: "image", activePreserved: true, focusPreserved: true });

    const evidence = await win.evaluate(() => (window as any).__imageViewEvidence);
    expect(evidence.binaryReads).toEqual([
      "Explorer.png",
      "Second.png",
      "Linked.svg",
      "Plugin.png",
    ]);
    expect(evidence.reads).not.toContain("Explorer.png");
    expect(evidence.reads).not.toContain("Second.png");
    expect(evidence.reads).not.toContain("Linked.svg");
    expect(evidence.reads).not.toContain("Plugin.png");
    expect(evidence.created).toHaveLength(4);
    expect(evidence.revoked).toEqual(expect.arrayContaining(evidence.created));

    // Unsupported extensions retain the existing notification behavior.
    await win.evaluate(async () => {
      const app = (window as unknown as { app: any }).app;
      await app.openFile(app.vault.getFileByPath("Unsupported.bin"), false);
    });
    await expect(win.locator(".notice", { hasText: "Cannot open .bin files yet" })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
