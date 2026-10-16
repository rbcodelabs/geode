import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
// Trashing the merged source goes through the OS trash service, which a headless
// Linux box lacks (shell.trashItem fails there; macOS covers removal).
const canTrash = process.platform === "darwin";

interface Harness {
  app: ElectronApplication;
  win: Page;
  vaultDir: string;
  read: (rel: string) => string;
  exists: (rel: string) => boolean;
  cleanup: () => Promise<void>;
}

async function launch(files: Record<string, string>): Promise<Harness> {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-composer-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-composer-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, rel), content);
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1" },
  });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 800 });
  await win.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
  // Backlinks must be indexed before a merge can rewrite them.
  await win.waitForFunction(() => {
    const geode = (window as any).app;
    const file = geode.vault.getFileByPath("Src.md");
    return !file || geode.metadataCache.getBacklinks(file).length > 0 || !geode.vault.getFileByPath("Linker.md");
  });
  return {
    app,
    win,
    vaultDir,
    read: (rel) => fs.readFileSync(path.join(vaultDir, rel), "utf8"),
    exists: (rel) => fs.existsSync(path.join(vaultDir, rel)),
    cleanup: async () => {
      await app.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

const MERGE_FILES = {
  "Src.md": "Source body\n",
  "Dest.md": "Dest body\n",
  "Linker.md": "see [[Src]] and ![[Src]] and [[Src#H]] and [[Src|alias]] and [[Other]]\n",
  "Other.md": "other\n",
};

async function mergeFromExplorer(win: Page, target: string, key: string): Promise<void> {
  await win.locator('.nav-file-title[data-path="Src.md"]').click({ button: "right" });
  await win.locator(".menu-item", { hasText: "Merge entire file with…" }).click();
  const input = win.locator(".note-composer-picker input");
  await expect(input).toBeFocused();
  await input.fill(target);
  await input.press(key);
}

test("Merge appends via Enter, rewrites links on disk, and asks for confirmation first", async () => {
  const h = await launch(MERGE_FILES);
  try {
    const { win } = h;
    await h.win.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await expect(win.getByLabel("Ask before merging")).toBeChecked();
    await expect(win.getByLabel("Text after extraction")).toHaveValue("link");
    await win.keyboard.press("Escape");

    await mergeFromExplorer(win, "Dest", "Enter");
    // Default: a confirmation modal; Cancel leaves everything alone.
    const confirm = win.locator(".note-composer-confirm");
    await expect(confirm).toContainText('Merge "Src" into "Dest"');
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(h.exists("Src.md")).toBe(true);
    expect(h.read("Dest.md")).toBe("Dest body\n");

    // Hold the actual later referencer write to demonstrate that the completed
    // destination write is not a merge-completion barrier (especially on Linux,
    // where there is no successful OS-trash/deletion barrier below).
    await win.evaluate(() => {
      const vault = (window as any).app.vault;
      const modify = vault.modify.bind(vault);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const gate = { reached: false, release };
      (window as any).__composerReferencerGate = gate;
      vault.modify = async (file: any, text: string, options?: unknown) => {
        if (file.path === "Linker.md" && !gate.reached) { gate.reached = true; await held; }
        return modify(file, text, options);
      };
    });
    await mergeFromExplorer(win, "Dest", "Enter");
    await win.locator(".note-composer-confirm-merge").click();
    await expect.poll(() => h.read("Dest.md")).toBe("Dest body\n\nSource body\n");
    try {
      await expect.poll(() => win.evaluate(() => (window as any).__composerReferencerGate.reached)).toBe(true);
      expect(h.read("Linker.md")).toBe(MERGE_FILES["Linker.md"]);
    } finally {
      await win.evaluate(() => (window as any).__composerReferencerGate.release());
    }
    if (canTrash) await expect.poll(() => h.exists("Src.md")).toBe(false);
    expect(h.read("Dest.md")).toBe("Dest body\n\nSource body\n");
    await expect.poll(() => h.read("Linker.md")).toBe("see [[Dest]] and ![[Dest]] and [[Dest#H]] and [[Dest|alias]] and [[Other]]\n");
    expect(h.read("Other.md")).toBe("other\n");
  } finally {
    try { await h.win.evaluate(() => (window as any).__composerReferencerGate?.release()); }
    finally { await h.cleanup(); }
  }
});

test("Merge with Shift+Enter prepends, and the command opens the same picker", async () => {
  const h = await launch(MERGE_FILES);
  try {
    const { win } = h;
    await win.evaluate(async () => {
      const geode = (window as any).app;
      await geode.noteComposer.update({ askBeforeMerging: false });
      await geode.openFile(geode.vault.getFileByPath("Src.md"), false);
    });
    expect(await win.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => id.startsWith("note-composer:")))).toEqual(
      expect.arrayContaining(["note-composer:merge-file", "note-composer:extract-selection"])
    );
    await win.evaluate(() => (window as any).app.commands.execute("note-composer:merge-file"));
    const input = win.locator(".note-composer-picker input");
    // Source is not offered as its own target.
    await input.fill("Src");
    await expect(win.locator(".note-composer-picker .prompt-result", { hasText: /^Src$/ })).toHaveCount(0);
    await input.fill("Dest");
    await input.press("Shift+Enter");
    // Ask before merging is off: no confirmation modal.
    await expect.poll(() => h.read("Dest.md")).toBe("Source body\n\nDest body\n");
    if (canTrash) await expect.poll(() => h.exists("Src.md")).toBe(false);
    await expect(win.locator(".note-composer-confirm")).toHaveCount(0);
    expect(h.read("Dest.md")).toBe("Source body\n\nDest body\n");
    await expect.poll(() => h.read("Linker.md")).toContain("[[Dest]] and ![[Dest]]");
  } finally {
    await h.cleanup();
  }
});

test("Merge with Ctrl/Cmd+Enter creates a new note using the template and rewrites links to it", async () => {
  const h = await launch({
    ...MERGE_FILES,
    "Templates/Composer.md": "# {{newTitle}} from {{fromTitle}} ({{date:YYYY}})\n\n{{content}}\n",
  });
  try {
    const { win } = h;
    await win.evaluate(async () => {
      const geode = (window as any).app;
      await geode.noteComposer.update({ askBeforeMerging: false, template: "Templates/Composer" });
    });
    await mergeFromExplorer(win, "Brand New", "Control+Enter");
    await expect.poll(() => h.exists("Brand New.md")).toBe(true);
    await expect.poll(() => h.read("Linker.md")).toContain("[[Brand New]]");
    if (canTrash) await expect.poll(() => h.exists("Src.md")).toBe(false);
    expect(h.read("Brand New.md")).toBe(`# Brand New from Src (${new Date().getFullYear()})\n\nSource body\n`);
    expect(h.read("Linker.md")).toBe("see [[Brand New]] and ![[Brand New]] and [[Brand New#H]] and [[Brand New|alias]] and [[Other]]\n");
    expect(h.read("Dest.md")).toBe("Dest body\n");
  } finally {
    await h.cleanup();
  }
});

const EXTRACT_FILES = {
  "Source.md": "Before\nMOVE ME\nAfter\n",
  "Dest.md": "Dest body\n",
  "Templates/Composer.md": "From {{fromTitle}} to {{newTitle}} on {{date:YYYY-MM-DD}}\n",
};

async function selectInEditor(win: Page, needle: string): Promise<void> {
  await win.evaluate(async (text) => {
    const geode = (window as any).app;
    await geode.openFile(geode.vault.getFileByPath("Source.md"), false);
    const view = geode.getActiveMarkdownView();
    const from = view.editor.state.doc.toString().indexOf(text);
    view.editor.dispatch({ selection: { anchor: from, head: from + text.length } });
  }, needle);
}

for (const [mode, expected] of [
  ["link", "Before\n[[Dest]]\nAfter\n"],
  ["embed", "Before\n![[Dest]]\nAfter\n"],
  ["none", "Before\n\nAfter\n"],
] as const) {
  test(`Extract selection appends to an existing note and leaves ${mode}`, async () => {
    const h = await launch(EXTRACT_FILES);
    try {
      const { win } = h;
      await win.evaluate((m) => (window as any).app.noteComposer.update({ textAfterExtraction: m }), mode);
      await selectInEditor(win, "MOVE ME");
      await win.evaluate(() => (window as any).app.commands.execute("note-composer:extract-selection"));
      const input = win.locator(".note-composer-picker input");
      await input.fill("Dest");
      await input.press("Enter");
      await expect.poll(() => h.read("Dest.md")).toBe("Dest body\n\nMOVE ME\n");
      await expect
        .poll(() => win.evaluate(() => (window as any).app.getActiveMarkdownView().editor.state.doc.toString()))
        .toBe(expected);
      // The editor change is autosaved to the source note on disk.
      await expect.poll(() => h.read("Source.md"), { timeout: 10_000 }).toBe(expected);
    } finally {
      await h.cleanup();
    }
  });
}

test("Extract via the editor context menu with Shift+Enter prepends; Cmd+Enter creates a templated note", async () => {
  const h = await launch(EXTRACT_FILES);
  try {
    const { win } = h;
    await win.evaluate(() => (window as any).app.noteComposer.update({ template: "Templates/Composer.md" }));
    await selectInEditor(win, "MOVE ME");
    // Right-click inside the selected text to keep it selected.
    const line = win.locator(".cm-line", { hasText: "MOVE ME" });
    await line.click({ button: "right", position: { x: 20, y: 8 } });
    await win.locator(".menu-item", { hasText: "Extract current selection…" }).click();
    const input = win.locator(".note-composer-picker input");
    await input.fill("Dest");
    await input.press("Shift+Enter");
    await expect.poll(() => h.read("Dest.md")).toBe("MOVE ME\n\nDest body\n");

    // Second extraction to a brand new, templated note.
    await selectInEditor(win, "Before");
    await win.evaluate(() => (window as any).app.commands.execute("note-composer:extract-selection"));
    await input.fill("Fresh");
    await input.press("Meta+Enter");
    await expect.poll(() => h.exists("Fresh.md")).toBe(true);
    await expect.poll(() => h.read("Fresh.md")).toMatch(/^From Source to Fresh on \d{4}-\d{2}-\d{2}\n\nBefore\n$/);
    await expect
      .poll(() => win.evaluate(() => (window as any).app.getActiveMarkdownView().editor.state.doc.toString()))
      .toBe("[[Fresh]]\n[[Dest]]\nAfter\n");
  } finally {
    await h.cleanup();
  }
});
