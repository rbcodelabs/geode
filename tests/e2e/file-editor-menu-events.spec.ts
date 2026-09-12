import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

// A.md deliberately mixes: a lead paragraph with no heading above it at all
// (MarkdownView.headingAtLine walks *backward* to the nearest enclosing
// heading, so this is the only line in the document where that lookup is
// null — every other line, including blank ones, falls under "Heading One");
// a heading; and a plain paragraph (no Markdown syntax, so it's a valid
// comment selection).
const A_MD = [
  "Lead paragraph with no heading above it anywhere in this document.",
  "",
  "# Heading One",
  "",
  "Plain paragraph line with no markdown syntax at all here.",
  "",
].join("\n");

function makeVault() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-menu-events-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-menu-events-ud-"));
  fs.writeFileSync(path.join(vaultDir, "A.md"), A_MD);
  fs.writeFileSync(path.join(vaultDir, "sample-data.json"), "{}");
  fs.mkdirSync(path.join(vaultDir, "Sub"));
  fs.writeFileSync(path.join(vaultDir, "Sub", "B.md"), "# B\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  return { vaultDir, userDataDir };
}

/** Launch with the file explorer visible; `openEditor: true` also opens A.md into the main pane for the editor-menu tests. */
async function launch(options: { openEditor?: boolean } = {}) {
  const { vaultDir, userDataDir } = makeVault();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const win = await app.firstWindow();
  await expect(win.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();
  if (options.openEditor) {
    await win.locator('.nav-file-title[data-path="A.md"]').click();
    await expect(win.locator(".cm-content")).toBeVisible();
    await expect(win.locator(".cm-line", { hasText: "Heading One" })).toBeVisible();
  }
  return {
    app,
    win,
    cleanup: async () => {
      await app.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

test.describe("file-menu", () => {
  test("fires for a file right-click, letting a plugin add an item after the built-ins", async () => {
    const { win, cleanup } = await launch();
    try {
      const seen = await win.evaluate(() => {
        const app = (window as any).app;
        const seen: any[] = [];
        app.workspace.on("file-menu", (menu: any, file: any, source: string) => {
          seen.push({ path: file.path, isFile: "extension" in file, source });
          menu.addItem((item: any) => item.setTitle("Plugin File Item").setIcon("star").onClick(() => {
            (window as any).__pluginClicked = `file:${file.path}`;
          }));
        });
        return seen;
      });
      expect(seen).toEqual([]); // just registered, not fired yet

      await win.locator('.nav-file-title[data-path="A.md"]').click({ button: "right" });
      const titles = await win.locator(".menu .menu-item-title").allTextContents();
      expect(titles.length).toBeGreaterThan(1); // built-ins + plugin item
      expect(titles[titles.length - 1]).toBe("Plugin File Item");

      // The built-ins render as several sectioned groups (their own
      // separators between them); what this PR adds is that the plugin
      // item's group (unset section, so it never merges with a built-in
      // section) is itself immediately preceded by a separator.
      const groupSiblings = await win.locator(".menu .menu-scroll > *").evaluateAll(
        (els) => els.map((el) => ({ isSeparator: el.classList.contains("menu-separator"), text: el.textContent }))
      );
      const pluginGroupIndex = groupSiblings.findIndex((s) => s.text?.includes("Plugin File Item"));
      expect(pluginGroupIndex).toBeGreaterThan(0);
      expect(groupSiblings[pluginGroupIndex - 1].isSeparator).toBe(true);

      await win.locator(".menu-item-title", { hasText: "Plugin File Item" }).click();
      await expect.poll(() => win.evaluate(() => (window as any).__pluginClicked)).toBe("file:A.md");
    } finally {
      await cleanup();
    }
  });

  test("fires for a folder right-click with the folder (not a file) and the same source", async () => {
    const { win, cleanup } = await launch();
    try {
      await win.evaluate(() => {
        const app = (window as any).app;
        (window as any).__folderMenuArgs = [];
        app.workspace.on("file-menu", (menu: any, file: any, source: string) => {
          (window as any).__folderMenuArgs.push({ path: file.path, isFolder: "children" in file, source });
          menu.addItem((item: any) => item.setTitle("Plugin Folder Item"));
        });
      });

      await win.locator('.nav-folder-title[data-path="Sub"]').click({ button: "right" });
      await expect(win.locator(".menu-item-title", { hasText: "Plugin Folder Item" })).toBeVisible();

      const args = await win.evaluate(() => (window as any).__folderMenuArgs);
      expect(args).toEqual([{ path: "Sub", isFolder: true, source: "file-explorer-context-menu" }]);
    } finally {
      await cleanup();
    }
  });

  test("does not offer the item on a non-markdown file, but the plugin still sees the real TFile", async () => {
    const { win, cleanup } = await launch();
    try {
      await win.evaluate(() => {
        const app = (window as any).app;
        (window as any).__jsonSeen = null;
        app.workspace.on("file-menu", (menu: any, file: any) => {
          (window as any).__jsonSeen = { path: file.path, extension: file.extension };
          if (file.extension !== "md") return; // mirrors a real plugin gating on markdown
          menu.addItem((item: any) => item.setTitle("Should not appear for json"));
        });
      });

      await win.locator('.nav-file-title[data-path="sample-data.json"]').click({ button: "right" });
      await expect(win.locator(".menu")).toBeVisible();
      await expect(win.locator(".menu-item-title", { hasText: "Should not appear for json" })).toHaveCount(0);
      const seen = await win.evaluate(() => (window as any).__jsonSeen);
      expect(seen).toEqual({ path: "sample-data.json", extension: "json" });
    } finally {
      await cleanup();
    }
  });
});

test.describe("editor-menu", () => {
  // The lead paragraph is the only line in A_MD with no enclosing heading
  // (headingAtLine walks backward to the nearest heading, so every other
  // line — including blank ones — falls under "Heading One"). Collapsed
  // selection + no enclosing heading = neither built-in applies.
  //
  // These two scenarios are deliberately separate tests (each its own
  // Electron launch) rather than two right-clicks in one test: a right-click
  // on editable text that isn't prevented (as the "nothing to show" case
  // isn't) falls through to the browser's native contextmenu default action,
  // which selects the word under the cursor — mutating the CM6 selection a
  // *second* click in the same test would then observe.

  test("regression: without a plugin, a plain right-click with no selection and no heading shows no menu", async () => {
    const { win, cleanup } = await launch({ openEditor: true });
    try {
      const leadParagraph = win.locator(".cm-line", { hasText: "Lead paragraph" });
      await leadParagraph.click({ button: "right" });
      await expect(win.locator(".menu")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test("fires even when neither built-in applies, letting a plugin add the only item", async () => {
    const { win, cleanup } = await launch({ openEditor: true });
    try {
      const leadParagraph = win.locator(".cm-line", { hasText: "Lead paragraph" });
      await win.evaluate(() => {
        const app = (window as any).app;
        app.workspace.on("editor-menu", (menu: any, _editor: any, info: any) => {
          menu.addItem((item: any) => item.setTitle("Plugin Editor Item").onClick(() => {
            (window as any).__editorClicked = info.file?.path ?? null;
          }));
        });
      });

      await leadParagraph.click({ button: "right" });
      const titles = await win.locator(".menu .menu-item-title").allTextContents();
      expect(titles).toEqual(["Plugin Editor Item"]);

      await win.locator(".menu-item-title", { hasText: "Plugin Editor Item" }).click();
      await expect.poll(() => win.evaluate(() => (window as any).__editorClicked)).toBe("A.md");
    } finally {
      await cleanup();
    }
  });

  test("appends after the built-in 'Add comment' item when there is a valid text selection", async () => {
    const { win, cleanup } = await launch({ openEditor: true });
    try {
      await win.evaluate(() => {
        const app = (window as any).app;
        app.workspace.on("editor-menu", (menu: any) => {
          menu.addItem((item: any) => item.setTitle("Plugin Editor Item"));
        });
        const view = app.workspace.activeLeaf.view;
        const text = view.editor.state.doc.toString();
        const from = text.indexOf("Plain paragraph");
        const to = from + "Plain paragraph".length;
        view.editor.dispatch({ selection: { anchor: from, head: to } });
      });

      await win.locator(".cm-line", { hasText: "Plain paragraph" }).click({ button: "right" });
      const titles = await win.locator(".menu .menu-item-title").allTextContents();
      expect(titles).toEqual(["Add comment", "Plugin Editor Item"]);
    } finally {
      await cleanup();
    }
  });

  test("appends after the built-in 'Bookmark this heading' item when right-clicking a heading line", async () => {
    const { win, cleanup } = await launch({ openEditor: true });
    try {
      await win.evaluate(() => {
        const app = (window as any).app;
        app.workspace.on("editor-menu", (menu: any) => {
          menu.addItem((item: any) => item.setTitle("Plugin Editor Item"));
        });
      });

      await win.locator(".cm-line", { hasText: "Heading One" }).click({ button: "right" });
      const titles = await win.locator(".menu .menu-item-title").allTextContents();
      expect(titles).toEqual(["Bookmark this heading", "Plugin Editor Item"]);
    } finally {
      await cleanup();
    }
  });

  test("dismisses on Escape like any other menu, including the plugin item", async () => {
    const { win, cleanup } = await launch({ openEditor: true });
    try {
      await win.evaluate(() => {
        const app = (window as any).app;
        app.workspace.on("editor-menu", (menu: any) => {
          menu.addItem((item: any) => item.setTitle("Plugin Editor Item"));
        });
      });

      await win.locator(".cm-line", { hasText: "Lead paragraph" }).click({ button: "right" });
      await expect(win.locator(".menu-item-title", { hasText: "Plugin Editor Item" })).toBeVisible();
      await win.keyboard.press("Escape");
      await expect(win.locator(".menu")).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });
});
