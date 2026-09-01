import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const modifier = process.platform === "darwin" ? "Meta" : "Control";

const manifest = {
  id: "editor-command-probe",
  name: "Editor Command Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises editor-aware command routing.",
  author: "Geode",
};

const mainJs = String.raw`
  const { Plugin } = require('obsidian');
  module.exports.default = class extends Plugin {
    onload() {
      window.__editorCommandProbe = { checks: 0, events: [] };
      const record = (path, editor, context) => {
        window.__editorCommandProbe.events.push({
          path,
          sameEditor: editor === context.editor,
          activeView: context === this.app.workspace.activeLeaf.view,
          mode: context.mode,
          file: context.file && context.file.path,
        });
      };
      const append = (editor, text) => editor.dispatch({
        changes: { from: editor.state.doc.length, insert: '\n' + text },
      });

      this.addCommand({
        id: 'palette-editor',
        name: 'Palette editor callback',
        editorCallback: (editor, context) => {
          record('palette', editor, context);
          append(editor, 'palette callback ran');
        },
      });
      this.addCommand({
        id: 'hotkey-editor-check',
        name: 'Hotkey editor check callback',
        hotkeys: [{ modifiers: ['Mod'], code: 'KeyJ' }],
        editorCheckCallback: (checking, editor, context) => {
          if (checking) {
            window.__editorCommandProbe.checks += 1;
            return true;
          }
          record('hotkey', editor, context);
          append(editor, 'hotkey callback ran');
        },
      });
      this.addCommand({
        id: 'programmatic-editor',
        name: 'Programmatic editor callback',
        editorCallback: (editor, context) => record('programmatic', editor, context),
      });
    }
  };
`;

test("real plugin editor commands share the active Markdown editor across palette, hotkey, and programmatic paths", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-editor-command-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-editor-command-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Editor command probe\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", manifest.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(pluginDir, "main.js"), mainJs);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([manifest.id]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const consoleErrors: string[] = [];
  try {
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    window.on("pageerror", (error) => consoleErrors.push(String(error)));

    await expect.poll(() => window.evaluate(() => (window as any).app?.pluginManager?.isEnabled?.("editor-command-probe"))).toBe(true);
    await window.locator('.nav-file-title[data-path="Note.md"]').click();
    await expect(window.locator(".markdown-source-view")).toBeVisible();

    await window.keyboard.press(`${modifier}+P`);
    await window.locator(".prompt-input").fill("Palette editor callback");
    await window.locator(".prompt-result", { hasText: "Editor Command Probe: Palette editor callback" }).click();
    await expect(window.locator(".cm-content")).toContainText("palette callback ran");

    await window.keyboard.press(`${modifier}+J`);
    await expect(window.locator(".cm-content")).toContainText("hotkey callback ran");

    expect(await window.evaluate(() => (window as any).app.commands.executeCommandById("editor-command-probe:programmatic-editor"))).toBe(true);
    expect(await window.evaluate(() => (window as any).__editorCommandProbe.events)).toEqual([
      { path: "palette", sameEditor: true, activeView: true, mode: "live", file: "Note.md" },
      { path: "hotkey", sameEditor: true, activeView: true, mode: "live", file: "Note.md" },
      { path: "programmatic", sameEditor: true, activeView: true, mode: "live", file: "Note.md" },
    ]);

    // Raw source mode is still an editing MarkdownView and must route the
    // exact source-mode editor/view pair.
    await window.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.activeLeaf.view.mode)).toBe("source");
    expect(await window.evaluate(() => (window as any).app.commands.executeCommandById("editor-command-probe:programmatic-editor"))).toBe(true);
    await expect.poll(() => window.evaluate(() => (window as any).__editorCommandProbe.events.at(-1))).toEqual(
      { path: "programmatic", sameEditor: true, activeView: true, mode: "source", file: "Note.md" },
    );

    // A reading-mode MarkdownView retains an internal CM instance, but editor commands are unavailable.
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    await expect(window.locator(".markdown-reading-view")).toBeVisible();
    const beforeReading = await window.evaluate(() => (window as any).__editorCommandProbe.events.length);
    await window.keyboard.press(`${modifier}+P`);
    await window.locator(".prompt-input").fill("Palette editor callback");
    await expect(window.locator(".prompt-result", { hasText: "Editor Command Probe: Palette editor callback" })).toHaveCount(0);
    await window.keyboard.press("Escape");
    expect(await window.evaluate(() => (window as any).app.commands.executeCommandById("editor-command-probe:programmatic-editor"))).toBe(false);
    await window.keyboard.press(`${modifier}+J`);
    expect(await window.evaluate(() => (window as any).__editorCommandProbe.events.length)).toBe(beforeReading);

    // A non-Markdown active leaf is also unavailable through every path.
    await window.evaluate(async () => {
      const geodeApp = (window as any).app;
      await geodeApp.workspace.activeLeaf.setView(geodeApp.createEmptyView());
    });
    expect(await window.evaluate(() => (window as any).app.commands.executeCommandById("editor-command-probe:programmatic-editor"))).toBe(false);
    await window.keyboard.press(`${modifier}+P`);
    await window.locator(".prompt-input").fill("Palette editor callback");
    await expect(window.locator(".prompt-result", { hasText: "Editor Command Probe: Palette editor callback" })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await window.keyboard.press(`${modifier}+J`);
    expect(await window.evaluate(() => (window as any).__editorCommandProbe.events.length)).toBe(beforeReading);

    await window.evaluate(() => (window as any).app.pluginManager.disable("editor-command-probe", { persist: false }));
    expect(await window.evaluate(() => Object.keys((window as any).app.commands.commands).some((id) => id.startsWith("editor-command-probe:")))).toBe(false);
    expect(await window.evaluate(() => (window as any).app.commands.executeCommandById("editor-command-probe:programmatic-editor"))).toBe(false);
    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
