import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * The Web Viewer guest must stay drivable from plugin code.
 *
 * Geode's built-in browser is an Electron `<webview>` (see
 * `src/renderer/views/web-view.ts`), and the renderer runs with
 * `nodeIntegration: true` / `contextIsolation: false` (see `src/main/main.ts`).
 * Together those let a hosted plugin reach the guest through the public
 * workspace API and drive it with the `<webview>` tag's own methods — no Chrome
 * DevTools Protocol, no `--remote-debugging-port`, and no second browser
 * process.
 *
 * That combination is what makes in-app browser automation possible at all, so
 * this test pins the four properties an automation layer depends on:
 *
 *   1. the guest is reachable by the PLUGIN-VISIBLE path
 *      (`getLeavesOfType("webviewer")[0].view.containerEl`), not just by a
 *      global CSS selector a plugin has no business knowing;
 *   2. `executeJavaScript()` round-trips a value back out of the guest;
 *   3. an injected script can enumerate interactive elements as stable refs;
 *   4. a ref resolves back to exactly one element and can be acted on.
 *
 * `web-reload.spec.ts` also calls `executeJavaScript` on a guest, but only to
 * detect that a reload discarded the JS context. This file asserts the
 * capability itself, so narrowing `WebviewElement` or tightening the renderer's
 * Electron privileges fails here rather than silently breaking automation.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * A page with one of each element the snapshot cares about, plus a
 * `display:none` button that must NOT appear (an agent cannot click what a user
 * cannot see) and a click handler so acting on a ref has an observable effect.
 */
const PROBE_HTML = `<!doctype html>
<title>Automation probe</title>
<h1>Automation probe</h1>
<input id="q" placeholder="What needs doing?">
<button id="go" aria-label="Submit the form">Go</button>
<a href="#docs">Documentation</a>
<button id="hidden" style="display:none">Never visible</button>
<div id="result">idle</div>
<script>
  document.getElementById('go').addEventListener('click', function () {
    document.getElementById('result').textContent = 'clicked:' + document.getElementById('q').value;
  });
</script>
`;

/**
 * A deliberately minimal accessibility-snapshot script, written the way a
 * plugin would inject it: plain DOM APIs only, no imports and no bundler, so it
 * survives being passed through `executeJavaScript` as a string.
 *
 * Role and name resolution here are only good enough to prove the shape of the
 * loop. A real implementation would compute accessible names per the W3C
 * accname spec rather than guessing from a handful of attributes.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const SEL = 'a[href], button, input, select, textarea, [role], [contenteditable=""], [contenteditable="true"]';
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    return 'generic';
  };
  const nameOf = (el) =>
    (el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || el.getAttribute('alt')
      || (el.innerText || '').trim()
      || el.getAttribute('title')
      || '').replace(/\\s+/g, ' ').slice(0, 120);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };

  const refs = {};
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const ref = 'e' + (++n);
    refs[ref] = el;
    lines.push('- ' + roleOf(el) + ' "' + nameOf(el) + '" [ref=' + ref + ']');
  }
  window.__refs = refs;
  return { snapshot: lines.join('\\n'), count: n };
})()`;

/** Shape of the host-side `app` global this test drives. */
type WorkspaceWindow = {
  app: {
    openWebViewer(url: string): void;
    workspace: { getLeavesOfType(type: string): Array<{ view?: { containerEl: HTMLElement } }> };
  };
};

/**
 * Resolve the guest exactly as a plugin would, then hand it to `fn`.
 *
 * Inlined into every `window.evaluate` call rather than shared, because the
 * callback is serialized into the renderer and cannot close over helpers
 * defined in this file.
 */
const GUEST = `(() => {
  const leaves = window.app.workspace.getLeavesOfType("webviewer");
  return leaves[0].view.containerEl.querySelector("webview");
})()`;

test("the web viewer guest stays drivable from plugin code", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webview-automation-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webview-automation-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(vaultDir, "probe.html"), PROBE_HTML);
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    const url = pathToFileURL(path.join(vaultDir, "probe.html")).href;
    await window.evaluate((target) => (window as unknown as WorkspaceWindow).app.openWebViewer(target), url);
    await expect(window.locator(".web-view-frame")).toBeVisible();

    // The address bar is written synchronously, well before the guest commits
    // the navigation. Wait for the guest WebContents itself, or the snapshot
    // below can run against about:blank.
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .some((wc) => wc.getType() === "webview" && wc.getURL().includes("probe.html")),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    // 1. Reachable through the public workspace API, and the element really is
    // an Electron <webview> carrying the automation methods.
    const reach = await window.evaluate((guestExpr) => {
      const el = eval(guestExpr) as HTMLElement | null;
      const api = el as unknown as Record<string, unknown> | null;
      return {
        leaves: (window as unknown as WorkspaceWindow).app.workspace.getLeavesOfType("webviewer").length,
        tagName: el?.tagName ?? null,
        executeJavaScript: typeof api?.executeJavaScript,
        capturePage: typeof api?.capturePage,
        insertCSS: typeof api?.insertCSS,
        getWebContentsId: typeof api?.getWebContentsId,
      };
    }, GUEST);
    expect(reach.leaves).toBe(1);
    expect(reach.tagName).toBe("WEBVIEW");
    expect(reach.executeJavaScript).toBe("function");
    // Screenshot + styling are what let the same guest be watched or annotated
    // while an agent drives it, so they are part of the contract too.
    expect(reach.capturePage).toBe("function");
    expect(reach.insertCSS).toBe("function");
    expect(reach.getWebContentsId).toBe("function");

    // 2. A value computed inside the guest comes back to the host.
    const roundTrip = await window.evaluate((guestExpr) => {
      const el = eval(guestExpr) as unknown as { executeJavaScript(s: string): Promise<unknown> };
      return el.executeJavaScript("document.title + '|' + document.querySelectorAll('button').length");
    }, GUEST);
    expect(roundTrip).toBe("Automation probe|2");

    // 3. An injected script enumerates interactive elements as refs.
    const snap = await window.evaluate(
      ([guestExpr, script]) => {
        const el = eval(guestExpr) as unknown as {
          executeJavaScript(s: string): Promise<{ snapshot: string; count: number }>;
        };
        return el.executeJavaScript(script);
      },
      [GUEST, SNAPSHOT_SCRIPT],
    );
    expect(snap.snapshot).toContain('textbox "What needs doing?" [ref=e1]');
    expect(snap.snapshot).toContain('button "Submit the form" [ref=e2]');
    expect(snap.snapshot).toContain('link "Documentation" [ref=e3]');
    // The display:none button is excluded, so refs describe what a user could
    // actually act on rather than everything in the DOM.
    expect(snap.count).toBe(3);
    expect(snap.snapshot).not.toContain("Never visible");

    // 4. Refs survive into a later call and resolve to one exact element.
    // Filling e1 and clicking e2 must produce the page's own side effect,
    // which is only possible if both refs pointed at the right nodes.
    const acted = await window.evaluate((guestExpr) => {
      const el = eval(guestExpr) as unknown as { executeJavaScript(s: string): Promise<string> };
      return el.executeJavaScript(`(() => {
        window.__refs['e1'].value = 'buy milk';
        window.__refs['e2'].click();
        return document.getElementById('result').textContent;
      })()`);
    }, GUEST);
    expect(acted).toBe("clicked:buy milk");

    // capturePage() is the "let the user watch it work" path: the same guest an
    // agent is driving can be rendered to a PNG without a second browser.
    const pngBytes = await window.evaluate(async (guestExpr) => {
      const el = eval(guestExpr) as unknown as { capturePage(): Promise<{ toPNG(): Uint8Array }> };
      const image = await el.capturePage();
      return image.toPNG().length;
    }, GUEST);
    expect(pngBytes).toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
