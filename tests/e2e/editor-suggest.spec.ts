import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "editor-suggest-plugin",
  name: "Editor Suggest Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Subclasses EditorSuggest + registers an app.scope hotkey, like obsidian-tasks.",
  author: "geode",
};

/**
 * Reproduces the exact load pattern that used to make obsidian-tasks (and
 * linear-integration) fail to load under Geode:
 *
 *   var pf = class extends obsidian.EditorSuggest {          // module-eval
 *     constructor(app){ super(app); app.scope.register([],"Tab",cb) }  // onload
 *   }
 *   this.registerEditorSuggest(new pf(this.app))
 *
 * Before PR 2a, `EditorSuggest` was not exported (so `class extends undefined`
 * threw at module-eval, before onload) and `app.scope` didn't exist (so the
 * constructor threw). The plugin died before registering its `tasks`
 * code-block processor, so the daily-driver ```tasks render never happened.
 *
 * This fixture ALSO registers a `tasks` code-block processor — mirroring the
 * real plugin — so the test proves the combined win: the plugin loads AND its
 * reading-view processor (PR 1) fires.
 */
const MAIN_JS = `
  const { Plugin, EditorSuggest } = require('geode');

  // Defined at module-eval time — this line alone threw before PR 2a.
  class TasksLikeSuggest extends EditorSuggest {
    constructor(app) {
      super(app);
      // obsidian-tasks does exactly this in its suggest constructor.
      app.scope.register([], 'Tab', () => {
        const editor = this.context && this.context.editor;
        return editor ? false : true;
      });
    }
    onTrigger(cursor, editor, file) { return null; }
    getSuggestions(ctx) { return []; }
    renderSuggestion(value, el) {}
    selectSuggestion(value, evt) {}
  }

  module.exports.default = class EditorSuggestPlugin extends Plugin {
    onload() {
      this.registerEditorSuggest(new TasksLikeSuggest(this.app));
      this.registerMarkdownCodeBlockProcessor('tasks', (source, el, ctx) => {
        el.createEl('div', { cls: 'e2e-tasks', text: 'TASKS:' + source.trim() });
      });
      // Only reached if construction + registration didn't throw.
      this.app.notify('editor-suggest-plugin loaded');
    }
  };
`;

test("a plugin that subclasses EditorSuggest + uses app.scope loads, and its ```tasks processor renders", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-suggest-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-suggest-e2e-"));

  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "editor-suggest-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["editor-suggest-plugin"])
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const consoleErrors: string[] = [];
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    // onload() completed → the EditorSuggest subclass constructed and
    // app.scope.register did not throw. This is the core PR-2a assertion.
    await expect(
      window.locator(".notice", { hasText: "editor-suggest-plugin loaded" })
    ).toBeVisible();

    // The suggest + scope glue landed on the app.
    const state = await window.evaluate(() => {
      const w = window as unknown as {
        app: { scope?: { keys: unknown[] }; editorSuggests?: Set<unknown> };
      };
      return {
        hasScope: !!w.app.scope,
        scopeKeys: w.app.scope?.keys.length ?? -1,
        suggestCount: w.app.editorSuggests?.size ?? -1,
      };
    });
    expect(state.hasScope).toBe(true);
    expect(state.scopeKeys).toBe(1); // the Tab handler
    expect(state.suggestCount).toBe(1); // the registered suggest

    // The plugin's ```tasks processor renders in reading view (PR 1 pipeline,
    // now actually reachable because the plugin loaded).
    await window.evaluate(async () => {
      const w = window as unknown as {
        app: {
          markdownRenderer: {
            render: (src: string, el: HTMLElement, path: string) => Promise<void>;
          };
        };
      };
      const host = document.createElement("div");
      host.id = "e2e-tasks-host";
      host.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff;";
      document.body.appendChild(host);
      await w.app.markdownRenderer.render(
        "Before\n\n```tasks\nnot done\n```\n\nAfter",
        host,
        "Note.md"
      );
    });

    const node = window.locator("#e2e-tasks-host .e2e-tasks");
    await expect(node).toBeVisible();
    await expect(node).toHaveText("TASKS:not done");
    expect(
      await window.locator("#e2e-tasks-host pre > code.language-tasks").count()
    ).toBe(0);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
