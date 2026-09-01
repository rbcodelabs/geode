import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const platformModifier: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";

function fixture(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-page-preview-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-page-preview-user-"));
  fs.mkdirSync(path.join(vaultDir, "Folder"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Folder", "Source.md"),
    [
      "# Source",
      "",
      "[[Preview Alias#Details|aliased heading]]",
      "",
      "[relative heading](Sibling.md#Details)",
      "",
      "[[Sibling#Missing Heading|missing heading]]",
      "",
      "[[Slow|slow target]] and [[Fast|fast target]]",
      "",
      "[[Missing]] [external](https://example.com) ![[Other]]",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(vaultDir, "Folder", "Sibling.md"),
    [
      "---",
      "aliases:",
      "  - Preview Alias",
      "---",
      "# Sibling",
      "Intro that is outside the requested section.",
      "## Details",
      "**Rendered detail** with `safe code`.",
      "<button autofocus onclick=\"window.previewUnsafe = true\">Unsafe</button>",
      "![remote](https://example.com/tracker.png) [nested navigation](https://example.com)",
      "<svg width=\"1\" height=\"1\" aria-hidden=\"true\"><image xlink:href=\"https://example.com/svg-tracker.png\"></image><a xlink:href=\"javascript:window.previewUnsafe = true\"><text>Unsafe SVG link</text></a></svg>",
      "![[Other]]",
      "## Later",
      "This must not appear in the heading preview.",
    ].join("\n")
  );
  fs.writeFileSync(path.join(vaultDir, "Slow.md"), "# Slow\nStale slow content.");
  fs.writeFileSync(path.join(vaultDir, "Fast.md"), "# Fast\nFresh fast content.");
  fs.writeFileSync(path.join(vaultDir, "Other.md"), "# Other\nNo previews here.");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

async function launchFixture(): Promise<{
  app: ElectronApplication;
  window: Page;
  vaultDir: string;
  userDataDir: string;
}> {
  const { vaultDir, userDataDir } = fixture();
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  const window = await app.firstWindow();
  await expect(window.locator('.nav-folder-title[data-path="Folder"]')).toBeVisible();
  await window.locator('.nav-folder-title[data-path="Folder"]').click();
  await expect(window.locator('.nav-file-title[data-path="Folder/Source.md"]')).toBeVisible();
  await window.locator('.nav-file-title[data-path="Folder/Source.md"]').click();
  return { app, window, vaultDir, userDataDir };
}

async function closeFixture(app: ElectronApplication, vaultDir: string, userDataDir: string): Promise<void> {
  await app.close();
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

test("Reading View previews resolved wikilinks and source-relative Markdown headings safely", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    const remotePreviewRequests: string[] = [];
    window.on("request", (request) => {
      if (request.url().includes("example.com/tracker.png")) remotePreviewRequests.push(request.url());
    });
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    await expect(window.locator(".markdown-reading-view")).toBeVisible();

    const alias = window.locator('.markdown-reading-view a.internal-link[data-href="Preview Alias#Details"]');
    const focusBefore = await window.evaluate(() => document.activeElement?.outerHTML);
    await alias.hover();
    const preview = window.locator(".page-preview");
    await window.waitForTimeout(150);
    await expect(preview).toHaveCount(0);
    await expect(preview).toBeVisible();
    await expect(preview.locator(".page-preview-title")).toHaveText("Sibling");
    await expect(preview.locator(".page-preview-path")).toHaveText("Folder/Sibling.md#Details");
    await expect(preview.locator(".page-preview-content strong")).toHaveText("Rendered detail");
    await expect(preview.locator(".page-preview-content")).not.toContainText("outside the requested section");
    await expect(preview.locator(".page-preview-content")).not.toContainText("This must not appear");
    await expect(preview.locator("button, img, input, [href], [src], [xlink\\:href], [tabindex]")).toHaveCount(0);
    expect(await window.evaluate(() => (window as any).previewUnsafe)).toBeUndefined();
    expect(remotePreviewRequests).toEqual([]);
    expect(await window.evaluate(() => document.activeElement?.outerHTML)).toBe(focusBefore);
    expect(await preview.getAttribute("tabindex")).toBeNull();
    const box = await preview.boundingBox();
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

    // Crossing the small gap from trigger to card must not collapse it.
    await preview.hover();
    await window.waitForTimeout(250);
    await expect(preview).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    const relative = window.locator('.markdown-reading-view a[href="Sibling.md#Details"]');
    await relative.hover();
    await expect(preview.locator(".page-preview-path")).toHaveText("Folder/Sibling.md#Details");

    await window.locator('.markdown-reading-view a[data-href="Sibling#Missing Heading"]').hover();
    await expect(preview.locator(".page-preview-path")).toHaveText("Folder/Sibling.md");
    await expect(preview.locator(".page-preview-content")).toContainText("Intro that is outside");

    // External edits are read on the next hover instead of serving a stale snapshot.
    await window.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);
    fs.writeFileSync(path.join(vaultDir, "Folder", "Sibling.md"), "# Sibling\n## Details\nExternally refreshed preview.");
    await relative.hover();
    await expect(preview.locator(".page-preview-content")).toContainText("Externally refreshed preview");

    await window.mouse.move(0, 0);
    for (const selector of [
      '.markdown-reading-view a.internal-link.is-unresolved',
      '.markdown-reading-view a[href="https://example.com"]',
      '.markdown-reading-view .markdown-embed',
    ]) {
      await window.locator(selector).first().hover();
      await window.waitForTimeout(400);
      await expect(preview).toHaveCount(0);
    }
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});

test("Live Preview requires Cmd/Ctrl, cancels stale work, and tears down with its view", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    const preview = window.locator(".page-preview");
    const alias = window.locator('.cm-live-wikilink[data-href="Preview Alias#Details"]');
    await expect(alias).toBeVisible();

    await alias.hover();
    await window.waitForTimeout(400);
    await expect(preview).toHaveCount(0);
    await window.keyboard.down(platformModifier);
    await alias.hover();
    await expect(preview).toBeVisible();
    await window.keyboard.press("Escape");
    await window.keyboard.up(platformModifier);
    await expect(preview).toHaveCount(0);

    for (const selector of [
      '.cm-live-wikilink[data-href="Missing"]',
      '.cm-live-extlink[data-href="https://example.com"]',
      ".cm-embed-widget",
    ]) {
      await window.keyboard.down(platformModifier);
      await window.locator(selector).hover();
      await window.waitForTimeout(400);
      await window.keyboard.up(platformModifier);
      await expect(preview).toHaveCount(0);
    }

    const relative = window.locator('.cm-live-extlink[data-href="Sibling.md#Details"]');
    await window.keyboard.down(platformModifier);
    await relative.hover();
    await expect(preview.locator(".page-preview-path")).toHaveText("Folder/Sibling.md#Details");
    await window.keyboard.press("Escape");
    await window.keyboard.up(platformModifier);

    // Make the first read slower than the second; generation cancellation must win.
    await window.evaluate(() => {
      const geodeApp = (window as any).app;
      const original = geodeApp.vault.read.bind(geodeApp.vault);
      geodeApp.vault.read = async (file: { path: string }) => {
        if (file.path === "Slow.md") {
          (window as any).slowPreviewReadStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return original(file);
      };
    });
    const slow = window.locator('.cm-live-wikilink[data-href="Slow"]');
    const fast = window.locator('.cm-live-wikilink[data-href="Fast"]');
    await window.keyboard.down(platformModifier);
    await slow.hover();
    await window.waitForTimeout(325);
    expect(await window.evaluate(() => (window as any).slowPreviewReadStarted)).toBe(true);
    await fast.hover();
    await expect(preview.locator(".page-preview-title")).toHaveText("Fast");
    await window.waitForTimeout(550);
    await expect(preview.locator(".page-preview-title")).toHaveText("Fast");
    await expect(preview).not.toContainText("Stale slow content");

    // Changing the active file/view destroys visible previews.
    await window.evaluate(async () => {
      const geodeApp = (window as any).app;
      await geodeApp.openFile(geodeApp.vault.getFileByPath("Other.md"), true);
    });
    await window.keyboard.up(platformModifier);
    await expect(preview).toHaveCount(0);

    // It also invalidates an async read that was already underway.
    await window.locator('.nav-file-title[data-path="Folder/Source.md"]').click();
    await window.keyboard.down(platformModifier);
    await window.locator('.cm-live-wikilink[data-href="Slow"]').hover();
    await window.waitForTimeout(325);
    await window.locator('.nav-file-title[data-path="Other.md"]').click();
    await window.keyboard.up(platformModifier);
    await window.waitForTimeout(550);
    await expect(preview).toHaveCount(0);

    // Source revealed on the active line has no preview trigger.
    await window.locator('.nav-file-title[data-path="Folder/Source.md"]').click();
    await window.evaluate(() => {
      const view = (window as any).app.workspace.activeLeaf.view;
      const text = view.editor.state.doc.toString();
      view.editor.dispatch({ selection: { anchor: text.indexOf("Preview Alias") } });
    });
    await expect(window.locator('.cm-live-wikilink[data-href="Preview Alias#Details"]')).toHaveCount(0);
    await window.keyboard.down(platformModifier);
    await window.locator(".cm-line", { hasText: "Preview Alias" }).hover();
    await window.waitForTimeout(400);
    await window.keyboard.up(platformModifier);
    await expect(preview).toHaveCount(0);
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});

test("does not leave a stale card visible while a different link is pending", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    const preview = window.locator(".page-preview");
    const alias = window.locator('.markdown-reading-view a.internal-link[data-href="Preview Alias#Details"]');
    const slow = window.locator('.markdown-reading-view a.internal-link[data-href="Slow"]');

    await alias.hover();
    await expect(preview.locator(".page-preview-title")).toHaveText("Sibling");

    await slow.hover();
    await window.waitForTimeout(50);
    expect(await preview.count()).toBe(0);
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});

test("cancels a pending Live Preview card when the required modifier is released", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    const preview = window.locator(".page-preview");
    const alias = window.locator('.cm-live-wikilink[data-href="Preview Alias#Details"]');
    await alias.hover();

    await window.keyboard.down(platformModifier);
    await window.keyboard.up(platformModifier);
    await window.waitForTimeout(400);
    await expect(preview).toHaveCount(0);

    // The pointer never left the trigger, so pressing the modifier again must
    // be enough to re-arm the preview without a synthetic mouse movement.
    await window.keyboard.down(platformModifier);
    await expect(preview).toBeVisible();
    await window.keyboard.up(platformModifier);
    await expect(preview).toHaveCount(0);
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});

test("removes the preview when another existing workspace view becomes active", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    const preview = window.locator(".page-preview");
    await window.locator('.markdown-reading-view a.internal-link[data-href="Preview Alias#Details"]').hover();
    await expect(preview).toBeVisible();

    await window.evaluate(async () => {
      const geodeApp = (window as any).app;
      await geodeApp.workspace.openLinkText("Other", "Folder/Source.md", true);
    });
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Other");
    await expect(preview).toHaveCount(0);
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});

test("cancels previews when an already-existing split group becomes active", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    const alias = window.locator('.markdown-reading-view a.internal-link[data-href="Preview Alias#Details"]');
    const slow = window.locator('.markdown-reading-view a.internal-link[data-href="Slow"]');
    const preview = window.locator(".page-preview");

    await window.evaluate(async () => {
      const geodeApp = (window as any).app;
      const sourceGroup = geodeApp.workspace.activeGroup;
      const otherLeaf = geodeApp.workspace.splitActiveLeaf("vertical");
      geodeApp.workspace.setActiveGroup(otherLeaf.group);
      await geodeApp.openFile(geodeApp.vault.getAbstractFileByPath("Other.md"), false);
      geodeApp.workspace.setActiveGroup(sourceGroup);
    });

    await alias.hover();
    await expect(preview).toBeVisible();
    await window.evaluate(() => {
      const workspace = (window as any).app.workspace;
      workspace.setActiveGroup(workspace.groups[1]);
    });
    await expect(preview).toHaveCount(0);

    await window.evaluate(() => {
      const workspace = (window as any).app.workspace;
      workspace.setActiveGroup(workspace.groups[0]);
    });
    await slow.hover();
    await window.evaluate(() => {
      const workspace = (window as any).app.workspace;
      workspace.setActiveGroup(workspace.groups[1]);
    });
    await window.waitForTimeout(400);
    await expect(preview).toHaveCount(0);
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});

test("cancels pending previews on scroll and visible previews on resize", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture();
  try {
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    const alias = window.locator('.markdown-reading-view a.internal-link[data-href="Preview Alias#Details"]');
    const slow = window.locator('.markdown-reading-view a.internal-link[data-href="Slow"]');
    const preview = window.locator(".page-preview");

    await slow.hover();
    await window.evaluate(() => document.dispatchEvent(new Event("scroll")));
    await window.waitForTimeout(400);
    await expect(preview).toHaveCount(0);

    await alias.hover();
    await expect(preview).toBeVisible();
    await preview.locator(".page-preview-content").evaluate((content) => {
      content.dispatchEvent(new Event("scroll"));
    });
    await expect(preview).toBeVisible();
    await window.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(preview).toHaveCount(0);
  } finally {
    await closeFixture(app, vaultDir, userDataDir);
  }
});
