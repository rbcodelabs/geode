import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
const root = path.resolve(__dirname, "../..");
const original = "---\nstatus: old\ncount: 4\n---\nBody\n";
async function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-properties-transition-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-properties-transition-user-"));
  fs.writeFileSync(path.join(vault, "Note.md"), original);
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
  const page = await app.firstWindow(); await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  await page.locator('.nav-file-title[data-path="Note.md"]').click();
  await page.evaluate(() => (window as any).app.commands.execute("file-properties:open"));
  const pane = page.locator(".file-properties-view");
  await expect(pane.getByLabel("Value: status", { exact: true })).toHaveValue("old");
  return { app, page, pane, file: path.join(vault, "Note.md"), cleanup: async () => { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); } };
}
test("a field refused during Reading replacement stays reachable until explicit retry or discard", async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const view = (window as any).app.getActiveMarkdownView();
      const flush = view.flush.bind(view);
      view.flush = async () => {
        view.flush = flush; (window as any).__propertiesFlushEntered = true;
        await new Promise<void>(resolve => { (window as any).__releasePropertiesFlush = resolve; });
        return flush();
      };
    });
    await f.page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)", exact: true }).click();
    await f.page.waitForFunction(() => (window as any).__propertiesFlushEntered && (window as any).app.getActiveMarkdownView().bodyEl.inert);
    const field = f.pane.getByLabel("Value: status", { exact: true });
    await field.fill("reading"); await field.press("Enter");
    await expect(f.pane.getByRole("alert")).toContainText("read-only");
    expect(await f.page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("status: old");
    expect(fs.readFileSync(f.file, "utf8")).toBe(original);
    await field.evaluate(element => { (window as any).__rejectedPropertiesField = element; });
    await f.page.evaluate(() => (window as any).__releasePropertiesFlush());
    await f.page.waitForFunction(() => { const view = (window as any).app.getActiveMarkdownView(); return view.mode === "reading" && !view.bodyEl.inert; });
    await f.pane.getByLabel("Value: count", { exact: true }).focus();
    await f.page.evaluate(() => { const app = (window as any).app; app.metadataCache.trigger("changed", app.workspace.getActiveFile()); });
    await expect(field).toHaveValue("reading");
    expect(await f.page.evaluate(() => (window as any).__rejectedPropertiesField.isConnected)).toBe(true);
    expect(await f.page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("status: old");
    await field.press("Enter");
    await expect(f.page.locator(".markdown-reading-view .metadata-table")).toContainText("reading");
    await expect.poll(() => fs.readFileSync(f.file, "utf8")).toContain("status: reading");
    expect(fs.readFileSync(f.file, "utf8")).toContain("Body\n");
    expect(await f.page.evaluate(() => (window as any).app.getActiveMarkdownView().mode)).toBe("reading");
  } finally {
    await f.page.evaluate(() => (window as any).__releasePropertiesFlush?.()).catch(() => {});
    await f.cleanup();
  }
});
test("accepted same-turn Reading edits publish the latest buffer and retain independent undo", async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(async () => { const view = (window as any).app.getActiveMarkdownView(); await view.toggleMode(); });
    const accepted = await f.page.evaluate(() => {
      const view = (window as any).app.getActiveMarkdownView(); const results: boolean[] = [];
      for (const [before, after] of [["old", "one"], ["one", "two"], ["two", "three"]]) {
        const snapshot = view.getText(), from = snapshot.indexOf(`status: ${before}`) + "status: ".length;
        results.push(view.applySourceEdit(snapshot, from, from + before.length, after, { allowReading: true }));
      }
      return results;
    });
    expect(accepted).toEqual([true, true, true]);
    await expect(f.page.locator(".markdown-reading-view .metadata-table")).toContainText("three");
    await expect.poll(() => fs.readFileSync(f.file, "utf8")).toContain("status: three");
    await f.page.evaluate(async () => { const view = (window as any).app.getActiveMarkdownView(); await view.toggleMode(); await view.toggleSource(); });
    await f.page.locator(".cm-content").focus(); await f.page.keyboard.press("ControlOrMeta+z");
    expect(await f.page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("status: two");
    await f.page.keyboard.press("ControlOrMeta+z");
    expect(await f.page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("status: one");
  } finally { await f.cleanup(); }
});
