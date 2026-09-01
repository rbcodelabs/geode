import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const NOTE = `# Standard images

Relative: ![Relative alt](Images/photo%20one.png "Relative title")
Parent: ![Parent alt](../Assets/parent.png)
Root: ![Root alt](/Assets/root.png)
Dot segments: ![Dot alt](./Images/../Images/photo%20one.png)
Angle: ![Angle alt](<Images/photo one.png> "Angle title")
Hash: ![Hash alt](Images/image%231.png)
Escapes: ![Escaped \\[alt\\]](Images/photo%20one.png "A \\"quoted\\" title")
Entities: ![A &amp; B](Images/photo%20one.png "T &quot; Q")
Formatted: ![a **b**](Images/photo%20one.png)
No wiki sizing: ![Alt|40](/Assets/root.png)
Boundary: ![Boundary alt](../../outside.png)
Traversal: ![Traversal alt](../../../outside.png)
Missing: ![Missing alt](Images/missing.png)
Unsafe: ![Remote alt](https://example.com/remote.png)
Protocol relative: ![Protocol alt](//example.com/remote.png)
Encoded scheme: ![Encoded scheme alt](%68%74%74%70%73%3A%2F%2Fexample.com/remote.png)
Escaped scheme: ![Escaped scheme alt](https\\://example.com/remote.png)
Data: ![Data alt](data:image/png;base64,AAAA)
File: ![File alt](file:///tmp/remote.png)
Malformed: ![Malformed alt](Images/%ZZ.png)
Raw NUL: ![Raw NUL alt](Images/raw\0.png)
Encoded NUL: ![Encoded NUL alt](Images/raw%00.png)
Broken: ![Broken alt](Images/broken.png)
Wiki: ![[Assets/root.png|24]]
`;

test("renders standard Markdown vault images safely in Live Preview", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-image-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-image-ud-"));
  fs.mkdirSync(path.join(vaultDir, "Notes", "Nested", "Images"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Notes", "Assets"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Assets"), { recursive: true });
  const imageBytes = fs.readFileSync(path.join(repoRoot, "test-vault", "geode-logo.png"));
  fs.writeFileSync(path.join(vaultDir, "Notes", "Nested", "Images", "photo one.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "Notes", "Nested", "Images", "image#1.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "Notes", "Nested", "Images", "broken.png"), "not an image");
  fs.writeFileSync(path.join(vaultDir, "Notes", "Assets", "parent.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "Assets", "root.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "outside.png"), imageBytes);
  fs.writeFileSync(path.join(vaultDir, "Notes", "Nested", "Images.md"), NOTE);
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
    await window.locator('.nav-folder-title[data-path="Notes/Nested"]').click();
    await window.locator('.nav-file-title[data-path="Notes/Nested/Images.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    const standardImages = window.locator(".cm-markdown-image-widget img.internal-embed");
    await expect(standardImages).toHaveCount(11);
    await expect(standardImages.nth(0)).toHaveAttribute("alt", "Relative alt");
    await expect(standardImages.nth(0)).toHaveAttribute("title", "Relative title");
    await expect(standardImages.nth(0)).toHaveAttribute("src", /^blob:/);
    const imageWithAlt = (alt: string) =>
      window.locator(`.cm-markdown-image-widget img.internal-embed[alt="${alt}"]`);
    await expect(imageWithAlt("Parent alt")).toHaveCount(1);
    await expect(imageWithAlt("Root alt")).toHaveCount(1);
    await expect(imageWithAlt("Dot alt")).toHaveCount(1);
    await expect(imageWithAlt("Angle alt")).toHaveAttribute("title", "Angle title");
    await expect(imageWithAlt("Hash alt")).toHaveCount(1);
    await expect(imageWithAlt("Escaped [alt]")).toHaveAttribute(
      "title",
      'A "quoted" title'
    );
    await expect(imageWithAlt("A & B")).toHaveAttribute("title", 'T " Q');
    await expect(imageWithAlt("a b")).toHaveCount(1);
    const unsizedImage = imageWithAlt("Alt|40");
    await expect(unsizedImage).not.toHaveAttribute("width", /.+/);
    await expect(unsizedImage).not.toHaveAttribute("height", /.+/);
    await expect(imageWithAlt("Boundary alt")).toHaveCount(1);

    const fallbacks = window.locator(".cm-markdown-image-widget.is-unresolved");
    const fallbackAlts = [
      "Traversal alt",
      "Missing alt",
      "Remote alt",
      "Protocol alt",
      "Encoded scheme alt",
      "Escaped scheme alt",
      "Data alt",
      "File alt",
      "Malformed alt",
      "Raw NUL alt",
      "Encoded NUL alt",
      "Broken alt",
    ];
    for (const alt of fallbackAlts) {
      await expect(fallbacks.filter({ hasText: alt })).toHaveCount(1);
    }
    await expect(fallbacks).toHaveCount(fallbackAlts.length);
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
    await expect(standardImages).toHaveCount(10);
    await expect(window.locator(".cm-editor")).toContainText(
      '![Relative alt](Images/photo%20one.png "Relative title")'
    );
    await content.press("ArrowUp");
    await content.press("ArrowUp");
    await expect(standardImages).toHaveCount(11);

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
    await expect(standardImages).toHaveCount(11);

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
      .toBeGreaterThanOrEqual(11);
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
