import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");

/**
 * End-to-end coverage for Mermaid rendering against `test-vault/Mermaid.md`
 * (a flowchart with an `internal-link` node, a sequence diagram, and one
 * deliberately malformed block).
 *
 * Boots the built app straight into `test-vault/` the same way
 * `smoke.spec.ts` does: a pre-seeded userData dir naming the vault, so
 * `App.start()` auto-opens it instead of raising a native folder picker.
 */
async function launchAppAgainstTestVault(): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-mermaid-e2e-"));
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

test("mermaid blocks render as SVG in Live Preview and Reading view; a malformed block errors inline", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    const mermaidRow = window.locator('.nav-file-title[data-path="Mermaid.md"]');
    await expect(mermaidRow).toBeVisible();
    await mermaidRow.click();

    // --- 1. Live Preview renders diagrams as real SVG ---------------------
    // The lazy dist/mermaid.js chunk is injected on first use, so allow it
    // time to load before asserting.
    const liveDiagrams = window.locator(".cm-editor .mermaid-block svg");
    await expect(liveDiagrams.first()).toBeVisible({ timeout: 30_000 });
    // Flowchart + sequence diagram both render (the third block is malformed).
    await expect(liveDiagrams).toHaveCount(2);

    // The diagrams got here through `loadMermaid()`, which injects the lazy
    // dist/mermaid.js chunk — the same entry point plugins reach via
    // require('obsidian').loadMermaid (parity DEV-45053118ab68 /
    // API-875834c93581).
    expect(
      await window.evaluate(() => ({
        global: typeof (globalThis as { mermaid?: unknown }).mermaid,
        chunks: [...document.querySelectorAll("script")].filter((s) =>
          (s.getAttribute("src") ?? "").endsWith("mermaid.js")
        ).length,
      }))
    ).toEqual({ global: "object", chunks: 1 });

    // The raw source is hidden while the diagram is rendered.
    const liveText = await window.locator(".cm-editor").innerText();
    expect(liveText).not.toContain("flowchart TD");

    // The `class Roadmap internal-link;` node is wired for navigation.
    const internalNode = window.locator(".cm-editor .mermaid-block .internal-link").first();
    await expect(internalNode).toBeVisible();
    await expect(internalNode).toContainText("Roadmap");

    // --- 2. The malformed block errors inline instead of crashing ---------
    const liveError = window.locator(".cm-editor .mermaid-block.is-error");
    await expect(liveError).toBeVisible();
    await expect(liveError).toContainText("Mermaid diagram error");
    // A failed block must not take the surrounding note down with it.
    expect(liveText).toContain("After the diagrams");

    // --- 3. Clicking into a block reveals the raw source, clicking out
    //        re-renders it -------------------------------------------------
    // A real mouse click, not a programmatic selection dispatch: the widget
    // has to actually be clickable-into, which depends on `ignoreEvent()`
    // deferring non-link clicks to CodeMirror. A block widget that swallowed
    // them would leave the block permanently uneditable.
    const firstDiagram = window.locator(".cm-editor .mermaid-block").first();
    const box = (await firstDiagram.boundingBox())!;
    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(window.locator(".cm-editor .mermaid-block svg")).toHaveCount(1);
    expect(await window.locator(".cm-editor").innerText()).toContain("flowchart TD");

    // Clicking out (onto a plain paragraph) re-renders it.
    await window
      .locator(".cm-editor .cm-line", { hasText: "After the diagrams" })
      .first()
      .click();
    await expect(window.locator(".cm-editor .mermaid-block svg")).toHaveCount(2);
    expect(await window.locator(".cm-editor").innerText()).not.toContain("flowchart TD");

    // --- 4. Reading view renders the same diagrams ------------------------
    await window.evaluate(async () => {
      await window.app.getActiveMarkdownView()!.toggleMode();
    });
    const readingDiagrams = window.locator(".markdown-reading-view .mermaid-block svg");
    await expect(readingDiagrams.first()).toBeVisible({ timeout: 30_000 });
    await expect(readingDiagrams).toHaveCount(2);
    await expect(
      window.locator(".markdown-reading-view .mermaid-block.is-error")
    ).toBeVisible();
    await expect(
      window.locator(".markdown-reading-view .mermaid-block .internal-link").first()
    ).toContainText("Roadmap");
    // The processor replaced the <pre>, so no raw mermaid code block remains.
    expect(
      await window.locator(".markdown-reading-view pre > code.language-mermaid").count()
    ).toBe(0);

    expect(
      consoleErrors,
      `Console errors during mermaid test: ${consoleErrors.join("\n")}`
    ).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("mermaid diagrams re-render on a theme flip and internal-link nodes navigate", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    await window.locator('.nav-file-title[data-path="Mermaid.md"]').click();
    const liveDiagrams = window.locator(".cm-editor .mermaid-block svg");
    await expect(liveDiagrams.first()).toBeVisible({ timeout: 30_000 });

    // --- Theme flip: App.applySettings triggers "css-change", which the
    //     rendered diagrams subscribe to. -------------------------------
    // Mermaid styles a diagram through a <style> block it injects into the
    // SVG (not inline attributes), so that block's text is what carries the
    // theme colors and is the thing that must change on a flip.
    const readDiagramStyle = () =>
      window.evaluate(
        () => document.querySelector(".cm-editor .mermaid-block svg style")?.textContent ?? ""
      );
    const darkStyle = await readDiagramStyle();
    expect(darkStyle).not.toBe("");

    await window.evaluate(() => {
      window.app.settings.theme = "light";
      window.app.applySettings();
    });
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    // Wait for the re-render triggered by css-change to land.
    await expect.poll(readDiagramStyle, { timeout: 15_000 }).not.toBe(darkStyle);

    // --- Internal-link node navigates -----------------------------------
    await window.evaluate(() => {
      window.app.settings.theme = "dark";
      window.app.applySettings();
    });
    await expect(liveDiagrams.first()).toBeVisible();
    await window
      .locator(".cm-editor .mermaid-block .internal-link")
      .first()
      .click();
    await expect(
      window.locator(".workspace-split.mod-root .workspace-tab-header.is-active")
    ).toHaveAttribute("aria-label", "Roadmap");

    expect(
      consoleErrors,
      `Console errors during mermaid theme/link test: ${consoleErrors.join("\n")}`
    ).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
