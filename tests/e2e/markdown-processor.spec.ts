import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "md-proc-plugin",
  name: "Markdown Processor Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Registers a reading-view code-block processor for the e2e test.",
  author: "geode",
};

/**
 * Real CommonJS-style main.js: a plugin that registers a reading-view
 * code-block processor for the `mytest` language, rendering a known DOM node
 * (a `<div class="e2e-mytest">`) whose text echoes the block source and whose
 * data attribute echoes the render context's sourcePath — proving the full
 * chain: onload -> Plugin.registerMarkdownCodeBlockProcessor -> App registry
 * -> reading-view dispatch with a real MarkdownPostProcessorContext.
 */
const MAIN_JS = `
  const { Plugin } = require('geode');

  module.exports.default = class MdProcPlugin extends Plugin {
    onload() {
      this.app.notify('md-proc-plugin loaded');
      this.registerMarkdownCodeBlockProcessor('mytest', (source, el, ctx) => {
        const node = el.createEl('div', { cls: 'e2e-mytest', text: 'PROC:' + source.trim() });
        node.setAttribute('data-source-path', ctx.sourcePath);
      });
    }
  };
`;

/**
 * Boots the built app into a fresh temp vault with the fixture plugin already
 * enabled, then drives the *real* reading-view renderer
 * (`app.markdownRenderer.render`, the same path MarkdownView.renderReading
 * uses) directly — mirroring smoke.spec.ts's reading-view external-link test.
 * Asserts that (1) a `mytest` code block dispatches to the plugin's registered
 * processor and renders its node, and (2) a `base` code block still mounts a
 * live BaseView (mountBases not regressed).
 */
test("a plugin's markdown code-block processor renders in reading view; base blocks still mount", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-mdproc-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-mdproc-e2e-"));

  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "md-proc-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["md-proc-plugin"])
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

    // Plugin onload() ran and registered its processor.
    await expect(
      window.locator(".notice", { hasText: "md-proc-plugin loaded" })
    ).toBeVisible();

    // --- 1. Registered code-block processor runs in reading view ----------
    await window.evaluate(async () => {
      const w = window as unknown as {
        app: {
          markdownRenderer: {
            render: (src: string, el: HTMLElement, path: string) => Promise<void>;
          };
        };
      };
      const host = document.createElement("div");
      host.id = "e2e-mytest-host";
      host.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff;";
      document.body.appendChild(host);
      await w.app.markdownRenderer.render(
        "Before\n\n```mytest\nhello world\n```\n\nAfter",
        host,
        "Note.md"
      );
    });

    const procNode = window.locator("#e2e-mytest-host .e2e-mytest");
    await expect(procNode).toBeVisible();
    await expect(procNode).toHaveText("PROC:hello world");
    // The rendered node carries the real ctx.sourcePath.
    await expect(procNode).toHaveAttribute("data-source-path", "Note.md");
    // The original <pre><code> was replaced by the processor's container.
    expect(
      await window.locator("#e2e-mytest-host pre > code.language-mytest").count()
    ).toBe(0);
    // Surrounding content still rendered normally.
    await expect(window.locator("#e2e-mytest-host")).toContainText("Before");
    await expect(window.locator("#e2e-mytest-host")).toContainText("After");

    // --- 2. Regression: ```base blocks still mount a live BaseView --------
    await window.evaluate(async () => {
      const w = window as unknown as {
        app: {
          markdownRenderer: {
            render: (src: string, el: HTMLElement, path: string) => Promise<void>;
          };
        };
      };
      const host = document.createElement("div");
      host.id = "e2e-base-host";
      host.style.cssText = "position:fixed;top:40px;left:0;z-index:99999;background:#fff;";
      document.body.appendChild(host);
      await w.app.markdownRenderer.render(
        "```base\nviews:\n  - type: table\n    name: Table\n```",
        host,
        "Note.md"
      );
    });

    // BaseView container mounted, raw base code block gone.
    await expect(window.locator("#e2e-base-host .base-view")).toBeVisible();
    expect(
      await window.locator("#e2e-base-host pre > code.language-base").count()
    ).toBe(0);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
