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
const noteFixtureDir = path.join(repoRoot, "tests", "fixtures", "vault-notes");

const NOTE = "Table With Inline Markdown.md";

/**
 * Coverage for the two symptoms that motivated replacing each table cell's
 * single `<input>` with a rendered-markdown div plus a raw-source `<textarea>`
 * (see `CellDom` in src/renderer/markdown/live-preview.ts):
 *
 *   1. long cell content was clipped, because an `<input>` cannot wrap;
 *   2. inline markdown showed as literal source, because `input.value = raw`
 *      can only ever hold a string.
 *
 * Like `live-preview-late-table.spec.ts`, the fixture lives in
 * `tests/fixtures/vault-notes/` and is copied into a throwaway vault rather
 * than added to `test-vault/`: that vault's file list is pinned by other specs
 * (`graph-view.spec.ts` asserts 4 graph nodes, `bases.spec.ts` 7 rows,
 * `smoke.spec.ts` "Linked mentions (1)"), so a fifth markdown file breaks them.
 */
function makeVaultCopy(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-table-inline-e2e-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });
  fs.copyFileSync(path.join(noteFixtureDir, NOTE), path.join(vaultDir, NOTE));
  return vaultDir;
}

async function launchAppAgainstVault(vaultDir: string): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-table-inline-ud-"));
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

/** Reads the active Live Preview editor's underlying markdown (the CM6 document). */
function docText(window: Page): Promise<string> {
  return window.evaluate(
    () => (window as unknown as { app: any }).app.workspace.activeLeaf.view.getText() as string
  );
}

/** Path of the file currently shown in the active leaf. */
function activePath(window: Page): Promise<string | undefined> {
  return window.evaluate(
    () => (window as unknown as { app: any }).app.workspace.activeLeaf.view.file?.path as string
  );
}

/** Outer height of a cell's rendered face, in CSS pixels. */
async function renderedHeight(cell: Locator): Promise<number> {
  return cell
    .locator(".cm-table-cell-rendered")
    .evaluate((el) => el.getBoundingClientRect().height);
}

test("renders inline markdown in table cells and wraps long cell text", async () => {
  const vaultDir = makeVaultCopy();
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstVault(vaultDir);

  try {
    await window.locator(`.nav-file-title[data-path="${NOTE}"]`).click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    const widget = window.locator(".cm-table-widget");
    const table = widget.locator("table");
    await expect(table).toBeVisible();

    const markdownCell = table.locator("tbody tr").nth(0).locator("td").nth(0);
    const linkCell = table.locator("tbody tr").nth(1).locator("td").nth(0);
    const longCell = table.locator("tbody tr").nth(1).locator("td").nth(1);
    const shortCell = table.locator("tbody tr").nth(0).locator("td").nth(1);

    // --- 1. Unfocused cells show *rendered* markdown, not source -----------
    await expect(markdownCell.locator(".cm-table-cell-rendered strong")).toHaveText("Bold");
    await expect(markdownCell.locator(".cm-table-cell-rendered code")).toHaveText("code");
    await expect(linkCell.locator("a.internal-link")).toHaveText("Daily Plan");
    await expect(linkCell.locator("a.internal-link")).toHaveAttribute("data-href", "Daily Plan");
    await expect(linkCell.locator("a.tag")).toHaveText("#getting-started");

    const editorText = await window.locator(".cm-editor").innerText();
    expect(editorText).not.toContain("**Bold**");
    expect(editorText).not.toContain("[[Daily Plan]]");
    expect(editorText).not.toContain("`code`");
    expect(editorText).not.toContain("| Item | Detail |");
    // The tag renders with its `#`, but not as the raw `[[…]]`/`**…**` source.
    expect(editorText).toContain("#getting-started");

    // --- 3. Long cell wraps instead of being clipped (symptom 1) -----------
    const longHeight = await renderedHeight(longCell);
    const shortHeight = await renderedHeight(shortCell);
    expect(shortHeight).toBeGreaterThan(0);
    expect(longHeight).toBeGreaterThanOrEqual(shortHeight * 2);
    // Nothing overflows horizontally: the text wrapped rather than scrolled.
    const overflow = await longCell
      .locator(".cm-table-cell-rendered")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // And the table as a whole stays inside the editor's content width.
    const fits = await window.evaluate(() => {
      const t = document.querySelector(".cm-table-widget table")!;
      const content = document.querySelector(".cm-editor .cm-content")!;
      return t.getBoundingClientRect().width <= content.getBoundingClientRect().width + 1;
    });
    expect(fits).toBe(true);

    // --- 4. Focus + blur with no edit leaves the document byte-identical ---
    // The highest-value regression here: it proves the render/edit swap never
    // lossily normalizes cell source, and that `commit()` still skips a no-op.
    const before = await docText(window);
    await markdownCell.click();
    await expect(markdownCell.locator("textarea")).toBeVisible();
    // --- 2. A focused cell shows the *raw* source -------------------------
    await expect(markdownCell.locator("textarea")).toHaveValue("**Bold** and `code`");
    await window.getByText("Sentinel paragraph after the table.", { exact: true }).click();
    await expect(markdownCell.locator("textarea")).toBeHidden();
    // …and blurring restores the rendered face.
    await expect(markdownCell.locator(".cm-table-cell-rendered strong")).toHaveText("Bold");
    expect(await docText(window)).toEqual(before);

    // --- 6. Editing a markdown cell writes raw source back ----------------
    await markdownCell.click();
    await markdownCell.locator("textarea").fill("**Bolder** and `code`");
    await window.getByText("Sentinel paragraph after the table.", { exact: true }).click();
    await expect.poll(() => docText(window)).toContain("| **Bolder** and `code` | short |");
    await expect(markdownCell.locator(".cm-table-cell-rendered strong")).toHaveText("Bolder");

    // --- Multi-line input collapses to one line ---------------------------
    // A `<textarea>` can receive a hard newline (by paste) where the old
    // `<input>` could not. Left alone it would make `serializeTable` emit a
    // row split across two lines, which the next `parseTable` rejects —
    // silently destroying the widget and the table's structure.
    await markdownCell.click();
    const markdownEditor = markdownCell.locator("textarea");
    await markdownEditor.fill("");
    await window.keyboard.insertText("first\nsecond");
    await expect(markdownEditor).toHaveValue("first second");
    await window.getByText("Sentinel paragraph after the table.", { exact: true }).click();
    await expect.poll(() => docText(window)).toContain("| first second | short |");
    // The table survived intact — still one widget with all three data rows.
    await expect(window.locator(".cm-table-widget")).toHaveCount(1);
    await expect(table.locator("tbody tr")).toHaveCount(3);

    // --- 5a. Clicking a tag opens search and does NOT enter edit mode -----
    // CodeMirror never routes events into a widget whose `ignoreEvent()` is
    // true, so these anchors are handled by the widget's own delegated
    // mousedown listener — which must consume the click before the cell's
    // enter-edit handler sees it.
    await linkCell.locator("a.tag").click();
    await expect(window.locator(".search-view .search-input")).toHaveValue("tag:getting-started");
    await expect(window.locator(".cm-table-widget .is-editing")).toHaveCount(0);

    // --- 5b. Clicking a wikilink navigates --------------------------------
    // Done last: it switches the active file away from this note.
    await linkCell.locator("a.internal-link").click();
    await expect.poll(() => activePath(window)).toBe("Daily Plan.md");

    // --- 7. No console errors anywhere in the flow ------------------------
    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
