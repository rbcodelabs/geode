import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Seed a temp vault + temp userDataDir and launch Geode against it. Mirrors the
 * Phase A harness above; returned `cleanup` closes the app and removes both
 * temp dirs. `files` maps vault-relative names to contents.
 */
async function launch(files: Record<string, string>): Promise<{
  app: ElectronApplication;
  window: Awaited<ReturnType<ElectronApplication["firstWindow"]>>;
  vaultDir: string;
  cleanup: () => Promise<void>;
}> {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bookmarks-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bookmarks-ud-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(vaultDir, name), content);
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  // Wait for boot to finish (the File Explorer has rendered at least one file
  // row) before any evaluate() runs — mirrors the Phase A test, and is robust
  // to the one-time renderer context swap during startup that leaves an
  // early `window.app` reference stale.
  await window.locator(".nav-file-title").first().waitFor({ state: "visible" });
  await window.waitForFunction(() => !!(window as any).app);
  return {
    app,
    window,
    vaultDir,
    cleanup: async () => {
      await app.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Bookmarks core plugin — end-to-end. The load-bearing thing this proves is
 * that a real plugin-facing `ItemView` docked in the sidebar CAN show the
 * generic `.view-header` (title + `addAction()` icons) via the
 * `mod-show-generic-header` opt-in, even though the blanket
 * `.workspace-sidebar .view-header { display: none }` rule hides it for every
 * other built-in sidebar view. Harness mirrors backlinks-visibility.spec.ts:
 * temp vault + temp userDataDir seeding recentVaults/lastVault.
 */
test("Bookmarks pane shows its header/actions and round-trips file & group bookmarks", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bookmarks-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bookmarks-ud-"));
  fs.writeFileSync(path.join(vaultDir, "A.md"), "# A\n");
  fs.writeFileSync(path.join(vaultDir, "B.md"), "# B\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });

  try {
    const window = await app.firstWindow();
    const leftSidebar = window.locator(".workspace-sidebar.mod-left");
    // File Explorer is the left sidebar's initial view.
    await expect(window.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();

    const bookmarksTab = leftSidebar.locator('.workspace-tab-header[data-type="bookmarks"]');
    const filesTab = leftSidebar.locator('.workspace-tab-header[data-type="file-explorer"]');
    const bookmarksPane = window.locator(".mod-show-generic-header");

    // --- 1. Reveal Bookmarks: empty state + the generic header is VISIBLE ---
    // This is the core assertion of the whole feature: unlike every other
    // sidebar view, the Bookmarks ItemView opts into the generic .view-header,
    // so at least one .view-header is visible under .workspace-sidebar here.
    await expect(bookmarksTab).toBeVisible();
    await bookmarksTab.click();
    await expect(bookmarksPane.locator(".pane-empty")).toHaveText("No bookmarks yet");
    await expect(bookmarksPane.locator(".view-header .view-header-title")).toHaveText("Bookmarks");
    const visibleHeaders = await window.locator(".workspace-sidebar .view-header:visible").count();
    expect(visibleHeaders).toBeGreaterThanOrEqual(1);
    // Both header action icons rendered by addAction() are present.
    await expect(bookmarksPane.locator('.view-actions button[aria-label="Bookmark the active tab"]')).toBeVisible();
    const newGroupAction = bookmarksPane.locator('.view-actions button[aria-label="New bookmark group"]');
    await expect(newGroupAction).toBeVisible();

    // --- 2. Bookmark a file from the File Explorer context menu ------------
    await filesTab.click();
    await expect(window.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    await window.locator('.nav-file-title[data-path="A.md"]').click({ button: "right" });
    // The "Bookmark" item carries a bookmark icon, so its textContent is
    // whitespace-prefixed ("…\n\nBookmark"); anchor only the end. Case-
    // sensitive `B` also excludes the "Un-bookmark" label.
    await window.locator(".menu-item", { hasText: /Bookmark$/ }).click();

    await bookmarksTab.click();
    await expect(bookmarksPane.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();

    // --- 3. Remove the bookmark via its own row context menu --------------
    await bookmarksPane.locator('.nav-file-title[data-path="A.md"]').click({ button: "right" });
    await window.locator(".menu-item", { hasText: /Remove$/ }).click();
    await expect(bookmarksPane.locator('.nav-file-title[data-path="A.md"]')).toHaveCount(0);
    await expect(bookmarksPane.locator(".pane-empty")).toHaveText("No bookmarks yet");

    // --- 4. Create a bookmark group via the header action ----------------
    await newGroupAction.click();
    const prompt = window.locator(".modal-container .prompt-input");
    await expect(prompt).toBeVisible();
    await prompt.fill("Reading list");
    await prompt.press("Enter");
    await expect(
      bookmarksPane.locator(".nav-folder-title .nav-item-title", { hasText: "Reading list" })
    ).toBeVisible();

    // --- 5. "Bookmarks: Bookmark current file" command -------------------
    await window.evaluate(async () => {
      const geode = (window as any).app;
      await geode.openFile(geode.vault.getFileByPath("B.md"), false);
      geode.commands.execute("bookmarks-current-file");
    });
    await expect(bookmarksPane.locator('.nav-file-title[data-path="B.md"]')).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Search pane bookmarks a query; opening it re-runs the search", async () => {
  const { window, cleanup } = await launch({ "A.md": "# A\nhello geode\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    // Reveal Search pane via command, type a query.
    await window.evaluate(() => (window as any).app.openSearch("hello"));
    const searchInput = window.locator(".search-view .search-input");
    await expect(searchInput).toHaveValue("hello");

    // Three-dot menu → Bookmark search.
    await window.locator(".search-view .sidebar-view-actions button").click();
    await window.locator(".menu-item", { hasText: /Bookmark search$/ }).click();

    // Change the query while the Search pane is still mounted, so a later "hello"
    // proves the bookmark re-ran the saved query (not a stale value).
    await searchInput.fill("something else");
    await expect(searchInput).toHaveValue("something else");

    // A search row appears in the Bookmarks pane.
    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    const searchRow = bookmarksPane.locator(".nav-item-title", { hasText: "hello" });
    await expect(searchRow).toBeVisible();

    // Clicking the bookmark reopens Search pre-filled with the saved query.
    await searchRow.click();
    await expect(searchInput).toHaveValue("hello");
  } finally {
    await cleanup();
  }
});

test("Bookmark heading under cursor adds a heading row", async () => {
  const { window, cleanup } = await launch({ "B.md": "# Big heading\nbody\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    await window.evaluate(async () => {
      const a = (window as any).app;
      const file = a.vault.getFileByPath("B.md");
      await a.openFile(file, false);
      // Wait for the metadata cache to index the heading before resolving it.
      for (let i = 0; i < 100; i++) {
        if ((a.metadataCache.getFileCache(file)?.headings?.length ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      a.commands.execute("bookmark-heading");
    });

    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(bookmarksPane.locator(".nav-item-title", { hasText: "Big heading" })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("Bookmark block under cursor writes a ^id and adds a block row", async () => {
  const { window, vaultDir, cleanup } = await launch({ "A.md": "# A\nHello world paragraph\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("A.md"), false);
      // Put the cursor on the paragraph line (offset 5 is inside "Hello…").
      a.getActiveMarkdownView().editor.dispatch({ selection: { anchor: 5 } });
      await a.getActiveMarkdownView().bookmarkBlockUnderCursor();
    });

    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    // The block row's label is "A.md ^<id>".
    await expect(bookmarksPane.locator(".nav-item-title", { hasText: /A\.md \^/ })).toBeVisible();

    // The file on disk gained a trailing ^id on the paragraph line.
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, "A.md"), "utf8"))
      .toMatch(/Hello world paragraph \^[A-Za-z0-9-]+/);
  } finally {
    await cleanup();
  }
});

test("Web Viewer toolbar bookmarks the current page as a link", async () => {
  const { window, cleanup } = await launch({ "A.md": "# A\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    await window.evaluate(() => (window as any).app.openWebViewer("https://example.com/"));
    await window.locator('.web-view-toolbar button[title="More options"]').click();
    await window.locator(".menu-item", { hasText: /Bookmark this page$/ }).click();

    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(
      bookmarksPane.locator(".nav-item-title", { hasText: "https://example.com/" })
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('Tab-group dropdown "Bookmark N tabs" bookmarks open file tabs', async () => {
  const { window, cleanup } = await launch({ "A.md": "# A\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    // Open A.md as a main-area tab so the group has a bookmarkable leaf.
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("A.md"), false);
    });

    await window.locator('.clickable-icon[title="All tabs"]').first().click();
    await window.locator(".menu-item", { hasText: /Bookmark \d+ tab/ }).click();

    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(bookmarksPane.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("File Explorer multi-select → Bookmark all bookmarks every selected file", async () => {
  const { window, cleanup } = await launch({ "A.md": "# A\n", "B.md": "# B\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    const rowA = window.locator('.nav-file-title[data-path="A.md"]');
    const rowB = window.locator('.nav-file-title[data-path="B.md"]');
    await expect(rowA).toBeVisible();

    // Alt-click toggles each into the selection.
    await rowA.click({ modifiers: ["Alt"] });
    await rowB.click({ modifiers: ["Alt"] });
    await expect(rowA).toHaveClass(/is-selected/);
    await expect(rowB).toHaveClass(/is-selected/);

    await rowB.click({ button: "right" });
    await window.locator(".menu-item", { hasText: /Bookmark all/ }).click();

    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(bookmarksPane.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
    await expect(bookmarksPane.locator('.nav-file-title[data-path="B.md"]')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("Edit bookmark: change title and move into a group", async () => {
  const { window, cleanup } = await launch({ "A.md": "# A\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    // Bookmark A.md and create a group.
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.toggleBookmarkFile(a.vault.getFileByPath("A.md"));
      await a.mutateBookmarks((root: any) => ({
        items: [...root.items, { type: "group", id: "grp1", title: "My group", expanded: true, items: [] }],
      }));
    });

    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    const fileRow = bookmarksPane.locator('.nav-file-title[data-path="A.md"]');
    await expect(fileRow).toBeVisible();

    // Open Edit, change title, select the group, save.
    await fileRow.click({ button: "right" });
    await window.locator(".menu-item", { hasText: /Edit/ }).click();
    const modal = window.locator(".modal.mod-edit-bookmark");
    await expect(modal).toBeVisible();
    await modal.locator("input.prompt-input").fill("Renamed A");
    await modal.locator("select.dropdown").selectOption({ label: "My group" });
    await modal.locator("button.mod-cta").click();

    // The group now contains a child row titled "Renamed A"; expand to see it.
    await bookmarksPane.locator(".nav-folder-title", { hasText: "My group" }).click();
    await expect(
      bookmarksPane.locator(".nav-folder-children .nav-item-title", { hasText: "Renamed A" })
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("Drag a bookmark into a group nests it (drives the view's drop handlers)", async () => {
  const { window, cleanup } = await launch({ "A.md": "# A\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.toggleBookmarkFile(a.vault.getFileByPath("A.md"));
      await a.mutateBookmarks((root: any) => ({
        items: [...root.items, { type: "group", id: "gTarget", title: "Target group", expanded: true, items: [] }],
      }));
    });
    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(bookmarksPane.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();

    // Fire the real HTML5 DnD sequence on the live rows: dragstart on the file,
    // drop onto the middle of the group (the "into" zone). This exercises
    // wireDragSource + wireGroupDropTarget → moveItem, not a data-model shortcut.
    const nested = await window.evaluate(() => {
      const container = document.querySelector(".bookmarks-container")!;
      const fileRow = container.querySelector('.nav-file-title[data-id]') as HTMLElement;
      const groupRow = container.querySelector('.nav-folder-title[data-id]') as HTMLElement;
      const dt = new DataTransfer();
      fileRow.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const r = groupRow.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      groupRow.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientY: mid }));
      groupRow.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt, clientY: mid }));
      return true;
    });
    expect(nested).toBe(true);

    // The data model now has the file nested inside the group.
    await expect
      .poll(() =>
        window.evaluate(() => {
          const g = (window as any).app.bookmarksRoot.items.find((i: any) => i.id === "gTarget");
          return g?.items?.some((c: any) => c.type === "file" && c.path === "A.md") ?? false;
        })
      )
      .toBe(true);
  } finally {
    await cleanup();
  }
});

test("Bookmark block refuses inside a code fence and leaves the file untouched (FIX 3)", async () => {
  const original = "# A\n\n```js\nconst x = 1;\n```\n";
  const { window, vaultDir, cleanup } = await launch({ "A.md": original });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    const acted = await window.evaluate(async () => {
      const a = (window as any).app;
      const file = a.vault.getFileByPath("A.md");
      await a.openFile(file, false);
      // Wait for the metadata cache to index the fenced "code" section.
      for (let i = 0; i < 100; i++) {
        if (a.metadataCache.getFileCache(file)?.sections?.some((s: any) => s.type === "code")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // Cursor onto the "const x = 1;" line (offset 13 is inside it).
      a.getActiveMarkdownView().editor.dispatch({ selection: { anchor: 13 } });
      await a.getActiveMarkdownView().bookmarkBlockUnderCursor();
      return true;
    });
    expect(acted).toBe(true);

    // No block bookmark was added…
    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(bookmarksPane.locator(".pane-empty")).toHaveText("No bookmarks yet");
    // …and the file on disk is byte-for-byte unchanged (no `^id` in the fence).
    expect(fs.readFileSync(path.join(vaultDir, "A.md"), "utf8")).toBe(original);
  } finally {
    await cleanup();
  }
});

test("Bookmark block on a multi-item list lands the ^id on the cursor's bullet (FIX 4)", async () => {
  const { window, vaultDir, cleanup } = await launch({ "L.md": "# L\n\n- one\n- two\n- three\n" });
  try {
    const bookmarksPane = window.locator(".mod-show-generic-header");

    await window.evaluate(async () => {
      const a = (window as any).app;
      const file = a.vault.getFileByPath("L.md");
      await a.openFile(file, false);
      for (let i = 0; i < 100; i++) {
        if ((a.metadataCache.getFileCache(file)?.listItems?.length ?? 0) >= 3) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // Cursor on the FIRST bullet "- one" (offset 7 is inside "one").
      a.getActiveMarkdownView().editor.dispatch({ selection: { anchor: 7 } });
      await a.getActiveMarkdownView().bookmarkBlockUnderCursor();
    });

    // A block row appears…
    await window.locator('.workspace-tab-header[data-type="bookmarks"]').click();
    await expect(bookmarksPane.locator(".nav-item-title", { hasText: /L\.md \^/ })).toBeVisible();

    // …and the ^id landed on bullet 1, not bullet 3.
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, "L.md"), "utf8"))
      .toMatch(/- one \^[A-Za-z0-9-]+\n- two\n- three\n/);
  } finally {
    await cleanup();
  }
});
