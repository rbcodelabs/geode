import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

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
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
