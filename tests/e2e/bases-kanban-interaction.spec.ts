import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultFixturePath = path.join(repoRoot, "test-vault");

/**
 * End-to-end proof that a real, unmodified third-party Bases plugin is
 * *interactive* in Geode — not just rendered.
 *
 * `bases-plugin-view.spec.ts` covers the read path: the board draws, columns
 * come from the groupBy property, cards carry their values. This spec covers
 * the four things that make the board usable, each of which crosses the plugin
 * API into a different part of the host:
 *
 *  - dragging a card between columns rewrites the note's frontmatter *on disk*
 *    (`fileManager.processFrontMatter`)
 *  - the per-column quick-add button creates a note in the configured folder
 *    with the column's value already set (`BasesView.createFileForView`)
 *  - clicking a card opens its note without stealing the board
 *    (`workspace.getMostRecentLeaf` / `getLeaf('tab')` /
 *    `setActiveLeaf(leaf, { focus: false })`)
 *  - a card cover image resolves and actually loads (`vault.getResourcePath`)
 *
 * Every assertion about a write reads the file back off disk. Asserting that a
 * card moved in the DOM would pass even if nothing was ever persisted, which is
 * the entire failure mode this feature has to rule out.
 *
 * The plugin under test is `kanban-bases-view` v0.10.4 (MIT), installed into
 * `test-vault/.geode/plugins/` as its shipped `main.js` bundle. Fixtures live
 * in this spec's own throwaway vault copy — `bases.spec.ts` asserts an exact
 * markdown-file count and `graph-view.spec.ts` is sensitive to added nodes.
 */

const CARDS: { name: string; status: string; owner: string }[] = [
  { name: "Draft the spec", status: "To Do", owner: "Rick" },
  { name: "Wire the registry", status: "Doing", owner: "Rick" },
  { name: "Ship the passthrough", status: "Done", owner: "Sam" },
];

const BOARD_FOLDER = "Board";

const BASE_YAML = [
  'filters: file.folder == "Board"',
  "views:",
  "  - type: kanban-view",
  "    name: Kanban",
  "    order:",
  "      - note.owner",
  "    groupByProperty: note.status",
  "    imageProperty: note.cover",
  // Enables the per-column "+" button; the plugin refuses to quick-add without it.
  `    quickAddFolder: ${BOARD_FOLDER}`,
  "",
].join("\n");

/** 1x1 opaque PNG — enough to assert a non-zero decoded width. */
const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function makeVault(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-kanban-interact-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });

  const boardDir = path.join(vaultDir, BOARD_FOLDER);
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, "cover.png"), COVER_PNG);
  for (const { name, status, owner } of CARDS) {
    fs.writeFileSync(
      path.join(boardDir, `${name}.md`),
      // `owner` is deliberately unrelated to the drag: it must survive untouched.
      `---\nstatus: ${status}\nowner: ${owner}\ncover: "[[cover.png]]"\n---\n\n# ${name}\n\nBody text.\n`
    );
  }
  fs.writeFileSync(path.join(vaultDir, "Board.base"), BASE_YAML);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["kanban-bases-view"]));
  return vaultDir;
}

function readNote(vaultDir: string, name: string): string {
  return fs.readFileSync(path.join(vaultDir, BOARD_FOLDER, `${name}.md`), "utf8");
}

/**
 * Drive the card drag the way SortableJS actually consumes it.
 *
 * The board uses SortableJS in its default *native* HTML5 drag mode
 * (`forceFallback` is not set, and Chromium supports `draggable`). Two things
 * follow, both established by experiment rather than assumption:
 *
 *  - `locator.dragTo()` and raw `mouse.down/move/up` do not work here. They get
 *    as far as `dragstart` — the card picks up Sortable's `chosen` class — but
 *    no `dragover`/`drop` ever reaches the page, because Electron hands the
 *    native drag to the OS and Playwright's drag interception does not follow
 *    it. The card silently lands back where it started.
 *  - the events cannot be dispatched in one synchronous burst either.
 *    Sortable's `_onDragStart` defers `_dragStarted` through `setTimeout(0)`,
 *    and `Sortable.active` is only assigned there; a `dragover` arriving in the
 *    same task is dropped on the floor. Hence the awaits between phases.
 *
 * So the gesture is synthesised as three phases across separate tasks, sharing
 * one `DataTransfer` (Sortable reads the drag through it). What this exercises
 * is everything from Sortable's drop handling inward — `handleCardDrop`,
 * `parsePropertyId`, `fileManager.processFrontMatter`, the vault write — which
 * is precisely the plugin-to-host contract under test. The mouse-to-`dragstart`
 * leg belongs to Chromium.
 */
async function dragCardToColumn(window: Page, cardPath: string, targetStatus: string): Promise<void> {
  const dragState = "__geodeKanbanDragTransfer";

  // Phase 1 — grab the card and start the drag.
  await window.evaluate(
    ({ cardPath: from, dragState: key }) => {
      const card = document.querySelector<HTMLElement>(`.obk-card[data-entry-path="${from}"]`);
      if (!card) throw new Error(`No card at ${from}`);
      const dataTransfer = new DataTransfer();
      (window as unknown as Record<string, DataTransfer>)[key] = dataTransfer;
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { cardPath, dragState }
  );
  // Let Sortable's deferred `_dragStarted` run and publish `Sortable.active`.
  await window.waitForTimeout(100);

  // Phase 2 — hover the destination. Sortable decides the insertion point from
  // the event target plus its coordinates, so aim at the bottom edge of the
  // column's last card (or the empty body) to append.
  await window.evaluate(
    ({ targetStatus: status, dragState: key }) => {
      const body = document.querySelector<HTMLElement>(
        `.obk-column[data-column-value="${status}"] .obk-column-body`
      );
      if (!body) throw new Error(`No column body for ${status}`);
      const over = body.querySelector<HTMLElement>(".obk-card:last-child") ?? body;
      const rect = over.getBoundingClientRect();
      const dataTransfer = (window as unknown as Record<string, DataTransfer>)[key];
      const fire = (type: string) =>
        over.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height - 2,
          })
        );
      fire("dragenter");
      fire("dragover");
    },
    { targetStatus, dragState }
  );
  await window.waitForTimeout(100);

  // Phase 3 — drop. `onEnd` is what calls back into the plugin's write path.
  await window.evaluate(
    ({ cardPath: from, targetStatus: status, dragState: key }) => {
      const card = document.querySelector<HTMLElement>(`.obk-card[data-entry-path="${from}"]`);
      const body = document.querySelector<HTMLElement>(
        `.obk-column[data-column-value="${status}"] .obk-column-body`
      );
      if (!card || !body) throw new Error("Card or target column vanished mid-drag");
      const dataTransfer = (window as unknown as Record<string, DataTransfer>)[key];
      const fire = (el: HTMLElement, type: string) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      fire(body, "drop");
      fire(card, "dragend");
    },
    { cardPath, targetStatus, dragState }
  );
}

async function launch(vaultDir: string): Promise<{ app: ElectronApplication; userDataDir: string }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-kanban-interact-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  return { app, userDataDir };
}

test("a plugin Bases view can write the vault: drag, quick-add, open and cover images", async () => {
  const vaultDir = makeVault();
  const { app, userDataDir } = await launch(vaultDir);

  try {
    const window = await app.firstWindow();
    const consoleErrors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
    await window.locator('.nav-file-title[data-path="Board.base"]').click();
    await expect(window.locator(".obk-board")).toBeVisible();
    await expect(window.locator(".obk-card")).toHaveCount(CARDS.length);

    // ---------------------------------------------------------------------
    // Cover images: `vault.getResourcePath(file)` must return a URL the
    // renderer can actually load, not merely a plausible-looking string.
    // ---------------------------------------------------------------------
    const coverImg = window
      .locator('.obk-card[data-entry-path="Board/Draft the spec.md"] .obk-card-cover img')
      .first();
    await expect(coverImg).toHaveAttribute("src", /^file:\/\/.*cover\.png$/);
    await expect
      .poll(() => coverImg.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        message: "card cover image never decoded",
      })
      .toBeGreaterThan(0);

    // ---------------------------------------------------------------------
    // Drag "Draft the spec" from To Do to Done. The board updating is not the
    // claim under test — the note on disk is.
    // ---------------------------------------------------------------------
    expect(readNote(vaultDir, "Draft the spec")).toContain("status: To Do");

    await dragCardToColumn(window, "Board/Draft the spec.md", "Done");

    await expect
      .poll(() => readNote(vaultDir, "Draft the spec"), {
        message: "frontmatter on disk was never rewritten by the drag",
        timeout: 10_000,
      })
      .toContain("status: Done");

    const moved = readNote(vaultDir, "Draft the spec");
    // Unrelated keys and the note body survive: this is a patch, not a rewrite.
    expect(moved).toContain("owner: Rick");
    expect(moved).toContain('cover: "[[cover.png]]"');
    expect(moved).toContain("Body text.");
    // Untouched notes stay untouched.
    expect(readNote(vaultDir, "Wire the registry")).toContain("status: Doing");
    expect(readNote(vaultDir, "Ship the passthrough")).toContain("status: Done");

    // The board reflects the same state it just persisted.
    await expect(
      window.locator('.obk-column[data-column-value="Done"] .obk-card[data-entry-path="Board/Draft the spec.md"]')
    ).toHaveCount(1);
    await expect(window.locator('.obk-column[data-column-value="To Do"] .obk-card')).toHaveCount(0);

    // ---------------------------------------------------------------------
    // Quick add: `createFileForView` writes a new note into the configured
    // folder, with the column's value already applied.
    // ---------------------------------------------------------------------
    const newCardPath = path.join(vaultDir, BOARD_FOLDER, "Quick added card.md");
    expect(fs.existsSync(newCardPath)).toBe(false);

    await window.locator('.obk-column[data-column-value="Doing"] .obk-column-add-btn').click();
    const quickAddInput = window.locator(".modal input[type='text'], .modal-container input").first();
    await quickAddInput.fill("Quick added card");
    await quickAddInput.press("Enter");

    await expect
      .poll(() => fs.existsSync(newCardPath), {
        message: "quick add never created a note in the configured folder",
        timeout: 10_000,
      })
      .toBe(true);
    // Created in the folder the view configured, with the clicked column's value.
    expect(fs.readFileSync(newCardPath, "utf8")).toContain("status: Doing");
    await expect(
      window.locator('.obk-column[data-column-value="Doing"] .obk-card[data-entry-path="Board/Quick added card.md"]')
    ).toHaveCount(1);

    // ---------------------------------------------------------------------
    // Middle-clicking a card opens its note *behind* the board. This is the
    // getMostRecentLeaf() -> getLeaf('tab') -> setActiveLeaf(prev, {focus:false})
    // sequence: three methods that did not exist, or did not take these
    // arguments, before. The board staying in front is the whole point — the
    // new tab is created active, and only the restore puts the board back.
    // ---------------------------------------------------------------------
    await window
      .locator('.obk-card[data-entry-path="Board/Wire the registry.md"]')
      .click({ button: "middle" });

    await expect(window.locator('.workspace-tab-header[aria-label="Wire the registry"]')).toHaveCount(1);
    await expect(window.locator(".obk-board")).toBeVisible();
    await expect(window.locator(".obk-card")).toHaveCount(CARDS.length + 1);

    // ---------------------------------------------------------------------
    // A plain click opens the note in place, via `workspace.openLinkText` —
    // the board is replaced, matching what a click does anywhere else.
    // ---------------------------------------------------------------------
    await window.locator('.obk-card[data-entry-path="Board/Ship the passthrough.md"]').click();

    await expect(window.locator(".obk-board")).toBeHidden();
    await expect(window.locator(".view-header-title").first()).toHaveText("Ship the passthrough");

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
