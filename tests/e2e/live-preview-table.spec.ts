import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");

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

test("renders a GFM pipe table as a real <table> in Live Preview, revealing raw markdown when the cursor is inside", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    await window.locator('.nav-file-title[data-path="Welcome.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    // test-vault/Welcome.md's "## A table" section renders as a real HTML
    // table, not raw "| Feature | Status |" pipe syntax.
    const tableWidget = window.locator(".cm-table-widget");
    await expect(tableWidget).toBeVisible();
    const table = tableWidget.locator("table");
    await expect(table).toBeVisible();

    const editorTextBefore = await window.locator(".cm-editor").innerText();
    expect(editorTextBefore).not.toContain("| --- | --- |");
    expect(editorTextBefore).not.toContain("| Feature | Status |");

    // Header cells and data rows are real <th>/<td> elements with the
    // expected text, styled by the shared .markdown-rendered CSS.
    await expect(table.locator("th").nth(0)).toHaveText("Feature");
    await expect(table.locator("th").nth(1)).toHaveText("Status");
    const bodyRows = table.locator("tbody tr");
    expect(await bodyRows.count()).toBe(2);
    await expect(bodyRows.nth(0).locator("td").nth(0)).toHaveText("Wikilinks");
    await expect(bodyRows.nth(1).locator("td").nth(0)).toHaveText("Backlinks");

    // Placing the cursor inside the table (click the heading right above it,
    // then step the cursor rightward into the table block, one document
    // position at a time — the table is a multi-line block widget, so
    // vertical motion jumps clean over it, but horizontal motion still
    // walks into the underlying raw text one character at a time) reveals
    // the raw pipe-table markdown — matching how other Live Preview widgets
    // (embeds, wikilinks) hide their rendered form once the cursor enters.
    await window.getByText("A table", { exact: true }).click();
    await window.keyboard.press("End");
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("ArrowRight");

    await expect(tableWidget).not.toBeVisible();
    const editorTextInside = await window.locator(".cm-editor").innerText();
    expect(editorTextInside).toContain("| --- | --- |");
    expect(editorTextInside).toContain("| Feature | Status |");

    // Moving the cursor back out (clicking the heading above) re-collapses
    // the table back into its rendered <table> form.
    await window.getByText("A table", { exact: true }).click();
    await expect(window.locator(".cm-table-widget table")).toBeVisible();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
