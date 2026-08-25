import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

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
