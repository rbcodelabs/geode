import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureVaultPath = path.join(repoRoot, "test-vault");

/**
 * Canvas contents aren't DOM-inspectable, so this test leans on the
 * dataset-attribute test hooks GraphView exposes on its containerEl
 * (data-graph-node-count/edge-count/node-positions) instead of pixel
 * reading. See graph-view.ts's rebuild()/updateNodePositionsDataset() for
 * where those are set.
 *
 * Regression coverage for Compass feedback 397035c4-3ebd-4422-8148-193721f68df1
 * ("Cmd+G replaces the current document with no way back"): `openGraphView`
 * used to do `workspace.getLeaf(false)`, which reused the active main-pane
 * leaf and blew away whatever note was open there, with no way to get back
 * to it. It now docks Graph view in the right sidebar instead — the same
 * pattern Backlinks/Outline/Tag pane/Comments already use — so the main
 * pane, and whatever the user had open in it, is never touched.
 */
test("opens the graph view in the right sidebar without disturbing the active note, builds nodes/edges from the vault, and click-to-opens a note", async () => {
  const testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-graph-vault-"));
  fs.cpSync(fixtureVaultPath, testVaultPath, { recursive: true, filter: source => !path.relative(fixtureVaultPath, source).split(path.sep).includes(".geode") });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-graph-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
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

    // Open a note first, exactly like a user mid-session — this is the "what
    // was I looking at" state the old bug destroyed.
    await window.locator('.nav-file-title[data-path="Welcome.md"]').click();
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveText("Welcome");
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(1);

    // Open via the command palette, same path a user would take (no
    // dedicated sidebar button for it in v1).
    const isMac = process.platform === "darwin";
    await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
    await window.locator(".prompt-input").fill("Graph view");
    await window.getByText("Graph view: Open graph view").click();

    // The main pane is untouched: still exactly the one tab, still Welcome,
    // still the same view instance showing it. This is the actual bug fix —
    // before it, this main-pane tab would have been replaced by the graph.
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(1);
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveText("Welcome");
    await expect(window.locator(".workspace-split.mod-root .markdown-source-view")).toBeVisible();

    // Graph view docked in the right sidebar instead, revealed automatically
    // (matching the Calendar-plugin docked-leaf pattern — see
    // calendar-plugin.spec.ts — since GraphView, like Calendar, renders its
    // own header rather than the generic ItemView title bar).
    await expect(window.locator(".workspace-sidebar.mod-right .workspace-tab-header[aria-label=\"Graph view\"]")).toBeVisible();
    const graphView = window.locator(".workspace-sidebar.mod-right .graph-view");
    await expect(graphView).toBeVisible();
    await expect(window.locator(".workspace-sidebar.mod-right .graph-view-canvas")).toBeVisible();

    // test-vault has 5 markdown files (Welcome, Daily Plan, Projects/Roadmap,
    // Notes/Scratch, Mermaid) and 5 resolved-link edges: Welcome->Daily Plan,
    // Welcome->Roadmap, Daily Plan->Roadmap (via its ![[Projects/Roadmap#Q3]]
    // embed), Roadmap->Welcome (via "Linked from [[Welcome]]"), and
    // Mermaid->Welcome (via its trailing [[Welcome]]). Daily Plan's other
    // wikilink, [[Welcome to Geode|the welcome note]], doesn't resolve —
    // "Welcome to Geode" isn't Welcome.md's basename or an alias — so it
    // doesn't add a 6th edge.
    //
    // Mermaid.md carries that [[Welcome]] link deliberately: it keeps the
    // node *linked* rather than edgeless, which is the condition the
    // stability note below turns on.
    //
    // (Bases E2E fixtures deliberately do NOT live in the shared test-vault/
    // — bases.spec.ts writes its own Tasks/*.md fixtures into its own temp
    // vault copy instead. Adding unlinked nodes here previously destabilized
    // this test: more nodes — especially edgeless ones, which only
    // experience repulsion, no edge force pulling them back — move more
    // before the sim settles, so the position snapshot below could go stale
    // by the time the click actually lands, intermittently missing the
    // node. Confirmed via `--repeat-each=15`: ~1 in 15-20 runs failed with
    // 7 nodes; back to 4, 15/15 and 6/6 repeat runs were clean.)
    await expect(graphView).toHaveAttribute("data-graph-node-count", "5");
    await expect(graphView).toHaveAttribute("data-graph-edge-count", "5");

    // Positions populate once the force sim has run at least one tick
    // (regression coverage for the "isSettled() is trivially true before
    // any tick" bug: the RAF loop must not skip the first tick).
    await expect
      .poll(async () => {
        const raw = await graphView.getAttribute("data-graph-node-positions");
        return raw ? Object.keys(JSON.parse(raw)).length : 0;
      })
      .toBe(5);

    // Re-invoke "Open graph view" — it should reveal the existing docked
    // pane (singleton view) instead of stacking a duplicate sidebar icon or
    // pane.
    await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
    await window.locator(".prompt-input").fill("Graph view");
    await window.getByText("Graph view: Open graph view").click();
    await expect(window.locator(".workspace-sidebar.mod-right .workspace-tab-header[aria-label=\"Graph view\"]")).toHaveCount(1);
    await expect(window.locator(".workspace-sidebar.mod-right .graph-view")).toHaveCount(1);
    // Main pane still untouched by the re-invocation too.
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(1);
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveText("Welcome");

    // Click-to-open: compute Welcome.md's current screen position from its
    // world position (camera starts untransformed: pan 0,0, scale 1) and
    // click it, same as a user clicking a node. Welcome.md is already open
    // in the one main-pane tab, so this exercises "click a node whose file
    // is already the active tab" rather than opening a second tab.
    const box = (await graphView.boundingBox())!;
    const positions = JSON.parse((await graphView.getAttribute("data-graph-node-positions"))!) as Record<
      string,
      [number, number]
    >;
    const [wx, wy] = positions["Daily Plan.md"];
    await window.mouse.click(box.x + box.width / 2 + wx, box.y + box.height / 2 + wy);

    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText(
      "Daily Plan"
    );
    await expect(window.locator(".workspace-split.mod-root .markdown-source-view")).toBeVisible();
    // Still exactly one main-pane tab: clicking a graph node navigates the
    // existing tab, it doesn't open a second one, and the sidebar's graph
    // pane never became a main-pane tab.
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(1);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  }
});
