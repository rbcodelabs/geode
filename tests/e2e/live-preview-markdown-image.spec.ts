import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const NOTE = `# Standard images

Relative: ![Relative alt](Images/photo%20one.png "Relative title")

Root: ![Root alt](Assets/root.png)

Angle: ![Angle alt](<Images/photo one.png> "Angle title")

No wiki sizing: ![Alt|40](Assets/root.png)

Missing: ![Missing alt](Images/missing.png)

Unsafe: ![Remote alt](https://example.com/remote.png)

Broken: ![Broken alt](Images/broken.png)

Wiki: ![[Assets/root.png|24]]
`;

test("renders standard Markdown vault images safely in Live Preview", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-image-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-image-ud-"));
  fs.mkdirSync(path.join(vaultDir, "Notes", "Images"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Assets"), { recursive: true });
  const imageBytes = fs.readFileSync(path.join(repoRoot, "test-vault", "geode-logo.png"));
  fs.writeFileSync(path.join(vaultDir, "Notes", "Images", "photo one.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "Notes", "Images", "broken.png"), "not an image");
  fs.writeFileSync(path.join(vaultDir, "Assets", "root.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "Notes", "Images.md"), NOTE);
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  try {
    const window = await app.firstWindow();
    await window.locator('.nav-folder-title[data-path="Notes"]').click();
    await window.locator('.nav-file-title[data-path="Notes/Images.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    const standardImages = window.locator(".cm-markdown-image-widget img.internal-embed");
    await expect(standardImages).toHaveCount(4);
    await expect(standardImages.nth(0)).toHaveAttribute("alt", "Relative alt");
    await expect(standardImages.nth(0)).toHaveAttribute("title", "Relative title");
    await expect(standardImages.nth(0)).toHaveAttribute("src", /^blob:/);
    await expect(standardImages.nth(1)).toHaveAttribute("alt", "Root alt");
    await expect(standardImages.nth(2)).toHaveAttribute("alt", "Angle alt");
    await expect(standardImages.nth(2)).toHaveAttribute("title", "Angle title");
    await expect(standardImages.nth(3)).toHaveAttribute("alt", "Alt|40");
    await expect(standardImages.nth(3)).not.toHaveAttribute("width", /.+/);
    await expect(standardImages.nth(3)).not.toHaveAttribute("height", /.+/);

    const fallbacks = window.locator(".cm-markdown-image-widget.is-unresolved");
    await expect(fallbacks).toHaveCount(3);
    await expect(fallbacks.nth(0)).toContainText("Missing alt");
    await expect(fallbacks.nth(1)).toContainText("Remote alt");
    await expect(fallbacks.nth(2)).toContainText("Broken alt");
    expect(await window.locator(".cm-editor").innerText()).not.toContain(
      "https://example.com/remote.png"
    );

    // The existing wiki embed keeps its explicit Obsidian width semantics.
    const wikiImage = window.locator(
      ".cm-embed-widget:not(.cm-markdown-image-widget) img.internal-embed"
    );
    await expect(wikiImage).toHaveAttribute("width", "24");

    // Moving onto an image line reveals its authored source; moving away
    // restores the widget, matching Live Preview's cursor-line contract.
    const content = window.locator(".cm-content");
    await content.press("ArrowDown");
    await content.press("ArrowDown");
    await expect(standardImages).toHaveCount(3);
    await expect(window.locator(".cm-editor")).toContainText(
      '![Relative alt](Images/photo%20one.png "Relative title")'
    );
    await content.press("ArrowUp");
    await content.press("ArrowUp");
    await expect(standardImages).toHaveCount(4);

    // Reading View remains on its existing renderer path: standard Markdown
    // syntax is handled by marked, while the wiki embed keeps its own sizing.
    const readingToggle = window.locator('[title="Toggle reading view (Cmd/Ctrl+E)"]');
    await readingToggle.click();
    const readingView = window.locator(".markdown-reading-view");
    await expect(readingView).toBeVisible();
    await expect(readingView.locator('img[alt="Relative alt"]')).toHaveAttribute(
      "title",
      "Relative title"
    );
    await expect(readingView.locator("img.internal-embed")).toHaveAttribute("width", "24");
    await readingToggle.click();
    await expect(standardImages).toHaveCount(4);

    // Replacing the Live Preview extension destroys widgets and revokes all
    // created object URLs rather than leaking them until renderer shutdown.
    await window.evaluate(() => {
      const original = URL.revokeObjectURL.bind(URL);
      (window as unknown as { revokedBlobUrls: string[] }).revokedBlobUrls = [];
      URL.revokeObjectURL = (url: string) => {
        (window as unknown as { revokedBlobUrls: string[] }).revokedBlobUrls.push(url);
        original(url);
      };
    });
    await window.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    await expect
      .poll(() =>
        window.evaluate(
          () => (window as unknown as { revokedBlobUrls: string[] }).revokedBlobUrls.length
        )
      )
      .toBeGreaterThanOrEqual(4);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("revokes a standard Markdown image URL that resolves after its widget is destroyed", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-image-late-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-image-late-ud-"));
  fs.writeFileSync(
    path.join(vaultDir, "image.png"),
    fs.readFileSync(path.join(repoRoot, "test-vault", "geode-logo.png"))
  );
  fs.writeFileSync(path.join(vaultDir, "Late.md"), "# Late image\n\n![Late alt](image.png)\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate(() => {
      const host = window as unknown as {
        app: { vault: { readBinary: (file: unknown) => Promise<ArrayBuffer> } };
        markdownImageReadStarted: Promise<void>;
        releaseMarkdownImageRead: () => void;
        revokedBlobUrls: string[];
      };
      const originalRead = host.app.vault.readBinary.bind(host.app.vault);
      let markStarted!: () => void;
      let release!: () => void;
      host.markdownImageReadStarted = new Promise<void>((resolve) => (markStarted = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      host.releaseMarkdownImageRead = release;
      host.app.vault.readBinary = async (file: unknown) => {
        markStarted();
        await gate;
        return originalRead(file);
      };
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      host.revokedBlobUrls = [];
      URL.revokeObjectURL = (url: string) => {
        host.revokedBlobUrls.push(url);
        originalRevoke(url);
      };
    });

    await window.locator('.nav-file-title[data-path="Late.md"]').click();
    await window.evaluate(() =>
      (window as unknown as { markdownImageReadStarted: Promise<void> }).markdownImageReadStarted
    );
    await window.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    await window.evaluate(() =>
      (window as unknown as { releaseMarkdownImageRead: () => void }).releaseMarkdownImageRead()
    );
    await expect
      .poll(() =>
        window.evaluate(
          () => (window as unknown as { revokedBlobUrls: string[] }).revokedBlobUrls.length
        )
      )
      .toBe(1);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
