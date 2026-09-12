import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultFixturePath = path.join(repoRoot, "test-vault");

/**
 * End-to-end proof that a real, unmodified third-party Bases plugin loads in
 * Geode and renders a board.
 *
 * The plugin under test is `kanban-bases-view` v0.10.4 (MIT), installed into
 * `test-vault/.geode/plugins/` as its shipped `main.js` bundle — not a
 * hand-written stand-in. It is the reason this whole series exists, and it
 * exercises the parts that are hard to unit test:
 *
 *  - the DOM prototype extensions (`el.on(type, selector, fn)`, `node.doc`,
 *    `node.instanceOf(Type)`), all of which run inside `KanbanView`'s
 *    constructor before anything else — vitest runs the `node` environment
 *    with no jsdom, so this is their only coverage
 *  - `registerBasesView` and the registry dispatch in `BaseView`
 *  - `BasesViewConfig.getAsPropertyId` reading `groupByProperty` out of the
 *    `.base` passthrough bag
 *  - `BasesEntry.getValue` evaluating a property that is deliberately NOT in
 *    `view.order` (the grouping property) — if that returned nothing, every
 *    card would land in a single "Uncategorized" column
 *
 * Fixtures live in this spec's own throwaway vault copy rather than in the
 * shared `test-vault/`: `bases.spec.ts` asserts an exact markdown-file count
 * and `graph-view.spec.ts` is sensitive to added nodes, so checking these
 * notes in would break both. The plugin *directory* is checked in (disabled by
 * default, exactly like `status-probe`), which adds no markdown files.
 */

const CARDS: { name: string; status: string; owner: string; points: number }[] = [
  { name: "Draft the spec", status: "To Do", owner: "Rick", points: 3 },
  { name: "Wire the registry", status: "Doing", owner: "Rick", points: 5 },
  { name: "Ship the passthrough", status: "Done", owner: "Sam", points: 2 },
  { name: "Review the value layer", status: "To Do", owner: "Sam", points: 1 },
];

const BASE_YAML = [
  'filters: file.folder == "Board"',
  "properties:",
  "  note.owner:",
  "    displayName: Assignee",
  "views:",
  "  - type: kanban-view",
  "    name: Kanban",
  "    order:",
  "      - note.owner",
  "      - note.points",
  // Not a key Geode models — it survives only because `.base` parsing keeps
  // unknown keys, and it is what the plugin groups columns by.
  "    groupByProperty: note.status",
  "  - type: table",
  "    name: Table",
  "    order:",
  "      - file.name",
  "      - note.status",
  "",
].join("\n");

function makeVault(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-plugin-e2e-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });

  const boardDir = path.join(vaultDir, "Board");
  fs.mkdirSync(boardDir, { recursive: true });
  for (const { name, status, owner, points } of CARDS) {
    fs.writeFileSync(
      path.join(boardDir, `${name}.md`),
      `---\nstatus: ${status}\nowner: ${owner}\npoints: ${points}\n---\n\n# ${name}\n`
    );
  }
  fs.writeFileSync(path.join(vaultDir, "Board.base"), BASE_YAML);

  // Enable the checked-in plugin, the same way PluginManager persists it.
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["kanban-bases-view"])
  );
  return vaultDir;
}

test("renders a Kanban board from a .base file via a real third-party Bases plugin", async () => {
  const vaultDir = makeVault();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-bases-plugin-e2e-ud-"));
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

    // --- Open the .base file; the registry hands rendering to the plugin ---
    await window.locator('.nav-file-title[data-path="Board.base"]').click();

    const board = window.locator(".obk-board");
    await expect(board).toBeVisible();
    // The built-in layouts must be out of the way, not stacked underneath.
    await expect(window.locator(".bases-table-container")).toBeHidden();
    await expect(window.locator(".bases-cards-container")).toBeHidden();

    // --- Columns come from the groupBy property, which is NOT in view.order.
    // Three distinct statuses, and no "Uncategorized" catch-all (which is what
    // a failed getValue would produce). ---
    const columnTitles = window.locator(".obk-column-title");
    await expect(columnTitles).toHaveCount(3);
    await expect(columnTitles).toHaveText(["Doing", "Done", "To Do"]);

    // --- Every note is a card, in the right column ---
    await expect(window.locator(".obk-card")).toHaveCount(CARDS.length);
    for (const { name, status } of CARDS) {
      const column = window.locator(`.obk-column[data-column-value="${status}"]`);
      await expect(column.locator(".obk-card-title", { hasText: name })).toHaveCount(1);
    }
    await expect(
      window.locator('.obk-column[data-column-value="To Do"] .obk-card')
    ).toHaveCount(2);

    // --- Card properties render through the Value layer, and pick up the
    // user's displayName override from the .base `properties` block ---
    const firstCard = window.locator('.obk-card[data-entry-path="Board/Draft the spec.md"]');
    await expect(firstCard.locator('.obk-card-property[data-label="note.owner"]')).toContainText("Rick");
    await expect(firstCard.locator(".obk-card-property-label").first()).toHaveText("Assignee");
    await expect(firstCard.locator('.obk-card-property[data-label="note.points"]')).toContainText("3");

    // --- The toolbar does not offer built-in-only affordances for a
    // plugin-rendered view: no table/cards type toggle, no row-height select ---
    await expect(window.locator(".bases-row-height-select")).toBeHidden();
    await window.locator(".bases-view-btn").click();
    await expect(window.locator(".menu-item", { hasText: "Change type to" })).toHaveCount(0);

    // --- Switching to the built-in Table view tears the plugin view down and
    // hands the screen back, rather than leaving both rendered ---
    // Exact aria-label, not hasText: the menu also carries "+ New table view",
    // and the *current* view's entry is prefixed with a "●" bullet.
    await window.locator('.menu-item[aria-label="Table"]').click();
    await expect(window.locator(".bases-table-container")).toBeVisible();
    await expect(window.locator(".obk-board")).toBeHidden();

    // --- ...and switching back re-renders the board ---
    await window.locator(".bases-view-btn").click();
    await window.locator('.menu-item[aria-label="Kanban"]').click();
    await expect(window.locator(".obk-board")).toBeVisible();
    await expect(window.locator(".obk-card")).toHaveCount(CARDS.length);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
