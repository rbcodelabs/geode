import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Audits four confirmed divergences between Geode's plugin-host shim and
 * real Obsidian (see the postmortem this spec was written from):
 *  1. `addIcon`/`setIcon` not wrapping bare SVG fragments -> invisible icons.
 *  2. `app.commands` shaped as a Map instead of Obsidian's Record + alias methods.
 *  3. `workspace.leftSplit`/`rightSplit` missing.
 *  4. `app.plugins`/`internalPlugins.webviewer` permanently-empty stubs, and
 *     `installObsidianAppCompat` only running from the `Plugin` constructor
 *     (so a plugin that never constructs it — or module-eval-time readers —
 *     see an empty/undefined `app.plugins`).
 *
 * Two fixture plugins probe this:
 *  - `api-compat-probe`: a normal `require('obsidian')` plugin extending
 *    `obsidian.Plugin`, which DOES run the constructor-time compat install.
 *  - `geode-only-probe`: `require('geode')` extending the bare `GeodePlugin`
 *    base (never constructs `obsidian.Plugin`), the sharpest proof that the
 *    App.start()-level install (not the constructor guard) is what makes
 *    `app.plugins` populated app-wide.
 */

const PROBE_MANIFEST = {
  id: "api-compat-probe",
  name: "API Compat Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises Geode's icon/commands/workspace/plugins compat surface.",
  author: "geode",
};

const GEODE_ONLY_MANIFEST = {
  id: "geode-only-probe",
  name: "Geode-only Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Never constructs obsidian.Plugin; proves App.start()-level install.",
  author: "geode",
};

// Module-scope eval order recorded before module.exports runs — regression
// test for "installObsidianAppCompat only running from the Plugin
// constructor", which would leave this probe (and anything reading
// `app.plugins` at module-eval time, e.g. a top-level `require('geode').app`
// snapshot) seeing an empty registry.
const PROBE_MAIN_JS = `
  const obsidian = require('obsidian');
  window.__probeModuleEval = window.__probeModuleEval || {};
  window.__probeModuleEval.pluginsAtEval = typeof window.app !== 'undefined' && !!window.app.plugins;
  window.__probeModuleEval.manifestCountAtEval =
    (typeof window.app !== 'undefined' && window.app.plugins)
      ? Object.keys(window.app.plugins.manifests || {}).length
      : -1;

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      // Bare fragment, no <svg> wrapper — exactly how real plugins register
      // icons (e.g. brand marks copied from a design tool).
      obsidian.addIcon(
        'probe-glyph',
        '<path fill="currentColor" d="M10 10 L90 10 L90 90 L10 90 Z" />'
      );

      const mkRibbon = (id, icon, label) => {
        const el = this.addRibbonIcon(icon, label, () => {});
        el.id = id;
        return el;
      };
      mkRibbon('ribbon-custom', 'probe-glyph', 'Custom glyph');
      mkRibbon('ribbon-lucide-prefixed', 'lucide-search', 'Lucide prefixed');
      mkRibbon('ribbon-unknown', 'totally-unknown-icon-xyz', 'Unknown icon');
      mkRibbon('ribbon-emoji', '\u{1F600}', 'Emoji icon');

      this.addCommand({
        id: 'probe-command',
        name: 'Probe Command',
        callback: () => { window.__probeCommandFired = (window.__probeCommandFired || 0) + 1; },
      });

      window.__probeModuleEval.onloadRan = true;
    }
  };
`;

// Extends the BARE plugin.ts base (require('geode').GeodePlugin), which
// never constructs obsidian.Plugin and therefore never runs the
// constructor-guarded installObsidianAppCompat call.
const GEODE_ONLY_MAIN_JS = `
  const geode = require('geode');

  module.exports.default = class extends geode.GeodePlugin {
    async onload() {
      window.__geodeOnly = {
        hasPlugins: !!this.app.plugins,
        hasManifests: !!(this.app.plugins && this.app.plugins.manifests),
        manifestCount: this.app.plugins ? Object.keys(this.app.plugins.manifests).length : -1,
      };
    }
  };
`;

test.describe("plugin API host-contract compat", () => {
  test("addIcon/setIcon, commands, workspace splits, and app.plugins match Obsidian's contract", async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-api-compat-vault-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-api-compat-ud-"));
    const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;
    if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");

    const probeDir = path.join(vaultDir, ".geode", "plugins", "api-compat-probe");
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, "manifest.json"), JSON.stringify(PROBE_MANIFEST));
    fs.writeFileSync(path.join(probeDir, "main.js"), PROBE_MAIN_JS);

    const geodeOnlyDir = path.join(vaultDir, ".geode", "plugins", "geode-only-probe");
    fs.mkdirSync(geodeOnlyDir, { recursive: true });
    fs.writeFileSync(path.join(geodeOnlyDir, "manifest.json"), JSON.stringify(GEODE_ONLY_MANIFEST));
    fs.writeFileSync(path.join(geodeOnlyDir, "main.js"), GEODE_ONLY_MAIN_JS);

    fs.writeFileSync(
      path.join(vaultDir, ".geode", "plugins.json"),
      JSON.stringify(["api-compat-probe", "geode-only-probe"])
    );
    fs.writeFileSync(
      path.join(userDataDir, "geode.json"),
      JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
    );

    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    const consoleErrors: string[] = [];
    try {
      const window = await app.firstWindow();
      window.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      window.on("pageerror", (e) => consoleErrors.push(String(e)));

      // --- 1. Both plugins loaded, no load errors -----------------------
      await expect
        .poll(() => window.evaluate(() => (window as any).app?.pluginManager?.isEnabled?.("api-compat-probe")))
        .toBe(true);
      for (const id of ["api-compat-probe", "geode-only-probe"]) {
        const loadError = await window.evaluate(
          (pid) => (window as any).app.pluginManager.getLoadError(pid) ?? null,
          id
        );
        expect(loadError, `${id} load error`).toBeNull();
        const enabled = await window.evaluate(
          (pid) => (window as any).app.pluginManager.isEnabled(pid),
          id
        );
        expect(enabled, `${id} enabled`).toBe(true);
      }

      // --- 2. Icon paints -------------------------------------------------
      const customBtn = window.locator("#ribbon-custom");
      await expect(customBtn).toHaveCount(1);
      const svg = customBtn.locator("svg");
      await expect(svg).toHaveCount(1);
      const svgBox = await svg.boundingBox();
      expect(svgBox && svgBox.width > 0 && svgBox.height > 0, "svg has non-zero box").toBeTruthy();
      const pathBBox = await svg.locator("path").evaluate((el: SVGPathElement) => {
        const b = el.getBBox();
        return { width: b.width, height: b.height };
      });
      expect(pathBBox.width).toBeGreaterThan(0);
      expect(pathBBox.height).toBeGreaterThan(0);
      const fill = await svg.locator("path").evaluate((el) => getComputedStyle(el).fill);
      expect(fill).not.toBe("none");
      await expect(svg).toHaveClass(/svg-icon/);
      await expect(svg).toHaveClass(/probe-glyph/);
      const viewBox = await svg.getAttribute("viewBox");
      expect(viewBox).toBe("0 0 100 100");
      const btnText = await customBtn.evaluate((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("svg").forEach((s) => s.remove());
        return clone.textContent?.trim() ?? "";
      });
      expect(btnText).toBe("");

      // --- 3. lucide- prefix resolves --------------------------------------
      const lucideBtn = window.locator("#ribbon-lucide-prefixed");
      await expect(lucideBtn.locator("svg")).toHaveCount(1);
      const lucideSvgHtml = await lucideBtn.locator("svg").innerHTML();
      expect(lucideSvgHtml.length).toBeGreaterThan(0);

      // --- 4. Unknown id -> empty text; emoji still falls back to text ----
      const unknownBtn = window.locator("#ribbon-unknown");
      await expect(unknownBtn.locator("svg")).toHaveCount(0);
      const unknownText = await unknownBtn.textContent();
      expect(unknownText?.trim()).toBe("");
      const emojiBtn = window.locator("#ribbon-emoji");
      const emojiText = await emojiBtn.textContent();
      expect(emojiText?.trim().length).toBeGreaterThan(0);

      // --- 5. app.commands: Record contract --------------------------------
      const commandsProbe = await window.evaluate(() => {
        const a = window as any;
        const registry = a.app.commands;
        const id = "api-compat-probe:probe-command";
        const proto = Object.getPrototypeOf(registry.commands);
        const before = a.__probeCommandFired || 0;
        const execOk = registry.executeCommandById(id);
        const execUnknown = registry.executeCommandById("no-such-command-xyz");
        const list = registry.listCommands();
        return {
          protoIsPlainObject: proto === Object.prototype || proto === null,
          hasKey: id in registry.commands,
          sameRef: registry.commands[id] === registry.findCommand(id),
          listNonEmpty: Array.isArray(list) && list.length > 0,
          listIncludesBuiltin: Array.isArray(list) && list.some((c: any) => c.id !== id),
          execOk,
          execUnknown,
          firedDelta: (a.__probeCommandFired || 0) - before,
        };
      });
      expect(commandsProbe.protoIsPlainObject).toBe(true);
      expect(commandsProbe.hasKey).toBe(true);
      expect(commandsProbe.sameRef).toBe(true);
      expect(commandsProbe.listNonEmpty).toBe(true);
      expect(commandsProbe.listIncludesBuiltin).toBe(true);
      expect(commandsProbe.execOk).toBe(true);
      expect(commandsProbe.execUnknown).toBe(false);
      expect(commandsProbe.firedDelta).toBe(1);

      // --- 6. workspace.leftSplit / rightSplit ------------------------------
      const splitProbe = await window.evaluate(() => {
        const ws = (window as any).app.workspace;
        const { leftSplit, rightSplit } = ws;
        const leftIdentical = leftSplit === ws.leftSidebar;
        const rootSplitType = typeof (ws as any).rootSplit;
        const wasCollapsed = leftSplit.collapsed;
        leftSplit.collapse();
        leftSplit.collapse(); // idempotent
        const collapsedNow = leftSplit.collapsed;
        const domCollapsedAfterCollapse = document
          .querySelector(".workspace-sidebar.mod-left")
          ?.classList.contains("is-collapsed");
        leftSplit.expand();
        leftSplit.expand(); // idempotent
        const expandedNow = leftSplit.collapsed;
        const domCollapsedAfterExpand = document
          .querySelector(".workspace-sidebar.mod-left")
          ?.classList.contains("is-collapsed");
        if (wasCollapsed) leftSplit.collapse(); // restore original state
        return {
          leftIdentical,
          rightIdentical: rightSplit === ws.rightSidebar,
          rootSplitType,
          collapsedNow,
          domCollapsedAfterCollapse,
          expandedNow,
          domCollapsedAfterExpand,
        };
      });
      expect(splitProbe.leftIdentical).toBe(true);
      expect(splitProbe.rightIdentical).toBe(true);
      expect(splitProbe.rootSplitType).toBe("undefined");
      expect(splitProbe.collapsedNow).toBe(true);
      expect(splitProbe.domCollapsedAfterCollapse).toBe(true);
      expect(splitProbe.expandedNow).toBe(false);
      expect(splitProbe.domCollapsedAfterExpand).toBe(false);

      // --- 7. app.plugins live registries -----------------------------------
      const pluginsProbe = await window.evaluate(() => {
        const a = window as any;
        const id = "api-compat-probe";
        const manifest = a.app.plugins.manifests[id];
        const enabledSet = a.app.plugins.enabledPlugins;
        return {
          hasManifestDir: typeof manifest?.dir === "string" && manifest.dir.length > 0,
          enabledHas: enabledSet.has(id),
          isSet: enabledSet instanceof Set,
          pluginsIdentical: a.app.plugins.plugins[id] === a.app.pluginManager.getPlugin(id),
        };
      });
      expect(pluginsProbe.hasManifestDir).toBe(true);
      expect(pluginsProbe.enabledHas).toBe(true);
      expect(pluginsProbe.isSet).toBe(true);
      expect(pluginsProbe.pluginsIdentical).toBe(true);

      // --- 8. Liveness across disable ----------------------------------------
      const setBeforeRef = await window.evaluate(() => {
        (window as any).__enabledSetRef = (window as any).app.plugins.enabledPlugins;
        return true;
      });
      expect(setBeforeRef).toBe(true);
      await window.evaluate(() =>
        (window as any).app.pluginManager.disable("api-compat-probe", { persist: false })
      );
      const afterDisable = await window.evaluate(() => {
        const a = window as any;
        const id = "api-compat-probe";
        return {
          enabledHas: a.app.plugins.enabledPlugins.has(id),
          pluginsUndefined: a.app.plugins.plugins[id] === undefined,
          manifestStillPresent: !!a.app.plugins.manifests[id],
          sameSetIdentity: a.app.plugins.enabledPlugins === a.__enabledSetRef,
        };
      });
      expect(afterDisable.enabledHas).toBe(false);
      expect(afterDisable.pluginsUndefined).toBe(true);
      expect(afterDisable.manifestStillPresent).toBe(true);
      expect(afterDisable.sameSetIdentity).toBe(true);

      // --- 9. Ordering: module-eval-time app.plugins ---------------------------
      const evalOrder = await window.evaluate(() => (window as any).__probeModuleEval);
      expect(evalOrder.pluginsAtEval, "app.plugins present at module-eval time").toBe(true);
      expect(evalOrder.manifestCountAtEval).toBeGreaterThanOrEqual(2);
      expect(evalOrder.onloadRan).toBe(true);
      const geodeOnly = await window.evaluate(() => (window as any).__geodeOnly);
      expect(geodeOnly.hasPlugins, "geode-only-probe sees app.plugins").toBe(true);
      expect(geodeOnly.hasManifests).toBe(true);
      expect(geodeOnly.manifestCount).toBeGreaterThanOrEqual(2);

      // --- 10. internalPlugins.webviewer -----------------------------------
      const internalPluginsProbe = await window.evaluate(() => {
        const ip = (window as any).app.internalPlugins;
        return {
          webviewerEnabled: ip.getPluginById("webviewer")?.enabled === true,
          dailyNotesStillWorks: ip.getPluginById("daily-notes")?.enabled === true,
        };
      });
      expect(internalPluginsProbe.webviewerEnabled).toBe(true);
      expect(internalPluginsProbe.dailyNotesStillWorks).toBe(true);

      if (screenshotDir) {
        await window.screenshot({ path: path.join(screenshotDir, "plugin-api-compat.png") });
        console.log(`[plugin-api-compat] screenshot written to: ${screenshotDir}`);
      }

      // --- 11. Zero console errors --------------------------------------------
      expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
    } finally {
      await app.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
