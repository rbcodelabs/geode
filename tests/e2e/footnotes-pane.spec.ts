import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
const repoRoot = path.resolve(__dirname, "..", "..");
const NOTE = "---\ntitle: Footnotes\n---\n# Footnotes\n\nA[^a], again[^a], inline^[Inline note], missing[^lost].\n\n[^a]: First note\n    continued\n\n[^unused]: Unreferenced note\n";
function readPersistedJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function hasFootnotesLeaf(node: any): boolean {
  if (!node) return false;
  if (node.type === "tabs") return node.leaves.some((leaf: any) => leaf.type === "footnotes");
  return node.children.some(hasFootnotesLeaf);
}
async function fixture() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-footnotes-pane-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-footnotes-pane-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Notes.md"), NOTE);
  fs.writeFileSync(path.join(vaultDir, "Empty.md"), "# Empty\n");
  fs.writeFileSync(path.join(vaultDir, "Page.html"), "<h1>Fileless</h1>");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const launch = async () => {
    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    const window = await app.firstWindow(); await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    return { app, window };
  };
  return { vaultDir, userDataDir, launch, cleanup: () => { fs.rmSync(vaultDir, { recursive: true, force: true }); fs.rmSync(userDataDir, { recursive: true, force: true }); } };
}

test("Footnotes pane edits real source with undo/autosave, navigation, follow and fileless states", async ({}, testInfo) => {
  const data = await fixture(); const { app, window } = await data.launch();
  try {
    await window.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await window.getByLabel("Enable Footnotes", { exact: true }).check(); await window.keyboard.press("Escape");
    await window.locator('.nav-file-title[data-path="Notes.md"]').click();
    await window.evaluate(() => (window as any).app.commands.execute("footnotes:open"));
    const pane = window.locator(".footnotes-view");
    await expect(pane.getByRole("button", { name: "Edit footnote 1", exact: true })).toContainText("First note");
    await expect(pane).toContainText("2 references"); await expect(pane).toContainText("Definition not found.");
    await expect(pane.getByRole("button", { name: "Edit footnote lost", exact: true })).toBeDisabled();
    await window.evaluate(() => { const view = (window as any).app.getActiveMarkdownView(); view.editor.dispatch({ changes: { from: view.editor.state.doc.length, insert: "\nUnsaved body edit\n" } }); });
    await expect(pane.locator(".footnotes-status")).toHaveText("");
    // Start in Reading mode: click-to-edit must reveal raw Source rather than
    // trying to serialize a second sidebar-owned copy of the note.
    await window.evaluate(() => (window as any).app.getActiveMarkdownView().toggleMode());
    await pane.getByRole("button", { name: "Edit footnote 1", exact: true }).click();
    await expect.poll(() => window.evaluate(() => (window as any).app.getActiveMarkdownView().mode)).toBe("source");
    await window.keyboard.insertText("Changed footnote");
    await expect(pane.getByRole("button", { name: "Edit footnote 1", exact: true })).toContainText("Changed footnote");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(pane.getByRole("button", { name: "Edit footnote 1", exact: true })).toContainText("First note");
    await pane.getByRole("button", { name: "Edit footnote 1", exact: true }).click(); await window.keyboard.insertText("Saved footnote");
    await expect.poll(() => fs.readFileSync(path.join(data.vaultDir, "Notes.md"), "utf8")).toContain("[^a]: Saved footnote");
    expect(fs.readFileSync(path.join(data.vaultDir, "Notes.md"), "utf8")).toContain("Unsaved body edit");
    const jump = pane.getByRole("button", { name: "Go to footnote 2", exact: true }); await jump.focus(); await window.keyboard.press("Space");
    await expect.poll(() => window.evaluate(() => { const view = (window as any).app.getActiveMarkdownView(); return view.editor.state.selection.main.from; })).toBe(NOTE.indexOf("^[Inline note]"));
    if (process.env.FOOTNOTES_SCREENSHOTS === "1") {
      fs.mkdirSync(path.join(repoRoot, "docs/screenshots"), { recursive: true });
      await window.setViewportSize({ width: 1440, height: 900 });
      await window.screenshot({ path: path.join(repoRoot, "docs/screenshots/footnotes-pane-desktop.png") });
      await window.setViewportSize({ width: 960, height: 760 });
      await window.screenshot({ path: path.join(repoRoot, "docs/screenshots/footnotes-pane-compact.png") });
      await testInfo.attach("footnotes-pane", { body: await window.screenshot(), contentType: "image/png" });
    }
    await window.locator('.nav-file-title[data-path="Empty.md"]').click(); await expect(pane).toContainText("No footnotes found.");
    await window.locator('.nav-file-title[data-path="Page.html"]').click(); await expect(pane).toContainText("No file is open.");
  } finally { await app.close(); data.cleanup(); }
});

test("Footnotes core toggle survives restart and fast disable/re-enable leaves one working pane", async () => {
  const data = await fixture(); let { app, window } = await data.launch();
  try {
    expect(await window.evaluate(() => (window as any).app.commands.execute("footnotes:open"))).toBe(false);
    await window.evaluate(async () => { const app = (window as any).app; app.settings.footnotesEnabled = true; await app.syncFootnotesPlugin(); await app.host.config.write("app", app.settings); app.commands.execute("footnotes:open"); });
    await expect(window.locator(".footnotes-view")).toBeVisible();
    // Wait for the actual pane to reach disk before destroying the renderer.
    await expect.poll(() => hasFootnotesLeaf(readPersistedJson(path.join(data.vaultDir, ".geode/workspace.json"))?.right?.root)).toBe(true);
    await app.close(); ({ app, window } = await data.launch());
    await expect(window.locator(".footnotes-view")).toBeVisible();
    await window.evaluate(async () => { const app = (window as any).app; app.settings.footnotesEnabled = false; const off = app.syncFootnotesPlugin(); app.settings.footnotesEnabled = true; const on = app.syncFootnotesPlugin(); await Promise.all([off, on]); app.commands.execute("footnotes:open"); });
    await expect(window.locator(".footnotes-view")).toHaveCount(1);
    await window.evaluate(async () => { const app = (window as any).app; app.settings.footnotesEnabled = false; await app.syncFootnotesPlugin(); await app.host.config.write("app", app.settings); });
    await expect(window.locator(".footnotes-view")).toHaveCount(0);
    expect(await window.evaluate(() => (window as any).app.commands.execute("footnotes:open"))).toBe(false);
    // saveSettings() is deliberately fire-and-forget. Establish the actual disk
    // barrier before destroying the renderer, rather than awaiting its void result.
    await expect.poll(() => readPersistedJson(path.join(data.vaultDir, ".geode/app.json"))?.footnotesEnabled).toBe(false);
    await expect.poll(() => {
      const saved = readPersistedJson(path.join(data.vaultDir, ".geode/workspace.json"));
      return saved ? hasFootnotesLeaf(saved.right?.root) : undefined;
    }).toBe(false);
    await app.close(); ({ app, window } = await data.launch());
    await expect(window.locator(".footnotes-view")).toHaveCount(0);
    expect(await window.evaluate(() => (window as any).app.commands.execute("footnotes:open"))).toBe(false);
  } finally { await app.close(); data.cleanup(); }
});

test("Footnotes settings report a rejected asynchronous write and acknowledge delayed persistence", async () => {
  const data = await fixture(); const { app, window } = await data.launch();
  try {
    await window.evaluate(() => {
      const app = (window as any).app;
      const write = app.host.config.write.bind(app.host.config);
      app.host.config.write = async (name: string, value: unknown) => {
        if (name === "app") { await new Promise(resolve => setTimeout(resolve, 150)); throw new Error("synthetic storage failure"); }
        return write(name, value);
      };
      (window as any).__footnotesOriginalWrite = write;
      app.setting.openTabById("core-plugins");
    });
    const toggle = window.getByLabel("Enable Footnotes", { exact: true });
    await toggle.check();
    await expect(window.locator(".notice", { hasText: "Could not update Footnotes" })).toBeVisible();
    await window.evaluate(() => {
      const app = (window as any).app, write = (window as any).__footnotesOriginalWrite;
      app.host.config.write = async (name: string, value: unknown) => {
        if (name === "app") await new Promise(resolve => setTimeout(resolve, 150));
        return write(name, value);
      };
    });
    await toggle.uncheck();
    await expect.poll(() => readPersistedJson(path.join(data.vaultDir, ".geode/app.json"))?.footnotesEnabled).toBe(false);
    expect(await window.evaluate(() => (window as any).app.commands.execute("footnotes:open"))).toBe(false);
  } finally { await app.close(); data.cleanup(); }
});
