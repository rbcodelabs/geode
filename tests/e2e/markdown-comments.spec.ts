import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createCommentMarkers } from "../../src/renderer/comments/model";

const repoRoot = path.resolve(__dirname, "..", "..");

test("comments persist on disk, decorate Live Preview, hide in Reading view, and expose the geode API", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-comments-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-comments-ud-"));
  const notePath = path.join(vaultDir, "Review.md");
  fs.writeFileSync(notePath, "# Review\r\n\r\nComment this passage.\r\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "comment-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id: "comment-probe", name: "Comment probe", version: "1.0.0", minAppVersion: "0.1.0", description: "Probes the comments API", author: "Geode" }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), `const geode = require("geode"); module.exports.default = class extends geode.Plugin { onload() { window.__commentApiProbe = { service: typeof geode.CommentService, app: typeof this.app.comments.create }; } };`);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["comment-probe"]));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.locator('.nav-file-title[data-path="Review.md"]').click();
    await expect.poll(() => window.evaluate(() => (window as any).app?.pluginManager?.isEnabled?.("comment-probe"))).toBe(true);
    expect(await window.evaluate(() => (window as any).app.pluginManager.getLoadError("comment-probe") ?? null)).toBeNull();
    await expect.poll(() => window.evaluate(() => (window as any).__commentApiProbe)).toEqual({ service: "function", app: "function" });
    const created = await window.evaluate(async () => {
      const app = (window as any).app;
      const view = app.getActiveMarkdownView();
      const source = view.getText();
      const from = source.indexOf("Comment this passage");
      const thread = await app.comments.create(view.file, { from, to: from + "Comment this passage".length }, "<img src=x onerror=alert(1)>", { type: "agent", name: "Claude" });
      await app.comments.reply(view.file, thread.id, "Human reply", { type: "user", name: "Rick" });
      return thread.id;
    });

    await expect(window.locator(`.cm-comment-anchor[data-comment-id="${created}"]`)).toHaveText("Comment this passage");
    expect(await window.locator(".cm-editor").innerText()).not.toContain("geode-comment:v1");
    await expect.poll(() => fs.readFileSync(notePath, "utf8")).toContain("<!-- geode-comment:v1");
    expect(fs.readFileSync(notePath, "utf8")).toContain("\r\n");

    const commentsTab = window.locator('.workspace-sidebar.mod-right .workspace-tab-header[aria-label="Comments"]');
    await commentsTab.click();
    const pane = window.locator(".comments-view");
    await expect(pane.getByText("Claude · Agent")).toBeVisible();
    await expect(pane.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
    await expect(pane.locator("img")).toHaveCount(0);
    await expect(pane.getByText("Rick", { exact: true })).toBeVisible();

    await window.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    await expect(window.locator(".cm-editor")).toContainText("geode-comment:v1");
    await window.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    await expect(window.locator(".markdown-reading-view")).toContainText("Comment this passage");
    expect(await window.locator(".markdown-reading-view").innerText()).not.toContain("geode-comment");
    await pane.locator(".comment-anchor-preview").click();
    await expect(window.locator(`.cm-comment-anchor[data-comment-id="${created}"]`)).toBeVisible();
    expect(await window.locator(".cm-editor").innerText()).not.toContain("geode-comment:v1");
    await window.locator(`.cm-comment-anchor[data-comment-id="${created}"]`).click();
    await expect(pane.locator(`.comment-thread[data-comment-id="${created}"]`)).toHaveClass(/is-active/);
    await expect(pane.locator(`.comment-thread[data-comment-id="${created}"]`)).toBeFocused();

    // Create and manage a second thread through the actual selection/prompt/sidebar UI.
    await expect(window.getByRole("status", { name: "External edit conflict" })).toHaveCount(0);
    await window.evaluate(() => {
      const view = (window as any).app.getActiveMarkdownView();
      const source = view.getText();
      const from = source.lastIndexOf(".");
      view.editor.dispatch({ selection: { anchor: from, head: from + 1 }, scrollIntoView: true });
    });
    await window.locator(".comment-selection-button").click();
    await window.locator(".prompt-input").fill("UI thread");
    await window.locator(".prompt-input").press("Enter");
    const uiThread = pane.locator(".comment-thread", { hasText: "UI thread" });
    await expect(uiThread).toBeVisible();
    await uiThread.getByRole("button", { name: "Reply" }).click();
    await window.locator(".prompt-input").fill("UI reply");
    await window.locator(".prompt-input").press("Enter");
    await expect(uiThread.getByText("UI reply", { exact: true })).toBeVisible();
    await uiThread.getByRole("button", { name: "Edit" }).first().click();
    await window.locator(".prompt-input").fill("UI thread edited");
    await window.locator(".prompt-input").press("Enter");
    await expect(uiThread.getByText("UI thread edited", { exact: true })).toBeVisible();
    await uiThread.getByRole("button", { name: "Resolve" }).click();
    await expect(uiThread).toHaveCount(0);
    await pane.getByText("Include resolved").locator("input").check();
    const resolvedThread = pane.locator(".comment-thread", { hasText: "UI thread edited" });
    await resolvedThread.getByRole("button", { name: "Reopen" }).click();
    await expect(resolvedThread.getByRole("button", { name: "Resolve" })).toBeVisible();
    window.once("dialog", (dialog) => dialog.accept());
    await resolvedThread.getByRole("button", { name: "Delete thread" }).click();
    await expect(resolvedThread).toHaveCount(0);

    await window.evaluate(() => {
      const app = (window as any).app;
      const view = app.getActiveMarkdownView();
      const end = view.editor.state.doc.length;
      view.editor.dispatch({ changes: { from: end, insert: '\n<!-- geode-comment:v1 id="broken" data="!!!" -->' } });
      app.comments.trigger("changed", view.file);
    });
    await expect(pane.getByRole("alert")).toContainText("malformed");
    expect(await window.evaluate(async () => {
      const app = (window as any).app;
      const view = app.getActiveMarkdownView();
      try { await app.comments.create(view.file, { from: 0, to: 1 }, "blocked", { type: "user", name: "Rick" }); return "mutated"; }
      catch (error) { return String(error); }
    })).toContain("Repair malformed comment markers");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("plain Enter edits prose inside an existing comment anchor", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-comments-enter-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-comments-enter-ud-"));
  const markers = createCommentMarkers("enter-thread", { messages: [] });
  fs.writeFileSync(path.join(vaultDir, "Review.md"), `# Review\n\n${markers.open}Comment this passage${markers.close}.\n`);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.locator('.nav-file-title[data-path="Review.md"]').click();
    const editor = window.getByRole("textbox", { name: "Note editor" });
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await window.evaluate(() => {
      const app = (window as any).app;
      const view = app.getActiveMarkdownView();
      const thread = app.comments.list(view.file, { includeResolved: true })[0];
      view.editor.focus();
      view.editor.dispatch({ selection: { anchor: thread.from + 7 }, scrollIntoView: true });
    });
    await expect(editor).toBeFocused();

    await window.keyboard.press("Enter");

    expect(await window.evaluate(() => {
      const app = (window as any).app;
      const view = app.getActiveMarkdownView();
      return app.comments.list(view.file, { includeResolved: true })[0].anchorText;
    })).toBe("Comment\nthis passage");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
