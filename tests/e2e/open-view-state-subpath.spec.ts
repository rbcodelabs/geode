import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * `WorkspaceLeaf.openFile` used to discard everything in `OpenViewState`
 * except `active`, so a plugin resolving a `Note#Heading` link with
 * `parseLinktext` and passing `{ eState: { subpath } }` got the right file
 * opened at the *top* of the document — no scroll, no error. This spec drives
 * the real plugin entry point and measures the editor, since the symptom is a
 * scroll position that no unit test can observe.
 */

const MANIFEST = {
  id: "subpath-probe",
  name: "Subpath Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Opens a file via leaf.openFile with eState.subpath.",
  author: "geode",
};

const FILLER = Array.from({ length: 240 }, (_, i) => `Filler line ${i} with enough text to scroll.`);
const NOTE = ["# Top", ...FILLER, "## Target Heading", "anchored body ^block-1", ...FILLER].join("\n");

const MAIN_JS = `
  const obsidian = require('obsidian');

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      window.__openWithSubpath = async (subpath) => {
        const file = this.app.vault.getFileByPath('Long.md');
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file, subpath ? { eState: { subpath } } : undefined);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const scroller = leaf.view.containerEl.querySelector('.cm-scroller');
        return {
          path: leaf.view.getFile ? leaf.view.getFile().path : null,
          scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
          cursor: leaf.view.editor ? leaf.view.editor.state.selection.main.head : -1,
          // Reported so a failure says why: the heading branch of
          // resolveSubpathOffset reads the metadata cache, which startup
          // populates asynchronously. (No backticks here - this whole
          // plugin body is a template literal.)
          headings: this.app.metadataCache.getHeadings(file).length,
        };
      };
      window.__subpathProbeReady = true;
    }
  };
`;

test.describe("OpenViewState.eState.subpath", () => {
  test("scrolls the opened view to a heading and to a block anchor", async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-subpath-vault-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-subpath-ud-"));
    fs.writeFileSync(path.join(vaultDir, "Long.md"), NOTE);

    const probeDir = path.join(vaultDir, ".geode", "plugins", "subpath-probe");
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, "manifest.json"), JSON.stringify(MANIFEST));
    fs.writeFileSync(path.join(probeDir, "main.js"), MAIN_JS);
    fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["subpath-probe"]));
    fs.writeFileSync(
      path.join(userDataDir, "geode.json"),
      JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
    );

    const headingOffset = NOTE.indexOf("## Target Heading");
    const blockOffset = NOTE.indexOf("anchored body ^block-1");

    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    try {
      const window = await app.firstWindow();
      await expect
        .poll(() => window.evaluate(() => !!(window as any).__subpathProbeReady), { timeout: 20_000 })
        .toBe(true);

      // Control: no eState at all — the old behaviour for every call, and
      // still the correct behaviour when no anchor was requested.
      const plain = await window.evaluate(() => (window as any).__openWithSubpath(null));
      expect(plain.path).toBe("Long.md");
      expect(plain.scrollTop, "no subpath must not scroll").toBe(0);

      /**
       * Poll rather than assert a single shot. Landing on the anchor depends
       * on a chain that startup completes asynchronously — the plugin loading,
       * the metadata cache indexing `Long.md` (the heading branch reads it),
       * the view mounting, and CodeMirror measuring the scroll. A one-shot
       * `evaluate` plus a fixed two-frame wait assumes every link is ready and
       * fails spuriously under load when one is not. Polling still fails for
       * real if the scroll never happens, so this hardens the timing without
       * weakening the assertion. `headings` is reported to make a genuine
       * failure self-diagnosing.
       */
      const openAt = async (subpath: string, expectedCursor: number) =>
        await expect
          .poll(
            async () => {
              const r = await window.evaluate(
                (s) => (window as any).__openWithSubpath(s),
                subpath
              );
              return { path: r.path, cursor: r.cursor, scrolled: r.scrollTop > 0 };
            },
            { timeout: 20_000 }
          )
          .toEqual({ path: "Long.md", cursor: expectedCursor, scrolled: true });

      // Heading anchor.
      await openAt("#Target Heading", headingOffset);

      // Block anchor.
      await openAt("#^block-1", blockOffset);

      // An anchor that does not resolve leaves the view alone rather than erroring.
      const missing = await window.evaluate(() => (window as any).__openWithSubpath("#No Such Heading"));
      expect(missing.path).toBe("Long.md");
    } finally {
      await app.close();
    }
  });
});
