import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");

/**
 * Boots the built app straight into `test-vault/` by pre-seeding a fresh,
 * isolated userData directory with a `geode.json` that lists it as the last
 * opened vault. `App.start()` (src/renderer/app.ts) auto-opens
 * `recentVaults[0]` on launch, so this sidesteps the native "choose a
 * folder" dialog, which Playwright cannot drive.
 */
async function launchAppAgainstTestVault(): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));

  return { app, window, userDataDir, consoleErrors };
}

test("boots into test-vault, opens a note, and renders Live Preview with no console errors", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    // Vault auto-opened: file explorer should list the seeded note.
    const welcomeRow = window.locator('.nav-file-title[data-path="Welcome.md"]');
    await expect(welcomeRow).toBeVisible();

    // Normal metadata indexing runs in an Electron utility process. This is
    // the end-to-end guard that distinguishes the real background path from
    // the renderer fallback exercised by unit tests.
    const processTypes = await window.evaluate(async () =>
      (await window.geode.getProcessMetrics()).map((metric) => metric.type)
    );
    expect(processTypes).toContain("Utility");
    const indexSnapshot = await window.evaluate(() => window.geode.startMetadataIndexer());
    expect(indexSnapshot).not.toBeNull();
    expect(indexSnapshot?.entries["Welcome.md"]).toBeDefined();

    // File explorer toolbar renders real Lucide SVG icons, not the old
    // emoji glyphs (📄+/📁+) or missing icons.
    const toolbarButtons = window.locator(".sidebar-view-actions .clickable-icon");
    await expect(toolbarButtons).toHaveCount(5);
    const toolbarText = await toolbarButtons.allInnerTexts();
    for (const text of toolbarText) {
      expect(text).not.toContain("📄");
      expect(text).not.toContain("📁");
    }
    await expect(toolbarButtons.locator("svg").first()).toBeVisible();
    expect(await toolbarButtons.locator("svg").count()).toBe(5);

    await welcomeRow.click();

    // Live Preview is the default editing mode (MarkdownView.mode === "live").
    const editorHost = window.locator(".markdown-source-view");
    await expect(editorHost).toBeVisible();
    await expect(window.locator(".cm-editor")).toBeVisible();

    // Frontmatter renders as the integrated properties widget, not raw YAML.
    await expect(window.locator(".metadata-properties")).toBeVisible();

    // Wikilinks render as clickable text (raw "[[" / "]]" hidden).
    const wikilinks = window.locator(".cm-live-wikilink");
    await expect(wikilinks.first()).toBeVisible();
    expect(await wikilinks.count()).toBe(2); // [[Daily Plan]] and [[Projects/Roadmap|...]]
    await expect(wikilinks.first()).toHaveText("Daily Plan");

    // Task list markers render as toggleable checkbox widgets.
    await expect(window.locator(".cm-task-checkbox").first()).toBeVisible();

    // The raw ATX heading marker is hidden away from the cursor (cursor
    // starts inside the collapsed frontmatter widget, not on the heading
    // line), leaving only the heading text visible.
    const editorText = await window.locator(".cm-editor").innerText();
    expect(editorText).toContain("Welcome to Geode");
    expect(editorText).not.toContain("# Welcome to Geode");

    // Inline image embed (![[geode-logo.png]]) renders as an actual <img>
    // in Live Preview, not raw "![[" / "]]" syntax.
    const imageEmbed = window.locator(".cm-embed-widget img.internal-embed");
    await expect(imageEmbed).toBeVisible();
    await expect(imageEmbed).toHaveAttribute("src", /^blob:/);
    expect(editorText).not.toContain("![[geode-logo.png]]");

    // Block-level note transclusion (Daily Plan.md embeds
    // Projects/Roadmap.md's "Q3" section) also renders inline, sliced to
    // just that heading's content, not the raw ![[...]] syntax.
    await window.locator('.nav-file-title[data-path="Daily Plan.md"]').click();
    const noteEmbed = window.locator(".cm-embed-widget.cm-embed-block.markdown-embed");
    await expect(noteEmbed).toBeVisible();
    await expect(noteEmbed.locator(".markdown-embed-title")).toHaveText("Roadmap");
    const embedContent = noteEmbed.locator(".markdown-embed-content");
    await expect(embedContent).toContainText("Ship the editor");
    expect(await embedContent.innerText()).not.toContain("Plugin API"); // Q4 section, outside the #Q3 subpath
    const dailyPlanText = await window.locator(".cm-editor").innerText();
    expect(dailyPlanText).not.toContain("![[Projects/Roadmap#Q3]]");

    // Backlinks pane: Daily Plan.md has one linked mention (Welcome.md links
    // to it via [[Daily Plan]]) with its surrounding line as context, and
    // one unlinked mention (Notes/Scratch.md's plain-text "Daily Plan") with
    // its own context snippet — not collapsed into just a filename + count.
    const backlinksPane = window.locator(".sidebar-view").filter({ hasText: "Backlinks" });
    await expect(backlinksPane.getByText("Linked mentions (1)", { exact: true })).toBeVisible();
    await expect(backlinksPane.locator(".pane-result", { hasText: "Welcome" })).toBeVisible();
    await expect(
      backlinksPane.locator(".pane-result-context", {
        hasText: "It links to [[Daily Plan]] and [[Projects/Roadmap]]",
      })
    ).toBeVisible();

    await expect(backlinksPane.getByText("Unlinked mentions (1)", { exact: true })).toBeVisible();
    await expect(backlinksPane.locator(".pane-result", { hasText: "Scratch" })).toBeVisible();
    await expect(
      backlinksPane.locator(".pane-result-context", { hasText: "plain mention of Daily Plan here" })
    ).toBeVisible();

    expect(consoleErrors, `Console errors during smoke test: ${consoleErrors.join("\n")}`).toEqual(
      []
    );
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("clicking a plain external link (plugin-style <a href>) does not navigate the app window", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    // Wait for the app to finish booting (file explorer present).
    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    const initialUrl = await window.evaluate(() => window.location.href);

    // Stub the external-open bridge so the interceptor's routing is observable
    // without actually launching the OS browser, then inject a plain external
    // anchor exactly like a plugin (e.g. Claude Threads) would render — no
    // `.cm-live-extlink` class, no `data-href`, so only the global interceptor
    // can catch it.
    await window.evaluate(() => {
      const w = window as unknown as {
        __externalOpens: string[];
        geode: { openExternal: (url: string) => Promise<void> };
      };
      w.__externalOpens = [];
      const original = w.geode.openExternal.bind(w.geode);
      w.geode.openExternal = (url: string) => {
        w.__externalOpens.push(url);
        // Do not forward to the real shell.openExternal — keep the OS browser
        // out of the test run. Reference `original` so it is not flagged unused.
        void original;
        return Promise.resolve();
      };

      const a = document.createElement("a");
      a.id = "e2e-external-link";
      a.href = "https://example.com/";
      a.textContent = "External example";
      a.style.cssText = "position:fixed;top:0;left:0;z-index:99999;padding:8px;";
      document.body.appendChild(a);
    });

    await window.locator("#e2e-external-link").click();
    // Give any (erroneous) top-level navigation time to occur before asserting.
    await window.waitForTimeout(400);

    const afterUrl = await window.evaluate(() => window.location.href);
    const opens = await window.evaluate(
      () => (window as unknown as { __externalOpens: string[] }).__externalOpens
    );

    // The main window must NOT have navigated away from the app's index.html.
    expect(afterUrl).toBe(initialUrl);
    expect(afterUrl).toContain("index.html");
    // And the click must have been routed through the external-link handler.
    expect(opens).toContain("https://example.com/");

    expect(
      consoleErrors,
      `Console errors during external-link test: ${consoleErrors.join("\n")}`
    ).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("clicking a plugin-style absolute vault file link opens it without navigating the app window", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
    const initialUrl = await window.evaluate(() => window.location.href);
    const target = `${path.join(testVaultPath, "Projects", "Roadmap.md")}:3:3`;

    await window.evaluate((href) => {
      const host = document.createElement("div");
      host.id = "e2e-plugin-shadow-host";
      host.style.cssText = "position:fixed;top:0;left:0;z-index:99999;padding:8px;";
      const root = host.attachShadow({ mode: "open" });
      const a = document.createElement("a");
      a.id = "e2e-local-file-link";
      a.setAttribute("href", href);
      a.textContent = "Vault run note";
      root.appendChild(a);
      document.body.appendChild(host);
    }, target);

    await window.locator("#e2e-local-file-link").click();
    await expect(
      window.locator(".workspace-split.mod-root .workspace-tab-header.is-active")
    ).toHaveAttribute("aria-label", "Roadmap");
    const cursor = await window.evaluate(() => {
      const view = window.app.getActiveMarkdownView();
      const editor = view?.editor;
      if (!editor) return null;
      const head = editor.state.selection.main.head;
      const line = editor.state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1, text: line.text };
    });
    expect(cursor).toEqual({ line: 3, column: 3, text: "Linked from [[Welcome]]." });
    expect(await window.evaluate(() => window.location.href)).toBe(initialUrl);
    expect(consoleErrors, `Console errors during local-file test: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("reading-view external links honor the 'open links in app' setting (Web Viewer when ON, OS browser on Cmd/Ctrl-click)", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();
  const isMac = process.platform === "darwin";

  try {
    await expect(window.locator(".workspace")).toBeVisible();

    // Turn the setting ON, then stub both routing sinks so the reading-view
    // handler's decision (render.ts) is observable without touching the OS
    // browser or the network. Render a plain external Markdown link through the
    // real MarkdownRenderer so render.ts wires its actual click handler.
    await window.evaluate(async () => {
      const w = window as unknown as {
        app: {
          settings: { webViewer: { openLinksInApp: boolean } };
          markdownRenderer: { render: (src: string, el: HTMLElement, path: string) => Promise<void> };
          openWebViewer: (url?: string) => Promise<void>;
        };
        geode: { openExternal: (url: string) => Promise<void> };
        __externalOpens: string[];
        __webViewerOpens: string[];
      };

      w.app.settings.webViewer.openLinksInApp = true;

      w.__externalOpens = [];
      w.__webViewerOpens = [];
      w.geode.openExternal = (url: string) => {
        w.__externalOpens.push(url);
        return Promise.resolve();
      };
      w.app.openWebViewer = (url?: string) => {
        w.__webViewerOpens.push(url ?? "");
        return Promise.resolve();
      };

      const host = document.createElement("div");
      host.id = "e2e-reading-host";
      host.style.cssText = "position:fixed;top:0;left:0;z-index:99999;padding:8px;background:#fff;";
      document.body.appendChild(host);
      await w.app.markdownRenderer.render("[External example](https://example.com/)", host, "");
      const a = host.querySelector("a[href^='http']") as HTMLAnchorElement | null;
      if (a) a.id = "e2e-reading-external-link";
    });

    const link = window.locator("#e2e-reading-external-link");
    await expect(link).toBeVisible();

    // Plain click: setting is ON, so it must route to the Web Viewer, NOT the OS browser.
    await link.click();
    await window.waitForTimeout(200);
    let opens = await window.evaluate(
      () => (window as unknown as { __externalOpens: string[] }).__externalOpens
    );
    let webViewerOpens = await window.evaluate(
      () => (window as unknown as { __webViewerOpens: string[] }).__webViewerOpens
    );
    expect(webViewerOpens).toContain("https://example.com/");
    expect(opens).toEqual([]);

    // Cmd/Ctrl-click: always forces the OS browser regardless of the setting.
    await link.click({ modifiers: [isMac ? "Meta" : "Control"] });
    await window.waitForTimeout(200);
    opens = await window.evaluate(
      () => (window as unknown as { __externalOpens: string[] }).__externalOpens
    );
    webViewerOpens = await window.evaluate(
      () => (window as unknown as { __webViewerOpens: string[] }).__webViewerOpens
    );
    expect(opens).toContain("https://example.com/");
    // The modifier click must not have opened another Web Viewer tab.
    expect(webViewerOpens).toEqual(["https://example.com/"]);

    expect(
      consoleErrors,
      `Console errors during reading-view external-link test: ${consoleErrors.join("\n")}`
    ).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
