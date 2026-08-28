import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultFixturePath = path.join(repoRoot, "test-vault");
const noteFixtureDir = path.join(repoRoot, "tests", "fixtures", "vault-notes");

const LONG_NOTE = "Long Note With A Late Table.md";
const SHORT_NOTE = "Short Note With A Table.md";

/**
 * Both specs here mutate the note they open (the second one deliberately, the
 * first one incidentally via CodeMirror's own save-on-change), so — exactly
 * like `bases.spec.ts` — they run against a throwaway copy of `test-vault/`
 * with their fixtures dropped in, rather than against the checked-in vault.
 *
 * The fixtures deliberately do NOT live in `test-vault/` itself: that vault's
 * file list is asserted by other specs (`graph-view.spec.ts` pins
 * `data-graph-node-count` to 4; `bases.spec.ts` pins the unfiltered base to 7
 * rows), and adding a fifth markdown file breaks both. This mirrors the
 * convention already documented in `graph-view.spec.ts` and `bases.spec.ts`.
 */
function makeVaultCopy(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-late-table-e2e-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });
  for (const name of [LONG_NOTE, SHORT_NOTE]) {
    fs.copyFileSync(path.join(noteFixtureDir, name), path.join(vaultDir, name));
  }
  return vaultDir;
}

async function launchAppAgainstVault(vaultDir: string): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-late-table-ud-"));
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

/**
 * Regression coverage for the stale-syntax-tree bug: CodeMirror parses only
 * `Work.InitViewport` (3000) characters synchronously when the editor state is
 * created, and its `ParseWorker` extends the tree afterwards inside idle
 * callbacks, publishing each longer tree through a transaction with **no**
 * document change. `tableField.update` used to bail on `!tr.docChanged`, so a
 * table starting past the initial parse frontier never became a widget — it
 * stayed as raw pipe text until something forced a fresh field `create()`
 * (e.g. toggling source mode).
 */
test("renders a table that starts past the initial parse frontier, with no user input", async () => {
  const vaultDir = makeVaultCopy();
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstVault(vaultDir);

  try {
    await window.locator(`.nav-file-title[data-path="${LONG_NOTE}"]`).click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    // Sanity-check the fixture actually clears the 3000-char synchronous
    // parse budget — otherwise this test would pass for the wrong reason.
    const text = await docText(window);
    expect(text.indexOf("| Metric | Value |")).toBeGreaterThan(4000);

    // Scroll the table into view. CodeMirror only builds DOM for its current
    // viewport, so the widget can't be asserted from 4800 characters away —
    // but scrolling is *not* the input under test: it changes no document and
    // dispatches no change transaction. Before the fix, scrolling here left
    // the raw pipe markdown on screen indefinitely, because the only thing
    // that then advances the syntax tree is ParseWorker's no-doc-change
    // transaction, which `tableField.update` discarded.
    await window.locator(".cm-scroller").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    // No clicking into the note, no typing, no mode toggle: the widget must
    // appear on its own once ParseWorker publishes a tree long enough to
    // contain the Table node.
    const widget = window.locator(".cm-table-widget");
    const table = widget.locator("table");
    await expect(table).toBeVisible();
    await expect(table.locator("thead th").nth(0).locator("textarea")).toHaveValue("Metric");
    await expect(table.locator("thead th").nth(1).locator("textarea")).toHaveValue("Value");
    await expect(table.locator("tbody tr")).toHaveCount(2);

    // The raw pipe markdown is replaced, not merely supplemented.
    expect(await window.locator(".cm-editor").innerText()).not.toContain("| Metric | Value |");

    // The document itself is untouched — rendering must not rewrite the note.
    expect(await docText(window)).toEqual(text);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

/**
 * Regression coverage for the `TableWidget` stale-coordinate bug.
 *
 * `computeTables` allocates a fresh `TableWidget` per recompute, but only the
 * first instance ever owns DOM — `toDOM` stores `root`/`view` and every cell
 * listener closes over that instance. `eq()` used to sync `from`/`to` from the
 * incoming widget as a side effect, but `RangeSet.compare` calls
 * `oldWidget.eq(newWidget)` where "old" is the *previous decoration set*: from
 * the second recompute onwards that is an orphan, so the live widget's cached
 * coordinates froze while the decoration range kept mapping correctly. Its
 * next `commit()` then overwrote the wrong slice of the document.
 *
 * Three keystrokes above the table are enough to desynchronise it by two
 * characters. This fixture's table is near the top of a short note so it is
 * inside the synchronous parse budget: this test isolates the coordinate bug
 * and does not depend on the late-parse fix above.
 */
test("editing a cell after typing above the table does not corrupt the document", async () => {
  const vaultDir = makeVaultCopy();
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstVault(vaultDir);

  try {
    await window.locator(`.nav-file-title[data-path="${SHORT_NOTE}"]`).click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    const widget = window.locator(".cm-table-widget");
    const table = widget.locator("table");
    await expect(table).toBeVisible();

    // --- Type above the table, one keystroke = one transaction -------------
    await window.getByText("Intro line.", { exact: true }).click();
    await window.keyboard.press("End");
    await window.keyboard.type("ABC", { delay: 40 });
    await expect.poll(() => docText(window)).toContain("Intro line.ABC");

    // --- Now edit a cell and blur it, forcing a commit --------------------
    // The raw-source textarea is hidden until the cell is clicked into — see
    // `CellDom` in src/renderer/markdown/live-preview.ts.
    const alphaCell = table.locator("tbody tr").nth(0).locator("td").nth(0);
    await alphaCell.click();
    await alphaCell.locator("textarea").fill("alphaX");
    await table.locator("thead th").nth(0).click(); // blur → commit
    await expect.poll(() => docText(window)).toContain("| alphaX | one |");

    // --- The rest of the document must be exactly as it was ---------------
    const after = await docText(window);
    expect(after).toContain("# Table Coordinate Regression");
    expect(after).toContain("Intro line.ABC"); // not clipped by an off-by-N write
    expect(after).toContain("| Name | Value |");
    expect(after).toContain("| beta | two |");
    expect(after).toContain("Sentinel paragraph after the table.");
    // No orphaned fragment of the old table left dangling outside it.
    expect(after).toEqual(
      "# Table Coordinate Regression\n\nIntro line.ABC\n\n" +
        "| Name | Value |\n| --- | --- |\n| alphaX | one |\n| beta | two |\n\n" +
        "Sentinel paragraph after the table.\n"
    );

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});
