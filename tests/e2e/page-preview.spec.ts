import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const platformModifier: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";
const wrongPlatformModifier: "Meta" | "Control" = platformModifier === "Meta" ? "Control" : "Meta";

function fixture(withLifecyclePlugin = false): { vaultDir: string; userDataDir: string } {
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
      "[[Reject|renderer rejection]]",
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
      "<script>window.previewUnsafe = true</script>",
      "<button autofocus onclick=\"window.previewUnsafe = true\">Unsafe</button>",
      "![remote](https://example.com/tracker.png) [nested navigation](https://example.com)",
      "![Shortcut Preview Tracker]",
      "[shortcut preview tracker]: https://example.com/shortcut-preview-tracker.png",
      String.raw`\\![Even Slash Preview Tracker]`,
      "[even slash preview tracker]: https://example.com/even-slash-preview-tracker.png",
      String.raw`![Adjacent Preview One]![Adjacent Preview Two]`,
      "[adjacent preview one]: https://example.com/adjacent-preview-one.png",
      "[adjacent preview two]: https://example.com/adjacent-preview-two.png",
      String.raw`\\![Even Adjacent One]\\![Even Adjacent Two]`,
      "[even adjacent one]: https://example.com/even-adjacent-one.png",
      "[even adjacent two]: https://example.com/even-adjacent-two.png",
      "<svg width=\"1\" height=\"1\" aria-hidden=\"true\"><image xlink:href=\"https://example.com/svg-tracker.png\"></image><a xlink:href=\"javascript:window.previewUnsafe = true\"><text>Unsafe SVG link</text></a></svg>",
      "![[Other]]",
      "## Later",
      "This must not appear in the heading preview.",
    ].join("\n")
  );
  fs.writeFileSync(path.join(vaultDir, "Slow.md"), "# Slow\nStale slow content.");
  fs.writeFileSync(path.join(vaultDir, "Fast.md"), "# Fast\nFresh fast content.");
  fs.writeFileSync(path.join(vaultDir, "Reject.md"), "# Reject\nRenderer rejection content.");
  fs.writeFileSync(path.join(vaultDir, "Other.md"), "# Other\nNo previews here.");
  if (withLifecyclePlugin) {
    const pluginDir = path.join(vaultDir, ".geode", "plugins", "preview-lifecycle-proof");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id: "preview-lifecycle-proof", name: "Preview lifecycle proof", version: "1.0.0", minAppVersion: "0.1.0", description: "Synthetic preview cleanup fixture", author: "Geode tests" }));
    fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["preview-lifecycle-proof"]));
    fs.writeFileSync(path.join(pluginDir, "main.js"), `
      const { Plugin, MarkdownRenderChild } = require('geode');
      module.exports.default = class extends Plugin {
        onload() {
          const ledger = window.previewLifecycle = { children: [], active: new Set(), settled: [] };
          this.registerMarkdownPostProcessor((el, ctx) => {
            if (!el.classList.contains('page-preview-content')) return;
            const kind = ctx.sourcePath === 'Slow.md' ? 'slow' : ctx.sourcePath === 'Fast.md' ? 'fast' : ctx.sourcePath === 'Reject.md' ? 'reject' : 'sibling';
            const record = { kind, loads: 0, unloads: 0, cleanups: 0, pings: 0, url: null, revoked: false };
            ledger.children.push(record);
            const child = new class extends MarkdownRenderChild {
              onload() {
                record.loads++; ledger.active.add(record);
                const pixel = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), value => value.charCodeAt(0));
                record.url = URL.createObjectURL(new Blob([pixel], { type: 'image/png' }));
                this.registerDomEvent(window, 'preview-lifecycle-ping', () => record.pings++);
                this.register(() => { record.cleanups++; URL.revokeObjectURL(record.url); record.revoked = true; ledger.active.delete(record); });
              }
              onunload() { record.unloads++; }
            }(el);
            ctx.addChild(child);
          });
        }
      };
    `);
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

async function launchFixture(withLifecyclePlugin = false): Promise<{
  app: ElectronApplication;
  window: Page;
  vaultDir: string;
  userDataDir: string;
}> {
  const { vaultDir, userDataDir } = fixture(withLifecyclePlugin);
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
    const previewConsoleErrors: string[] = [];
    window.on("request", (request) => {
      if (
        request.url().includes("example.com/tracker.png") ||
        request.url().includes("example.com/shortcut-preview-tracker.png") ||
        request.url().includes("example.com/even-slash-preview-tracker.png") ||
        request.url().includes("example.com/adjacent-preview-one.png") ||
        request.url().includes("example.com/adjacent-preview-two.png") ||
        request.url().includes("example.com/even-adjacent-one.png") ||
        request.url().includes("example.com/even-adjacent-two.png")
      ) remotePreviewRequests.push(request.url());
    });
    window.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Failed to render page preview")) {
        previewConsoleErrors.push(message.text());
      }
    });
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    await expect(window.locator(".markdown-reading-view")).toBeVisible();
    await window.evaluate(() => {
      const renderer = (window as any).app.markdownRenderer;
      const original = renderer.render.bind(renderer);
      (window as any).previewCanonicalRenders = 0;
      renderer.render = async (...args: unknown[]) => {
        (window as any).previewCanonicalRenders += 1;
        return original(...args);
      };
    });

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
    expect(await window.evaluate(() => (window as any).previewCanonicalRenders)).toBe(1);
    await expect(preview.locator(".page-preview-content")).not.toContainText("outside the requested section");
    await expect(preview.locator(".page-preview-content")).not.toContainText("This must not appear");
    await expect(preview.locator("script, button, img, input, [onclick], [href], [src], [xlink\\:href], [tabindex]")).toHaveCount(0);
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
    expect(await window.evaluate(() => document.activeElement?.outerHTML)).toBe(focusBefore);

    const relative = window.locator('.markdown-reading-view a[href="Sibling.md#Details"]');
    await relative.hover();
    await expect(preview.locator(".page-preview-path")).toHaveText("Folder/Sibling.md#Details");

    await window.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);
    await window.locator('.markdown-reading-view a[data-href="Sibling#Missing Heading"]').hover();
    await window.waitForTimeout(400);
    expect(previewConsoleErrors).toEqual([]);
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
    await window.keyboard.down(wrongPlatformModifier);
    await alias.hover();
    await window.waitForTimeout(400);
    await expect(preview).toHaveCount(0);
    await window.keyboard.up(wrongPlatformModifier);

    await window.keyboard.down(platformModifier);
    await alias.hover();
    await expect(preview).toBeVisible();
    await window.keyboard.down(wrongPlatformModifier);
    await window.keyboard.up(wrongPlatformModifier);
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

    // Hold each slow read until the competing action has happened. Timer speed
    // must not decide whether this actually exercises generation cancellation.
    await window.evaluate(() => {
      const geodeApp = (window as any).app;
      const original = geodeApp.vault.read.bind(geodeApp.vault);
      (window as any).slowPreviewReadsStarted = 0;
      (window as any).slowPreviewReadsCompleted = 0;
      geodeApp.vault.read = async (file: { path: string }) => {
        if (file.path === "Slow.md") {
          (window as any).slowPreviewReadsStarted += 1;
          await new Promise<void>((resolve) => { (window as any).releaseSlowPreviewRead = resolve; });
          const text = await original(file);
          (window as any).slowPreviewReadsCompleted += 1;
          return text;
        }
        return original(file);
      };
    });
    const slow = window.locator('.cm-live-wikilink[data-href="Slow"]');
    const fast = window.locator('.cm-live-wikilink[data-href="Fast"]');
    await window.keyboard.down(platformModifier);
    await slow.hover();
    await expect.poll(() => window.evaluate(() => (window as any).slowPreviewReadsStarted)).toBe(1);
    await fast.hover();
    await expect(preview.locator(".page-preview-title")).toHaveText("Fast");
    await window.evaluate(() => (window as any).releaseSlowPreviewRead());
    await expect.poll(() => window.evaluate(() => (window as any).slowPreviewReadsCompleted)).toBe(1);
    // Observe after the read consumer's promise continuation has run.
    await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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
    await expect.poll(() => window.evaluate(() => (window as any).slowPreviewReadsStarted)).toBe(2);
    await window.locator('.nav-file-title[data-path="Other.md"]').click();
    await window.keyboard.up(platformModifier);
    await window.evaluate(() => (window as any).releaseSlowPreviewRead());
    await expect.poll(() => window.evaluate(() => (window as any).slowPreviewReadsCompleted)).toBe(2);
    await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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

test("unloads real preview children and resources on dismissal, replacement, staleness, and rejection", async () => {
  const { app, window, vaultDir, userDataDir } = await launchFixture(true);
  const pageErrors: string[] = [];
  window.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await window.waitForFunction(() => !!(window as any).previewLifecycle);
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    await window.evaluate(() => {
      const renderer = (window as any).app.markdownRenderer;
      const originalRender = renderer.render.bind(renderer);
      renderer.render = async (...args: any[]) => {
        // Run the canonical renderer and real ctx.addChild first: cancellation
        // and rejection must clean up actual allocated resources, not a spy.
        await originalRender(...args);
        if (args[2] === "Slow.md") {
          (window as any).slowCanonicalRenderStarted = true;
          await new Promise<void>((resolve) => { (window as any).releaseSlowCanonicalRender = resolve; });
        }
        (window as any).previewLifecycle.settled.push(args[2]);
        if (args[2] === "Reject.md") throw new Error("intentional preview renderer rejection after allocation");
      };
    });

    const children = () => window.evaluate(() => (window as any).previewLifecycle.children.map((row: any) => ({ kind: row.kind, loads: row.loads, unloads: row.unloads, cleanups: row.cleanups, revoked: row.revoked })));
    const active = () => window.evaluate(() => [...(window as any).previewLifecycle.active].map((row: any) => row.kind).sort());
    const assertReleasedResources = async () => {
      expect(await window.evaluate(async () => {
        const ledger = (window as any).previewLifecycle;
        const before = ledger.children.map((row: any) => row.pings);
        window.dispatchEvent(new Event("preview-lifecycle-ping"));
        const staleListeners = ledger.children.filter((row: any, i: number) => row.unloads && row.pings !== before[i]).length;
        const activeListeners = ledger.children.filter((row: any, i: number) => ledger.active.has(row) && row.pings === before[i] + 1).length;
        const released = ledger.children.filter((row: any) => row.unloads);
        const blobStillReadable = await Promise.all(released.map(async (row: any) => {
          const image = new Image(); image.src = row.url;
          try { await image.decode(); return true; } catch { return false; }
        }));
        return { staleListeners, activeListeners, blobStillReadable };
      })).toEqual({ staleListeners: 0, activeListeners: (await active()).length, blobStillReadable: (await children()).filter((row: any) => row.unloads).map(() => false) });
    };

    const preview = window.locator(".page-preview");
    const alias = window.locator('.markdown-reading-view a.internal-link[data-href="Preview Alias#Details"]');
    const slow = window.locator('.markdown-reading-view a.internal-link[data-href="Slow"]');
    const fast = window.locator('.markdown-reading-view a.internal-link[data-href="Fast"]');
    const reject = window.locator('.markdown-reading-view a.internal-link[data-href="Reject"]');

    await alias.hover();
    await expect(preview).toBeVisible();
    await expect.poll(active).toEqual(["sibling"]);
    expect(await window.evaluate(async () => {
      const row = (window as any).previewLifecycle.children[0];
      // Renderer CSP permits blob images, but intentionally disallows blob fetch.
      const image = new Image(); image.src = row.url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    })).toEqual({ width: 1, height: 1 });
    await window.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect.poll(children).toEqual([{ kind: "sibling", loads: 1, unloads: 1, cleanups: 1, revoked: true }]);
    await expect.poll(active).toEqual([]);
    await assertReleasedResources();

    await window.mouse.move(0, 0);
    await alias.hover();
    await expect(preview).toBeVisible();
    await expect.poll(active).toEqual(["sibling"]);
    await slow.hover();
    await expect(preview).toHaveCount(0);
    await expect.poll(async () => (await children()).filter((row: any) => row.kind === "sibling")).toEqual([
      { kind: "sibling", loads: 1, unloads: 1, cleanups: 1, revoked: true },
      { kind: "sibling", loads: 1, unloads: 1, cleanups: 1, revoked: true },
    ]);

    await expect.poll(() => window.evaluate(() => (window as any).slowCanonicalRenderStarted)).toBe(true);
    await expect.poll(active).toEqual(["slow"]);
    await fast.hover();
    await expect(preview.locator(".page-preview-title")).toHaveText("Fast");
    await expect.poll(active).toEqual(["fast", "slow"]);
    await window.evaluate(() => (window as any).releaseSlowCanonicalRender());
    await expect.poll(() => window.evaluate(() => (window as any).previewLifecycle.settled.includes("Slow.md"))).toBe(true);
    await expect.poll(async () => (await children()).filter((row: any) => row.kind === "slow")).toEqual([{ kind: "slow", loads: 1, unloads: 1, cleanups: 1, revoked: true }]);
    await expect.poll(active).toEqual(["fast"]);
    await expect(preview.locator(".page-preview-title")).toHaveText("Fast");
    await expect(preview).not.toContainText("Stale slow content");
    await assertReleasedResources();

    await window.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);
    await expect.poll(active).toEqual([]);
    await reject.hover();
    await expect.poll(async () => (await children()).filter((row: any) => row.kind === "reject")).toEqual([{ kind: "reject", loads: 1, unloads: 1, cleanups: 1, revoked: true }]);
    await expect(preview).toHaveCount(0);
    await expect.poll(active).toEqual([]);
    await assertReleasedResources();
    expect((await children()).every((row: any) => row.loads === 1 && row.unloads === 1 && row.cleanups === 1)).toBe(true);
    expect(pageErrors).toEqual([]);
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
