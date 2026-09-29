import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultFixturePath = path.join(repoRoot, "test-vault");
const NOTE = "Math Note.md";

/**
 * LaTeX math (`$inline$`, `$$block$$`) in Live Preview and Reading view.
 *
 * Runs against a throwaway copy of `test-vault/` with the fixture dropped in
 * rather than a new file in `test-vault/` itself: other specs pin that vault's
 * file list (graph node count, Bases row counts), so adding a note there
 * would break them. Same convention as `live-preview-late-table.spec.ts`.
 */
function makeVaultCopy(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-math-e2e-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "tests", "fixtures", "vault-notes", NOTE),
    path.join(vaultDir, NOTE)
  );
  return vaultDir;
}

async function launchAppAgainstVault(vaultDir: string): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-math-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
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

async function clickCenter(window: Page, locator: Locator): Promise<void> {
  const box = (await locator.boundingBox())!;
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("math renders in Live Preview: cursor toggles source, non-math and code stay literal, invalid LaTeX degrades", async () => {
  const vaultDir = makeVaultCopy();
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstVault(vaultDir);

  try {
    await window.locator(`.nav-file-title[data-path="${NOTE}"]`).click();
    const editor = window.locator(".cm-editor");
    await expect(editor).toBeVisible();

    // --- 1. Inline + block render as KaTeX -------------------------------
    // Two inline widgets: the valid `$E=mc^2$` and the invalid `$\frac{$`.
    const inlineWidgets = editor.locator(".cm-math-inline");
    await expect(inlineWidgets).toHaveCount(2);
    await expect(inlineWidgets.first().locator(".katex-html")).toBeVisible();
    const blockWidget = editor.locator(".cm-math-block");
    await expect(blockWidget).toHaveCount(1);
    await expect(blockWidget.locator(".katex-display .katex-html")).toBeVisible();

    // Raw delimiters are hidden while rendered.
    const rendered = await editor.innerText();
    expect(rendered).not.toContain("E=mc^2$");
    expect(rendered).not.toContain("\\int_0^1");

    // KaTeX's stylesheet and its inlined fonts actually load under the app CSP.
    await expect(window.locator("style#geode-katex-styles")).toHaveCount(1);
    const fontsLoaded = await window.evaluate(async () => {
      const faces = await document.fonts.load("16px KaTeX_Main");
      return faces.length;
    });
    expect(fontsLoaded).toBeGreaterThan(0);

    // --- 2. Invalid LaTeX: error-styled fallback, note keeps rendering ---
    const errorWidget = inlineWidgets.locator(".math-error");
    await expect(errorWidget).toHaveCount(1);
    await expect(errorWidget).toContainText("\\frac{");
    expect(rendered).toContain("and the note still renders.");
    expect(rendered).toContain("Last line of the note.");

    // --- 3. Non-math dollars and code stay literal ------------------------
    const line = (text: string) => editor.locator(".cm-line", { hasText: text }).first();
    await expect(line("it costs $5 today")).toBeVisible();
    await expect(line("it costs $5 today").locator(".katex")).toHaveCount(0);
    await expect(line("from $5 to $10 apiece")).toBeVisible();
    await expect(line("from $5 to $10 apiece").locator(".katex")).toHaveCount(0);
    await expect(line("stays text.")).toContainText("\\$a+b$");
    await expect(line("stays text.").locator(".katex")).toHaveCount(0);
    await expect(line("stays literal.")).toContainText("$c+d$");
    await expect(line("stays literal.").locator(".katex")).toHaveCount(0);
    // The fenced block keeps its `$$` lines and is not turned into a widget.
    await expect(editor.locator(".cm-line", { hasText: "not_math" })).toHaveCount(1);
    await expect(blockWidget).toHaveCount(1);

    // --- 4. Cursor inside inline math reveals source; leaving re-renders --
    // A real mouse click: the widget must be clickable-into, which depends on
    // `ignoreEvent()` deferring to CodeMirror.
    await clickCenter(window, inlineWidgets.first());
    await expect(inlineWidgets).toHaveCount(1); // only the invalid one remains rendered
    await expect(line("Inline math:")).toContainText("$E=mc^2$");

    await line("Last line of the note.").click();
    await expect(inlineWidgets).toHaveCount(2);
    await expect(line("sits in a sentence.").locator(".katex")).toHaveCount(1);

    // --- 5. Cursor inside a $$ block reveals its source -------------------
    await clickCenter(window, blockWidget);
    await expect(editor.locator(".cm-math-block")).toHaveCount(0);
    const revealed = await editor.innerText();
    expect(revealed).toContain("\\int_0^1 x^2");
    await line("Last line of the note.").click();
    await expect(editor.locator(".cm-math-block")).toHaveCount(1);
    expect(await editor.innerText()).not.toContain("\\int_0^1");

    // --- 6. Editing math re-renders with the new source -------------------
    await clickCenter(window, inlineWidgets.first());
    await expect(line("Inline math:")).toContainText("$E=mc^2$");
    await window.keyboard.press("End");
    // Insert a new formula after the sentence, then move away.
    await window.keyboard.type(" and $x_1$");
    await line("Last line of the note.").click();
    await expect(line("Inline math:").locator(".katex")).toHaveCount(2);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("math renders in Reading view with the same delimiter rules", async () => {
  const vaultDir = makeVaultCopy();
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstVault(vaultDir);

  try {
    await window.locator(`.nav-file-title[data-path="${NOTE}"]`).click();
    await expect(window.locator(".cm-editor")).toBeVisible();
    await window.evaluate(async () => {
      await window.app.getActiveMarkdownView()!.toggleMode();
    });
    const reading = window.locator(".markdown-reading-view");
    await expect(reading).toBeVisible();

    // Inline: the valid formula and the invalid one (error fallback).
    await expect(reading.locator(".math-inline .katex-html")).toHaveCount(1);
    await expect(reading.locator(".math-inline.math-error")).toHaveCount(1);
    await expect(reading.locator(".math-inline.math-error")).toContainText("\\frac{");

    // Block: the multi-line $$ formula becomes display math, no raw `$$` left
    // outside the code block.
    await expect(reading.locator(".math-block .katex-display .katex-html")).toHaveCount(1);
    const nonCodeText = await reading.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("pre, code, .katex-mathml").forEach((n) => n.remove());
      return clone.textContent ?? "";
    });
    expect(nonCodeText).not.toContain("\\int_0^1");

    // Non-math dollars, escaped dollars and code stay literal.
    const paragraph = (text: string) => reading.locator("p", { hasText: text }).first();
    await expect(paragraph("it costs $5 today")).toContainText("$5");
    await expect(paragraph("it costs $5 today").locator(".katex")).toHaveCount(0);
    await expect(paragraph("from $5 to $10 apiece")).toContainText("$5 to $10");
    await expect(paragraph("from $5 to $10 apiece").locator(".katex")).toHaveCount(0);
    await expect(paragraph("stays text.")).toContainText("$a+b$");
    await expect(paragraph("stays text.").locator(".katex")).toHaveCount(0);
    await expect(reading.locator("p code", { hasText: "$c+d$" })).toHaveCount(1);
    await expect(reading.locator("pre code")).toContainText("not_math");
    await expect(reading.locator("pre .katex")).toHaveCount(0);

    // A note that trails invalid LaTeX still renders after it.
    await expect(reading).toContainText("Last line of the note.");

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
