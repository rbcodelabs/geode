import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
const root = path.resolve(__dirname, "../..");
const NOTE = '---\nDue: "2026-10-14T22:49:31"\nDay: "2026-10-14"\ndone: null\n---\nBody\n';
async function fixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-property-types-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-property-types-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), NOTE); fs.writeFileSync(path.join(vault, "Other.md"), NOTE);
  fs.mkdirSync(path.join(vault, ".geode")); fs.writeFileSync(path.join(vault, ".geode/types.json"), JSON.stringify({ future: 1, types: { alien: "future-type" } }));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const launch = async () => { const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root }); const page = await app.firstWindow(); await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady); return { app, page }; };
  return { vault, userData, launch, cleanup: () => { fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); } };
}
async function openProperties(page: import("@playwright/test").Page) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
  await page.locator(".prompt-input").fill("Show file properties"); await page.locator(".prompt-result").filter({ hasText: "Show file properties" }).click();
  return page.locator(".file-properties-view");
}

test("property types share plugin/UI state, preserve local seconds and dirty body, undo and restart", async () => {
  const data = await fixture(); let { app, page } = await data.launch();
  try {
    await page.locator('.nav-file-title[data-path="Note.md"]').click(); const pane = await openProperties(page);
    await pane.getByLabel("Type: Due", { exact: true }).selectOption("datetime");
    await expect(page.locator(".cm-editor").getByLabel("Type: Due", { exact: true })).toHaveValue("datetime");
    expect(await page.evaluate(() => (window as any).app.metadataTypeManager.getPropertyInfo("DUE").type)).toBe("datetime");
    await page.evaluate(() => { const app = (window as any).app; app.metadataTypeManager.setType("Day", "date"); app.metadataTypeManager.setType("done", "checkbox"); const view = app.getActiveMarkdownView(); view.editor.dispatch({ changes: { from: view.editor.state.doc.length, insert: "Dirty body" } }); });
    await expect(pane.getByLabel("Value: Day", { exact: true })).toHaveAttribute("type", "date");
    await expect(pane.getByLabel("Value: Due", { exact: true })).toHaveValue("2026-10-14T22:49:31");
    await pane.getByLabel("Value: Due", { exact: true }).fill("2026-10-15T08:30:42"); await pane.getByLabel("Value: Due", { exact: true }).press("Enter");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("Dirty body");
    await page.locator(".cm-line").filter({ hasText: /^Body$/ }).click(); await expect(page.locator(".cm-content")).toBeFocused(); await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(pane.getByLabel("Value: Due", { exact: true })).toHaveValue("2026-10-14T22:49:31");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("2026-10-14T22:49:31");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("Dirty body");
    await page.evaluate(() => (window as any).app.propertyTypes.flush());
    await expect.poll(() => fs.readFileSync(path.join(data.vault, "Note.md"), "utf8")).toContain("Dirty body");
    if (process.env.PROPERTY_TYPES_SCREENSHOTS === "1") {
      const dir = path.join(root, "docs/screenshots/property-types"); fs.mkdirSync(dir, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: path.join(dir, "desktop.png") });
      await page.setViewportSize({ width: 960, height: 760 }); await page.screenshot({ path: path.join(dir, "compact.png") });
    }
    await app.close(); ({ app, page } = await data.launch()); await page.locator('.nav-file-title[data-path="Other.md"]').click(); const reopened = await openProperties(page);
    await expect(reopened.getByLabel("Type: Due", { exact: true })).toHaveValue("datetime");
    await expect(reopened.getByLabel("Value: Due", { exact: true })).toHaveAttribute("type", "datetime-local");
    const saved = JSON.parse(fs.readFileSync(path.join(data.vault, ".geode/types.json"), "utf8")); expect(saved).toMatchObject({ future: 1, types: { alien: "future-type", due: "datetime", day: "date", done: "checkbox" } });
  } finally { await app.close(); data.cleanup(); }
});

test("property type write failure reports a notice and restores the saved assignment without editing notes", async () => {
  const data = await fixture(); const { app, page } = await data.launch();
  try {
    await page.locator('.nav-file-title[data-path="Note.md"]').click(); const pane = await openProperties(page);
    await page.evaluate(() => { const app = (window as any).app, write = app.host.config.write.bind(app.host.config); app.host.config.write = async (name: string, value: unknown) => { if (name === "types") { await new Promise(resolve => setTimeout(resolve, 100)); throw new Error("synthetic storage failure"); } return write(name, value); }; });
    await pane.getByLabel("Type: Due", { exact: true }).selectOption("datetime");
    await expect(page.locator(".notice", { hasText: "Could not save property types" })).toBeVisible();
    await expect(pane.getByLabel("Type: Due", { exact: true })).toHaveValue("text");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toBe(NOTE);
    expect(fs.readFileSync(path.join(data.vault, "Note.md"), "utf8")).toBe(NOTE);
  } finally { await app.close(); data.cleanup(); }
});
