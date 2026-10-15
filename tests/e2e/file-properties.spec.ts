import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
const root = path.resolve(__dirname, "../..");

test("file properties share the live note buffer, preserve unsaved body, validate and undo", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-properties-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-properties-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), '---\r\nstatus: old\r\ncount: 2\r\naliases: ["one, two", three]\r\n---\r\nBody\r\n');
  fs.writeFileSync(path.join(vault, "Other.md"), '---\nstatus: other\n---\nOther body');
  fs.writeFileSync(path.join(vault, "Broken.md"), '---\na: 1\na: 2\n---\nPreserve');
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.locator('.nav-file-title[data-path="Note.md"]').click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
    await page.locator(".prompt-input").fill("Show file properties");
    await page.locator(".prompt-result").filter({ hasText: "Show file properties" }).click();
    const pane = page.locator(".file-properties-view");
    await expect(pane.getByLabel("Value: status", { exact: true })).toHaveValue("old");
    await page.evaluate(() => {
      const view = (window as any).app.getActiveMarkdownView();
      view.editor.dispatch({ changes: { from: view.editor.state.doc.length, insert: "unsaved addition" } });
    });
    await pane.getByLabel("Value: status", { exact: true }).fill("new");
    await pane.getByLabel("Value: status", { exact: true }).press("Enter");
    await expect(page.locator(".cm-editor").getByLabel("Value: status", { exact: true })).toHaveValue("new");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("unsaved addition");
    // The content container also contains property buttons; focus a real body line.
    await page.locator(".cm-line").filter({ hasText: /^Body$/ }).click();
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(pane.getByLabel("Value: status", { exact: true })).toHaveValue("old");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toMatch(/^status: old$/m);
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("unsaved addition");
    const number = pane.getByLabel("Value: count", { exact: true });
    await number.fill("not a number"); await number.press("Enter");
    await expect(pane.getByRole("alert")).toContainText("finite number");
    await expect(number).toBeFocused(); await expect(number).toHaveValue("not a number");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().getText())).toContain("count: 2");
    await number.fill("4"); await number.press("Enter");
    await expect(pane.getByLabel("Value: count", { exact: true })).toBeFocused();
    const status = pane.getByLabel("Value: status", { exact: true });
    await status.fill("draft");
    await page.evaluate(() => { const app = (window as any).app; app.metadataCache.trigger("changed", app.workspace.getActiveFile()); });
    await expect(status).toHaveValue("draft"); await expect(status).toBeFocused();
    await status.press("Escape"); await expect(pane.getByLabel("Value: status", { exact: true })).toHaveValue("old");
    await pane.getByLabel("Property name: status", { exact: true }).fill("count");
    await pane.getByLabel("Property name: status", { exact: true }).press("Enter");
    await expect(pane.getByRole("alert")).toContainText("already exists");
    await pane.getByLabel("Property name: status", { exact: true }).fill("status");
    await pane.getByLabel("Property name: status", { exact: true }).press("Enter");
    await expect(pane.getByLabel("Value: aliases item 1", { exact: true })).toHaveValue("one, two");
    const screenshots = path.join(root, "docs/screenshots/properties-p1"); fs.mkdirSync(screenshots, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.screenshot({ path: path.join(screenshots, "live-preview.png") });
    await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)", exact: true }).click();
    await pane.getByLabel("Value: status", { exact: true }).fill("reading");
    await pane.getByLabel("Value: status", { exact: true }).press("Enter");
    await expect(page.locator(".markdown-reading-view .metadata-table")).toContainText("reading");
    expect(await page.evaluate(() => (window as any).app.getActiveMarkdownView().mode)).toBe("reading");
    await page.screenshot({ path: path.join(screenshots, "desktop.png") });
    await page.setViewportSize({ width: 920, height: 680 });
    await expect(pane.getByLabel("Value: aliases item 1", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "narrow.png") });
    await page.locator('.nav-file-title[data-path="Other.md"]').click();
    await expect(pane.getByLabel("Value: status", { exact: true })).toHaveValue("other");
    await page.locator('.nav-file-title[data-path="Broken.md"]').click();
    await expect(pane.getByRole("alert")).toContainText("valid YAML");
    await expect(pane.getByRole("button", { name: "Edit source", exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(vault, "Broken.md"), "utf8")).toContain('a: 1\na: 2');
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }
});


test("file properties opens safely for the checked-in demo vault", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-properties-demo-ud-"));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-properties-demo-"));
  fs.cpSync(path.join(root, "test-vault"), vault, { recursive: true });
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const before = fs.readFileSync(path.join(vault, "Welcome.md"), "utf8");
  const app = await electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
  try {
    const page = await app.firstWindow(); await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
    await page.locator(".prompt-input").fill("Show file properties");
    await page.locator(".prompt-result").filter({ hasText: "Show file properties" }).click();
    await expect(page.locator(".file-properties-view").getByLabel("Value: aliases item 1", { exact: true })).toHaveValue("Start Here");
    await expect(page.locator(".file-properties-view").getByLabel("Value: tags item 1", { exact: true })).toHaveValue("intro");
    expect(fs.readFileSync(path.join(vault, "Welcome.md"), "utf8")).toBe(before);
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }
});
