import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultFixturePath = path.join(repoRoot, "test-vault");

const TASK_FIXTURES: { name: string; frontmatter: string; body: string }[] = [
  { name: "Alpha Task", frontmatter: "status: Todo\npriority: 1\ndone: false", body: "First task in the queue." },
  { name: "Beta Task", frontmatter: "status: In Progress\npriority: 2\ndone: false", body: "Second task, currently being worked." },
  { name: "Gamma Task", frontmatter: "status: Done\npriority: 3\ndone: true", body: "Third task, already finished." },
];

/**
 * Bases (Phase B) writes back to the vault (creating the `.base` file,
 * editing a cell's frontmatter) — unlike the read-only specs that share
 * `test-vault/` directly (smoke/graph-view/etc.), this test works against a
 * throwaway copy so it never mutates the checked-in fixtures.
 *
 * The 3 frontmatter-bearing `Tasks/*.md` fixtures this spec needs (for
 * filter/sort/group coverage against real properties) are written directly
 * into that copy here, rather than being checked into the shared
 * `test-vault/` — adding unlinked nodes there previously destabilized
 * `graph-view.spec.ts`'s force-simulation-position-based click test (more
 * nodes, especially edgeless ones, move more before the sim settles). Keeping
 * this spec's fixtures local to its own vault copy avoids that cross-test
 * coupling entirely.
 */
function makeVaultCopy(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-e2e-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });
  const tasksDir = path.join(vaultDir, "Tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const { name, frontmatter, body } of TASK_FIXTURES) {
    fs.writeFileSync(path.join(tasksDir, `${name}.md`), `---\n${frontmatter}\n---\n\n# ${name}\n\n${body}\n`);
  }
  return vaultDir;
}

test("create a base, filter/sort a Table view, and edit a cell back to frontmatter", async () => {
  const vaultDir = makeVaultCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    const consoleErrors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    // --- Create a base via the file explorer's folder context menu ---
    const tasksFolderRow = window.locator(".nav-folder-title", { hasText: "Tasks" });
    await tasksFolderRow.click({ button: "right" });
    await window.locator(".menu-item", { hasText: "New base" }).click();

    const tableContainer = window.locator(".bases-table-container");
    await expect(tableContainer).toBeVisible();
    await expect(window.locator(".bases-table thead th").first()).toHaveText("file.name");

    // Fresh base has no filters: every markdown file in the vault is a row
    // (7: Welcome, Daily Plan, Projects/Roadmap, Notes/Scratch, and the 3
    // Tasks/*.md fixtures).
    await expect(window.locator(".bases-data-row")).toHaveCount(7);
    await expect(window.locator(".bases-toolbar-results")).toHaveText("7 results");

    // --- Sort by note.priority ASC: the 3 Tasks rows (the only ones with a
    // priority) should end up as the last 3 rows, in Alpha/Beta/Gamma order ---
    await window.locator(".bases-toolbar-btn", { hasText: "Sort" }).click();
    const sortPanel = window.locator(".bases-sort-panel");
    await expect(sortPanel).toBeVisible();
    await sortPanel.locator("button.bases-filter-add", { hasText: "+ Add sort" }).click();
    await sortPanel.locator(".bases-sort-row .bases-sort-prop").first().selectOption("note.priority");
    await window.keyboard.press("Escape"); // close the panel; the sort itself already persisted on selectOption's change event

    const fileNameCells = window.locator(".bases-data-row td.bases-cell:first-child");
    await expect(fileNameCells).toHaveCount(7);
    const namesAfterSort = await fileNameCells.allInnerTexts();
    expect(namesAfterSort.slice(-3)).toEqual(["Alpha Task.md", "Beta Task.md", "Gamma Task.md"]);

    // --- Filter (this view) to note.status == "Done": only Gamma Task ---
    await window.locator(".bases-toolbar-btn", { hasText: "Filter" }).click();
    const filterPanel = window.locator(".bases-filter-panel");
    await expect(filterPanel).toBeVisible();
    const thisViewScope = filterPanel.locator(".bases-filter-scope").nth(1);
    await expect(thisViewScope.locator(".bases-filter-scope-title")).toHaveText("This view");
    await thisViewScope.locator("button.bases-filter-add", { hasText: "+ Condition" }).click();
    const conditionRow = thisViewScope.locator(".bases-filter-row").first();
    await conditionRow.locator(".bases-filter-prop").fill("note.status");
    await conditionRow.locator(".bases-filter-prop").press("Tab"); // blur -> commits the property (its handler listens for "change", not "input")
    await conditionRow.locator(".bases-filter-value").fill("Done");
    await conditionRow.locator(".bases-filter-value").press("Tab");
    await window.keyboard.press("Escape");

    await expect(window.locator(".bases-data-row")).toHaveCount(1);
    await expect(window.locator(".bases-toolbar-results")).toHaveText("1 result");
    await expect(window.locator(".bases-data-row td.bases-cell").first()).toHaveText("Gamma Task.md");

    // --- Edit a cell: bump Gamma Task's note.priority from 3 to 5 ---
    const priorityHeaderIndex = await window.locator(".bases-table thead th").allInnerTexts();
    const priorityColIndex = priorityHeaderIndex.indexOf("note.priority");
    expect(priorityColIndex).toBeGreaterThan(-1);
    const priorityCell = window.locator(".bases-data-row").first().locator("td.bases-cell").nth(priorityColIndex);
    await expect(priorityCell).toHaveText("3");
    await priorityCell.dblclick();
    const cellInput = priorityCell.locator(".bases-cell-input");
    await cellInput.fill("5");
    await cellInput.press("Enter");

    // The frontmatter write triggers a vault "modify" event -> BaseView re-queries live.
    await expect(priorityCell).toHaveText("5");

    const gammaTaskOnDisk = fs.readFileSync(path.join(vaultDir, "Tasks", "Gamma Task.md"), "utf8");
    expect(gammaTaskOnDisk).toMatch(/priority:\s*5/);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("switch a base view to Cards, render cards, and persist the type to disk", async () => {
  const vaultDir = makeVaultCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    const consoleErrors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    // --- Create a base (starts as a Table view) ---
    const tasksFolderRow = window.locator(".nav-folder-title", { hasText: "Tasks" });
    await tasksFolderRow.click({ button: "right" });
    await window.locator(".menu-item", { hasText: "New base" }).click();
    await expect(window.locator(".bases-table-container")).toBeVisible();

    // --- View menu → Change type to Cards ---
    await window.locator(".bases-view-btn").click();
    await window.locator(".menu-item", { hasText: "Change type to Cards" }).click();

    // Table container hidden, cards grid visible with one card per markdown file (7).
    const cardsContainer = window.locator(".bases-cards-container");
    await expect(cardsContainer).toBeVisible();
    await expect(window.locator(".bases-table-container")).toBeHidden();
    await expect(window.locator(".bases-card")).toHaveCount(7);

    // Card titles are the note basenames; the 3 Task fixtures should be present.
    const titles = await window.locator(".bases-card-title").allInnerTexts();
    expect(titles).toEqual(expect.arrayContaining(["Alpha Task", "Beta Task", "Gamma Task"]));

    // The row-height selector is a Table-only control and is hidden on Cards.
    await expect(window.locator(".bases-row-height-select")).toBeHidden();

    // --- The type change persisted to the .base file on disk ---
    const baseFile = fs
      .readdirSync(path.join(vaultDir, "Tasks"))
      .find((f) => f.endsWith(".base"));
    expect(baseFile, "a .base file should have been created in Tasks/").toBeTruthy();
    const baseYaml = fs.readFileSync(path.join(vaultDir, "Tasks", baseFile!), "utf8");
    expect(baseYaml).toMatch(/type:\s*cards/);

    // --- Search filters cards live: only Alpha remains ---
    await window.locator(".bases-toolbar-search").fill("Alpha");
    await expect(window.locator(".bases-card")).toHaveCount(1);
    await expect(window.locator(".bases-card-title").first()).toHaveText("Alpha Task");

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("renders an embedded ```base block and a ![[File.base]] transclusion in reading view", async () => {
  const vaultDir = makeVaultCopy();
  // A standalone .base file at the vault root (so `![[Roster.base]]` resolves
  // directly by path) plus a note that both embeds an inline base and
  // transcludes that .base file.
  fs.writeFileSync(
    path.join(vaultDir, "Roster.base"),
    "views:\n  - type: table\n    name: Roster\n"
  );
  fs.writeFileSync(
    path.join(vaultDir, "Embed.md"),
    [
      "# Embedded bases",
      "",
      "Inline base:",
      "",
      "```base",
      "views:",
      "  - type: table",
      "    name: Inline",
      "```",
      "",
      "Transcluded base:",
      "",
      "![[Roster.base]]",
      "",
    ].join("\n")
  );

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    const consoleErrors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    // Open the note, then switch to reading view (where embeds render).
    await window.locator('.nav-file-title[data-path="Embed.md"]').click();
    await window.locator('[title="Toggle reading view (Cmd/Ctrl+E)"]').click();

    // Both the inline ```base block and the ![[Roster.base]] transclusion
    // become live embedded base views, each with a toolbar and a table.
    const embeds = window.locator(".markdown-reading-view .bases-embed-view");
    await expect(embeds).toHaveCount(2);
    await expect(embeds.first().locator(".bases-toolbar")).toBeVisible();
    await expect(embeds.first().locator(".bases-table thead th").first()).toBeVisible();
    await expect(embeds.nth(1).locator(".bases-table")).toBeVisible();

    // Each embedded base ran its query against the vault and produced rows.
    await expect(embeds.first().locator(".bases-data-row").first()).toBeVisible();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Copy on the results menu puts the view on the clipboard as TSV", async () => {
  const vaultDir = makeVaultCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    const tasksFolderRow = window.locator(".nav-folder-title", { hasText: "Tasks" });
    await tasksFolderRow.click({ button: "right" });
    await window.locator(".menu-item", { hasText: "New base" }).click();
    await expect(window.locator(".bases-table-container")).toBeVisible();

    // Filter to the single Done task so the copied output is deterministic.
    await window.locator(".bases-toolbar-btn", { hasText: "Filter" }).click();
    const thisViewScope = window.locator(".bases-filter-panel .bases-filter-scope").nth(1);
    await thisViewScope.locator("button.bases-filter-add", { hasText: "+ Condition" }).click();
    const conditionRow = thisViewScope.locator(".bases-filter-row").first();
    await conditionRow.locator(".bases-filter-prop").fill("note.status");
    await conditionRow.locator(".bases-filter-prop").press("Tab");
    await conditionRow.locator(".bases-filter-value").fill("Done");
    await conditionRow.locator(".bases-filter-value").press("Tab");
    await window.keyboard.press("Escape");
    await expect(window.locator(".bases-data-row")).toHaveCount(1);

    // Results button → Copy.
    await window.locator(".bases-toolbar-results").click();
    await window.locator(".menu-item", { hasText: "Copy" }).click();

    // The menu action starts an async navigator.clipboard write. Poll the
    // main-process clipboard so the assertion cannot race that write.
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain("file.name");
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    const lines = clip.split("\n");
    expect(lines[0].split("\t")).toContain("file.name"); // header row
    expect(clip).toContain("Gamma Task.md"); // the one visible row
    expect(clip).not.toContain("Alpha Task.md"); // filtered out
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
