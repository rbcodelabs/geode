import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
const repo = path.resolve(__dirname, "../..");
const originalSource = "---\npriority: 2\n---\nOriginal source\n";
const originalOuter = "---\nstatus: old\n---\n# Outer\n\n![[Board.canvas]]\n\nEnd\n";

for (const mode of ["Reading", "Live Preview"] as const) {
  test(`${mode} preserves a dirty property transaction and nested draft when explicit replacement refuses`, async ({}, info) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-native-daily-"));
    const vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
    fs.mkdirSync(vault); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(vault, "Source.md"), originalSource);
    fs.writeFileSync(path.join(vault, "Outer.md"), originalOuter);
    fs.writeFileSync(path.join(vault, "Host.md"), "![[Tasks.base]]\n");
    fs.writeFileSync(path.join(vault, "Tasks.base"), "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n");
    fs.writeFileSync(path.join(vault, "Board.canvas"), JSON.stringify({ nodes: [{ id: "owned", type: "file", x: 0, y: 0, width: 760, height: 600, file: "Host.md" }], edges: [] }));
    fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
    const app = await electron.launch({ args: [repo, `--user-data-dir=${profile}`], cwd: repo });
    const page = await app.firstWindow();
    const text = () => page.evaluate(() => (window as any).app.getActiveMarkdownView().getText() as string);
    try {
      await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
      await page.locator('.nav-file-title[data-path="Outer.md"]').click();
      if (mode === "Reading") await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
      expect(await page.evaluate(() => (window as any).app.commands.execute("file-properties:open"))).toBe(true);
      const property = page.locator(".file-properties-view").getByLabel("Value: status", { exact: true });
      await expect(property).toHaveValue("old"); await property.fill("fresh");
      await page.evaluate(() => { const editor = (window as any).app.getActiveMarkdownView().editor; editor.dispatch({ changes: { from: editor.state.doc.length, insert: "Dirty body\n" } }); });
      await property.press("Enter");
      const dirty = originalOuter + "Dirty body\n", edited = dirty.replace("status: old", "status: fresh");
      await expect.poll(text).toBe(edited);
      if (mode === "Reading") await expect(page.locator(".markdown-reading-view .metadata-value").first()).toHaveText("fresh");
      const table = page.locator(".canvas-embed-view:visible .bases-table"); await expect(table).toBeVisible();
      const column = (await table.locator("thead th").allTextContents()).indexOf("note.priority"); expect(column).toBeGreaterThan(-1);
      const cell = table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column);
      await expect(cell).toHaveText("2"); await cell.click(); await page.keyboard.press("Enter");
      const input = cell.locator(".bases-cell-input"); await expect(input).toBeVisible(); await input.fill("9");
      await input.evaluate(el => { (window as any).__combinedDraft = el; });
      expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource);
      const refusal = await page.evaluate(async mode => {
        const view = (window as any).app.getActiveMarkdownView();
        try { await (mode === "Reading" ? view.renderReading() : view.toggleSource()); return null; }
        catch (error) { return String(error); }
      }, mode);
      expect(refusal).toMatch(/draft|edit|finish/i);
      expect(await page.evaluate(() => { const input = (window as any).__combinedDraft; return { connected: input.isConnected, value: input.value }; })).toEqual({ connected: true, value: "9" });
      expect(await text()).toBe(edited); expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource);
      await page.screenshot({ path: info.outputPath("retained-property-and-native-draft.png") });
      await input.press("Enter"); await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource.replace("priority: 2", "priority: 9"));
      if (mode === "Reading") await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
      await page.locator(".cm-content").focus(); await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(text).toBe(dirty);
      await expect.poll(() => fs.readFileSync(path.join(vault, "Outer.md"), "utf8")).toBe(dirty);
    } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
