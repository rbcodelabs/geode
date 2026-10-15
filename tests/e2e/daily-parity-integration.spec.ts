import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repo = path.resolve(__dirname, "../..");
const note = "---\nstatus: old\n---\n# Parent\nWorld map[^a]\n\n[^a]: First note\n# Next\nalpha\nbravo\n";
async function fixture(run: (page: Page, vault: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-daily-integration-"));
  const vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(vault, "Note.md"), note.replace(/\n/g, "\r\n"));
  fs.writeFileSync(path.join(vault, "Atlas.md"), "---\naliases: [World map]\n---\n# Atlas\n");
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repo, `--user-data-dir=${profile}`], cwd: repo });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Note.md"]').click();
    await run(page, vault);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
const text = (page: Page) => page.evaluate(() => (window as any).app.getActiveMarkdownView().getText() as string);
async function undo(page: Page) { await page.locator(".cm-content").focus(); await page.keyboard.press("ControlOrMeta+z"); }
async function command(page: Page, id: string) {
  expect(await page.evaluate(id => (window as any).app.commands.execute(id), id)).toBe(true);
}

test("properties, outgoing links and Footnotes share dirty source and isolated undo with CRLF autosave", async () => {
  await fixture(async (page, vault) => {
    await command(page, "file-properties:open");
    const property = page.locator(".file-properties-view").getByLabel("Value: status", { exact: true });
    await expect(property).toHaveValue("old"); await property.fill("new");
    await page.evaluate(() => {
      const view = (window as any).app.getActiveMarkdownView();
      view.editor.dispatch({ changes: { from: view.editor.state.doc.length, insert: "Dirty body\n" } });
    });
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).not.toContain("Dirty body");
    await property.press("Enter");
    await expect.poll(() => text(page)).toContain("status: new");
    await undo(page); await expect.poll(() => text(page)).toBe(note + "Dirty body\n");

    await command(page, "outgoing-links:open");
    const link = page.locator(".outgoing-links-view.mod-active").getByRole("button", { name: "Link World map to Atlas.md", exact: true });
    await expect(link).toBeVisible(); await link.click();
    await expect.poll(() => text(page)).toContain("[[Atlas|World map]][^a]");
    await undo(page); await expect.poll(() => text(page)).toBe(note + "Dirty body\n");

    await page.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await page.getByLabel("Enable Footnotes", { exact: true }).check(); await page.keyboard.press("Escape");
    await command(page, "footnotes:open");
    const footnote = page.locator(".footnotes-view").getByRole("button", { name: "Edit footnote 1", exact: true });
    await expect(footnote).toContainText("First note"); await footnote.click();
    await page.keyboard.insertText("Changed note");
    await expect(footnote).toContainText("Changed note");
    await undo(page); await expect.poll(() => text(page)).toBe(note + "Dirty body\n");
    await footnote.click(); await page.keyboard.insertText("Saved note");
    const expected = (note + "Dirty body\n").replace("[^a]: First note", "[^a]: Saved note").replace(/\n/g, "\r\n");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(expected);
    expect(fs.readFileSync(path.join(vault, "Atlas.md"), "utf8")).toBe("---\naliases: [World map]\n---\n# Atlas\n");
  });
});

test("folding and multiple-selection formatting retain property edits and both settings surfaces", async () => {
  await fixture(async (page, vault) => {
    await page.evaluate(() => (window as any).app.setting.openTabById("editor"));
    await expect(page.locator(".setting-item-name", { hasText: "Fold heading" })).toBeVisible();
    await page.evaluate(() => (window as any).app.setting.openTabById("files-and-links"));
    await expect(page.getByRole("textbox", { name: "Excluded files", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await command(page, "file-properties:open");
    const property = page.locator(".file-properties-view").getByLabel("Value: status", { exact: true });
    await property.fill("new"); await property.press("Enter");
    const changed = note.replace("status: old", "status: new");
    await expect.poll(() => text(page)).toBe(changed);
    await command(page, "editor:fold-all");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getState().folding.ranges.length)).toBe(2);
    await command(page, "editor:unfold-all");
    await page.evaluate(() => {
      const editor = (window as any).app.getActiveMarkdownView().editor, source = editor.state.doc.toString();
      const Selection = editor.state.selection.constructor;
      const first = source.indexOf("alpha"), second = source.indexOf("bravo");
      editor.dispatch({ selection: Selection.create([Selection.range(first, first + 5), Selection.range(second + 5, second)], 1) });
      editor.focus();
    });
    await page.keyboard.press("ControlOrMeta+b");
    await expect.poll(() => text(page)).toBe(changed.replace("alpha\nbravo", "**alpha**\n**bravo**"));
    await undo(page); await expect.poll(() => text(page)).toBe(changed);
    await expect(property).toHaveValue("new");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(changed.replace(/\n/g, "\r\n"));
  });
});
