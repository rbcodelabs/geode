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
const testVaultPath = path.join(repoRoot, "test-vault");
const welcomePath = path.join(testVaultPath, "Welcome.md");

/** See tests/e2e/smoke.spec.ts for the full rationale behind this harness. */
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

/** Reads the active Live Preview editor's underlying markdown (the CM6 document). */
function docText(window: Page): Promise<string> {
  return window.evaluate(
    () => (window as unknown as { app: any }).app.workspace.activeLeaf.view.getText() as string
  );
}

/**
 * Each cell has two faces (see `CellDom` in src/renderer/markdown/live-preview.ts):
 * a rendered div, shown at rest, and a raw-source `<textarea>`, shown only
 * while the cell is being edited. The textarea is `display: none` at rest, so
 * a test must click the cell to enter edit mode before it can type.
 */
async function editCell(cell: Locator, value: string): Promise<void> {
  await cell.click();
  const editor = cell.locator("textarea.cm-table-cell-input");
  await expect(editor).toBeVisible();
  await editor.fill(value);
}

test("renders a GFM pipe table as an in-place editable <table> in Live Preview", async () => {
  // The Welcome.md table is edited in place, so this test restores the file's
  // original bytes afterwards to keep the checked-in test vault pristine.
  const original = fs.readFileSync(welcomePath);
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    await window.locator('.nav-file-title[data-path="Welcome.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    const widget = window.locator(".cm-table-widget");
    const table = widget.locator("table");
    await expect(table).toBeVisible();

    // Every cell carries both faces: 2 columns × (1 header + 2 data rows) = 6
    // rendered divs and 6 raw-source textareas, pre-filled from the markdown.
    await expect(window.locator("textarea.cm-table-cell-input")).toHaveCount(6);
    await expect(window.locator(".cm-table-cell-rendered")).toHaveCount(6);
    await expect(table.locator("thead th").nth(0).locator("textarea")).toHaveValue("Feature");
    await expect(table.locator("thead th").nth(1).locator("textarea")).toHaveValue("Status");
    // At rest the rendered face is what the user sees; the source is hidden.
    await expect(table.locator("thead th").nth(0).locator(".cm-table-cell-rendered")).toHaveText(
      "Feature"
    );
    await expect(table.locator("thead th").nth(0).locator("textarea")).toBeHidden();
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(
      table.locator("tbody tr").nth(0).locator("td").nth(0).locator("textarea")
    ).toHaveValue("Wikilinks");

    // The raw pipe markdown is never shown as text — the widget stays.
    const editorTextBefore = await window.locator(".cm-editor").innerText();
    expect(editorTextBefore).not.toContain("| Feature | Status |");
    expect(editorTextBefore).not.toContain("| --- | --- |");

    // Cursor entering the table's line range keeps it rendered (the block is
    // atomic; the cursor skips over it) — the old revert-to-raw behavior is
    // gone. Click the heading above, then step the cursor rightward past it.
    await window.getByText("A table", { exact: true }).click();
    await window.keyboard.press("End");
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("ArrowRight");
    await expect(widget).toBeVisible();
    await expect(table).toBeVisible();
    expect(await window.locator(".cm-editor").innerText()).not.toContain("| Feature | Status |");

    // --- Editing a cell writes back to the underlying markdown -------------
    const wikilinksCell = table.locator("tbody tr").nth(0).locator("td").nth(0);
    await editCell(wikilinksCell, "Wikilinks!");
    await wikilinksCell.locator("textarea").press("Tab"); // Tab commits + moves on
    await expect
      .poll(() => docText(window))
      .toContain("| Wikilinks! | ✅ |");
    // Leaving the cell puts the rendered face back.
    await expect(wikilinksCell.locator(".cm-table-cell-rendered")).toHaveText("Wikilinks!");

    // --- Per-column alignment toggle reflects in the delimiter row ---------
    const firstHeaderTh = table.locator("thead th").nth(0);
    await firstHeaderTh.hover();
    await firstHeaderTh.locator(".cm-table-align-btn").click(); // default → left
    await expect.poll(() => docText(window)).toContain(":---");

    // --- Add a row --------------------------------------------------------
    await widget.hover();
    await window.locator(".cm-table-addrow").click();
    await expect(table.locator("tbody tr")).toHaveCount(3);
    await expect.poll(() => docText(window)).toContain("|  |  |"); // empty row landed
    // The new row is editable too: an empty cell still has a clickable rendered
    // face, so it can be entered and typed into like any other.
    const newRowCell = table.locator("tbody tr").nth(2).locator("td").nth(0);
    await editCell(newRowCell, "Sync");
    await table.locator("thead th").nth(1).click(); // blur → commit
    await expect.poll(() => docText(window)).toContain("| Sync |");

    // --- Add a column -----------------------------------------------------
    await widget.hover();
    await window.locator(".cm-table-addcol .cm-table-ctl-btn").click();
    // 3 columns × (1 header + 3 data rows) = 12 cells.
    await expect(window.locator("textarea.cm-table-cell-input")).toHaveCount(12);
    const newHeaderCell = table.locator("thead th").nth(2);
    await editCell(newHeaderCell, "Notes");
    await newHeaderCell.locator("textarea").press("Tab");
    await expect.poll(() => docText(window)).toContain("Notes");

    // --- Delete the added row --------------------------------------------
    const addedRow = table.locator("tbody tr").nth(2);
    await addedRow.hover();
    await addedRow.locator(".cm-table-rowctl button").click();
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect.poll(() => docText(window)).not.toContain("| Sync |");

    // --- Delete the added column -----------------------------------------
    const notesTh = table.locator("thead th").nth(2);
    await notesTh.hover();
    await notesTh.locator(".cm-table-del-btn").click();
    // Back to 2 columns × (1 header + 2 data rows) = 6 cells.
    await expect(window.locator("textarea.cm-table-cell-input")).toHaveCount(6);
    const afterDelete = await docText(window);
    expect(afterDelete).not.toContain("Notes");
    // Still valid GFM: a header row, a delimiter row, and the edits held.
    expect(afterDelete).toContain("| Wikilinks! | ✅ |");
    expect(afterDelete).toMatch(/\|\s*:?-{3,}:?\s*\|/); // delimiter row present

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.writeFileSync(welcomePath, original); // restore the pristine test vault
  }
});
