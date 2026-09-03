import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * `Workspace.deserialize()` brackets each group's leaf construction with
 * `TabGroup.beginBatch()`/`endBatch()` so N restored tabs cost one tab-header
 * rebuild instead of a triangular O(N^2). These are the user-visible
 * invariants that batching must not break: every restored tab still has a
 * header, in the persisted order, with the persisted tab active, collection
 * labels intact — and rendering must still be live afterwards (a leaked
 * suppression flag would freeze every later tab render for the whole session).
 */
const NOTE_COUNT = 40;
const noteName = (index: number) => `Note-${String(index).padStart(2, "0")}`;
const ACTIVE_INDEX = 17;
/** The last five notes are restored as one named collection. */
const COLLECTION_MEMBERS = 5;

function fixture() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-restore-batching-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-restore-batching-ud-"));
  for (let i = 0; i < NOTE_COUNT; i++) {
    fs.writeFileSync(path.join(vaultDir, `${noteName(i)}.md`), `# ${noteName(i)}\n`);
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "workspace.json"),
    JSON.stringify({
      version: 3,
      center: {
        activeGroup: 0,
        root: {
          type: "tabs",
          active: ACTIVE_INDEX,
          collections: [{ id: "batch", name: "Reading", color: "purple", collapsed: false }],
          leaves: Array.from({ length: NOTE_COUNT }, (_, i) => ({
            type: "markdown",
            file: `${noteName(i)}.md`,
            ...(i >= NOTE_COUNT - COLLECTION_MEMBERS ? { collectionId: "batch" } : {}),
          })),
        },
      },
      left: { root: null },
      right: { root: null },
    })
  );
  return { vaultDir, userDataDir };
}

test("restores a large single tab group with every header, its order, and the active tab intact", async () => {
  const { vaultDir, userDataDir } = fixture();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const bar = window.locator(".workspace-split.mod-root .workspace-tab-header-container").first();
    const tabs = bar.locator(".workspace-tab-header");

    // One header per restored leaf — the single post-batch rebuild rendered
    // the whole group, not just the leaf that happened to be added last.
    await expect(tabs).toHaveCount(NOTE_COUNT);
    expect(await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual(
      Array.from({ length: NOTE_COUNT }, (_, i) => noteName(i))
    );

    // Exactly the persisted tab is active, and its content is the mounted view.
    await expect(bar.locator(".workspace-tab-header.is-active")).toHaveCount(1);
    await expect(bar.locator(".workspace-tab-header.is-active")).toHaveAttribute("aria-label", noteName(ACTIVE_INDEX));

    // Collection chrome survives a batched restore, with its full membership.
    await expect(window.locator(".tab-collection-label")).toHaveCount(1);
    await expect(window.locator(".tab-collection-surface")).toHaveAttribute(
      "aria-label",
      new RegExp(`Reading, purple, expanded, ${COLLECTION_MEMBERS} tabs`)
    );

    // Rendering is live after restore: the suppression flag did not leak.
    await tabs.nth(3).click();
    await expect(bar.locator(".workspace-tab-header.is-active")).toHaveAttribute("aria-label", noteName(3));
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Note-00.md"), true);
    });
    await expect(tabs).toHaveCount(NOTE_COUNT + 1);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
