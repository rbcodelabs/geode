import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * `sanitizeHTMLToDom` needs a real `<template>` to parse into, and the vitest
 * suite runs the `node` environment (no jsdom), so the policy predicates are
 * unit-tested in `tests/unit/sanitize-html.test.ts` and the DOM walk that
 * applies them is verified here, in the real renderer, through the same
 * `require('obsidian')` entry point a hosted plugin uses.
 *
 * Plugins feed this `marked.parse()` output — Claude Threads renders
 * conversation markdown through it — so every payload below is reachable
 * from note content. Before this spec the sanitizer stripped `<script>` and
 * nothing else: inline handlers and `javascript:`/`data:` URLs all survived,
 * masked only by the app's CSP.
 */

const MANIFEST = {
  id: "sanitize-probe",
  name: "Sanitize Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises sanitizeHTMLToDom's element and attribute policy.",
  author: "geode",
};

/**
 * Control characters are written as HTML numeric entities so the probe source
 * stays plain ASCII; the HTML parser decodes them into the attribute value,
 * which is exactly how the obfuscated scheme arrives in practice.
 */
const MAIN_JS = `
  const obsidian = require('obsidian');

  const CASES = {
    eventHandler: '<img id="c" src="x" onerror="window.__xss=1" onclick="window.__xss=1">',
    jsHref: '<a id="c" href="javascript:window.__xss=1">x</a>',
    jsHrefMixedCase: '<a id="c" href="JaVaScRiPt:window.__xss=1">x</a>',
    jsHrefLeadingSpace: '<a id="c" href="&#13;&#10; javascript:window.__xss=1">x</a>',
    jsHrefInnerTab: '<a id="c" href="java&#9;script:window.__xss=1">x</a>',
    jsFormAction: '<form id="c" action="javascript:window.__xss=1"></form>',
    dataHtmlHref: '<a id="c" href="data:text/html,&lt;b&gt;x&lt;/b&gt;">x</a>',
    dataImageOnImg: '<img id="c" src="data:image/png;base64,iVBORw0KGgo=">',
    safeHref: '<a id="c" href="https://example.com/page">x</a>',
    scriptTag: '<div><script>window.__xss=1</' + 'script></div>',
    iframeTag: '<div><iframe src="https://evil.example"></iframe></div>',
    baseTag: '<div><base href="https://evil.example/"></div>',
    objectTag: '<div><object data="https://evil.example"></object></div>',
    keepsStyleAndForm: '<div><style>.x{color:red}</style><form action="/post"></form></div>',
  };

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      const out = {};
      for (const [name, html] of Object.entries(CASES)) {
        const host = document.createElement('div');
        host.appendChild(obsidian.sanitizeHTMLToDom(html));
        // Attach so the fragment is live in the document, matching how a view
        // renders it — a surviving handler would have a real chance to fire.
        host.style.display = 'none';
        document.body.appendChild(host);
        const probe = host.querySelector('#c');
        out[name] = {
          html: host.innerHTML,
          attrs: probe ? Array.from(probe.attributes).map((a) => a.name).sort() : null,
          href: probe ? probe.getAttribute('href') : null,
          src: probe ? probe.getAttribute('src') : null,
          action: probe ? probe.getAttribute('action') : null,
          tags: Array.from(host.querySelectorAll('*')).map((e) => e.tagName.toLowerCase()),
        };
      }
      window.__sanitizeProbe = out;
    }
  };
`;

test.describe("sanitizeHTMLToDom", () => {
  test("strips event handlers, executable URL schemes, and unsafe elements", async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sanitize-vault-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sanitize-ud-"));
    fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");

    const probeDir = path.join(vaultDir, ".geode", "plugins", "sanitize-probe");
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, "manifest.json"), JSON.stringify(MANIFEST));
    fs.writeFileSync(path.join(probeDir, "main.js"), MAIN_JS);
    fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["sanitize-probe"]));
    fs.writeFileSync(
      path.join(userDataDir, "geode.json"),
      JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
    );

    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    try {
      const window = await app.firstWindow();
      await expect
        .poll(() => window.evaluate(() => !!(window as any).__sanitizeProbe), { timeout: 20_000 })
        .toBe(true);

      const loadError = await window.evaluate(
        () => (window as any).app.pluginManager.getLoadError("sanitize-probe") ?? null
      );
      expect(loadError, "probe load error").toBeNull();

      const probe = await window.evaluate(() => (window as any).__sanitizeProbe);

      // --- Inline event handlers ------------------------------------------
      expect(probe.eventHandler.attrs).toEqual(["id", "src"]);
      expect(probe.eventHandler.html).not.toContain("onerror");
      expect(probe.eventHandler.html).not.toContain("onclick");

      // --- javascript: in every form ---------------------------------------
      for (const name of [
        "jsHref",
        "jsHrefMixedCase",
        "jsHrefLeadingSpace",
        "jsHrefInnerTab",
      ]) {
        expect(probe[name].href, `${name} href`).toBeNull();
      }
      expect(probe.jsFormAction.action, "javascript: form action").toBeNull();

      // --- data: URLs -------------------------------------------------------
      expect(probe.dataHtmlHref.href, "data:text/html href").toBeNull();
      // The legitimate markdown case, which must survive.
      expect(probe.dataImageOnImg.src).toBe("data:image/png;base64,iVBORw0KGgo=");

      // --- Benign values are untouched --------------------------------------
      expect(probe.safeHref.href).toBe("https://example.com/page");

      // --- Unsafe elements removed outright ---------------------------------
      expect(probe.scriptTag.tags).not.toContain("script");
      expect(probe.iframeTag.tags).not.toContain("iframe");
      expect(probe.baseTag.tags).not.toContain("base");
      expect(probe.objectTag.tags).not.toContain("object");

      // --- Deliberately kept, matching DOMPurify's stock config --------------
      expect(probe.keepsStyleAndForm.tags).toContain("style");
      expect(probe.keepsStyleAndForm.tags).toContain("form");

      // Nothing anywhere managed to execute.
      expect(await window.evaluate(() => (window as any).__xss ?? null)).toBeNull();
    } finally {
      await app.close();
    }
  });
});
