import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
async function launch() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-outgoing-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-outgoing-ud-"));
  fs.mkdirSync(path.join(vaultDir, "a")); fs.mkdirSync(path.join(vaultDir, "b"));
  fs.writeFileSync(path.join(vaultDir, "Source.md"), "# Source\n\nA World map and Atlas.\n\n[[Missing]] [[Missing]]\n\n```\nWorld map\n```\n");
  fs.writeFileSync(path.join(vaultDir, "a/Atlas.md"), "---\naliases: [World map]\n---\n# Atlas\n");
  fs.writeFileSync(path.join(vaultDir, "b/Atlas.md"), "# Other atlas\n");
  fs.writeFileSync(path.join(vaultDir, "Page.html"), "<h1>Fileless</h1>");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  await window.locator('.nav-file-title[data-path="Source.md"]').click();
  await window.locator('.workspace-sidebar.mod-right [data-type="outgoing-links"]').click();
  const pane = window.locator(".outgoing-links-view.mod-active");
  return { app, window, pane, vaultDir, cleanup: async () => { await app.close(); fs.rmSync(vaultDir, { recursive: true, force: true }); fs.rmSync(userDataDir, { recursive: true, force: true }); } };
}

test("follows active notes, converts aliases from unsaved text with undo and persists the live buffer", async ({}, testInfo) => {
  const { window, pane, vaultDir, cleanup } = await launch();
  try {
    await expect(pane).toContainText("Links (2)");
    const alias = pane.getByRole("button", { name: "Link World map to a/Atlas.md", exact: true });
    await expect(alias).toHaveCount(2);
    await expect(pane.getByRole("button", { name: "Link Atlas to a/Atlas.md", exact: true })).toHaveAttribute("title", "a/Atlas.md");
    await expect(pane.getByRole("button", { name: "Link Atlas to b/Atlas.md", exact: true })).toHaveAttribute("title", "b/Atlas.md");
    // Make an unsaved edit through the actual editor, then convert the recomputed row.
    await window.evaluate(() => { const view = (window as any).app.getActiveMarkdownView(); view.editor.dispatch({ changes: { from: 0, insert: "Unsaved prefix\n\n" } }); });
    await expect(pane.locator(".outgoing-links-status")).toHaveText("");
    await alias.first().click();
    const text = () => window.evaluate(() => (window as any).app.getActiveMarkdownView().getText() as string);
    await expect.poll(text).toContain("Unsaved prefix\n\n# Source\n\nA [[a/Atlas|World map]] and Atlas.");
    await expect(pane).toContainText("Links (3)");
    // Undo via normal command dispatch in the active editor.
    await window.locator(".cm-content").focus(); await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(text).not.toContain("[[a/Atlas|World map]]");
    await expect(pane.locator(".outgoing-links-status")).toHaveText("");
    await alias.first().click();
    await expect.poll(() => fs.readFileSync(path.join(vaultDir, "Source.md"), "utf8")).toContain("Unsaved prefix\n\n# Source\n\nA [[a/Atlas|World map]] and Atlas.");
    // The remaining alias is in fenced code: conversion is allowed, graph stays unchanged.
    await alias.focus(); await window.keyboard.press("Space"); await expect(pane).toContainText("Links (3)");
    await expect(alias).toHaveCount(0);
    fs.mkdirSync(path.join(repoRoot, "docs/screenshots"), { recursive: true });
    await window.screenshot({ path: path.join(repoRoot, "docs/screenshots/outgoing-links-desktop.png") });
    await window.setViewportSize({ width: 960, height: 760 });
    await window.screenshot({ path: path.join(repoRoot, "docs/screenshots/outgoing-links-compact.png") });
    await testInfo.attach("outgoing-links", { body: await window.screenshot(), contentType: "image/png" });
    await pane.getByRole("button", { name: "World map — a/Atlas.md", exact: true }).click();
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("a/Atlas.md");
    await expect(pane).toContainText("No outgoing links found.");
    await window.locator('.nav-file-title[data-path="Page.html"]').click();
    await expect(pane).toContainText("No file is open.");
  } finally { await cleanup(); }
});

test("exclusions filter targets, invalid patterns preserve settings, and a reopened command reuses the pane", async () => {
  const { window, pane, cleanup } = await launch();
  try {
    await window.evaluate(() => (window as any).app.setting.openTabById("files-and-links"));
    await window.getByRole("textbox", { name: "Excluded files", exact: true }).fill("a/");
    await window.getByRole("button", { name: "Save exclusions", exact: true }).click();
    await expect(window.getByRole("status").filter({ hasText: "Exclusions saved." })).toBeVisible();
    await window.getByRole("textbox", { name: "Excluded files", exact: true }).fill("/(a+)+/");
    await window.getByRole("button", { name: "Save exclusions", exact: true }).click();
    await expect(window.getByRole("status").filter({ hasText: "Groups" })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(pane.getByRole("button", { name: "Link Atlas to a/Atlas.md", exact: true })).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Link Atlas to b/Atlas.md", exact: true })).toBeVisible();
    await window.locator('.workspace-sidebar.mod-right [data-type="outline"]').click();
    await window.evaluate(() => (window as any).app.commands.execute("outgoing-links:open"));
    await expect(pane).toBeVisible();
    await expect(window.locator('.workspace-sidebar.mod-right [data-type="outgoing-links"]')).toHaveCount(1);
  } finally { await cleanup(); }
});
