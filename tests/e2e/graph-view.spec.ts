import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");

/**
 * Canvas contents aren't DOM-inspectable, so this test leans on the
 * dataset-attribute test hooks GraphView exposes on its containerEl
 * (data-graph-node-count/edge-count/node-positions) instead of pixel
 * reading. See graph-view.ts's rebuild()/updateNodePositionsDataset() for
 * where those are set.
 */
test("opens the graph view, builds nodes/edges from the vault, and click-to-opens a note", async () => {
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

    // Open via the command palette, same path a user would take (no
    // dedicated sidebar button for it in v1).
    const isMac = process.platform === "darwin";
    await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
    await window.locator(".prompt-input").fill("Graph view");
    await window.getByText("Graph view: Open graph view").click();

    const graphView = window.locator(".graph-view");
    await expect(graphView).toBeVisible();
    await expect(window.locator(".graph-view-canvas")).toBeVisible();

    // test-vault has 4 markdown files (Welcome, Daily Plan, Projects/Roadmap, Notes/Scratch)
    // and 4 resolved-link edges: Welcome->Daily Plan, Welcome->Roadmap,
    // Daily Plan->Roadmap (via its ![[Projects/Roadmap#Q3]] embed), and
    // Roadmap->Welcome (via "Linked from [[Welcome]]"). Daily Plan's other
    // wikilink, [[Welcome to Geode|the welcome note]], doesn't resolve —
    // "Welcome to Geode" isn't Welcome.md's basename or an alias — so it
    // doesn't add a 5th edge.
    await expect(graphView).toHaveAttribute("data-graph-node-count", "4");
    await expect(graphView).toHaveAttribute("data-graph-edge-count", "4");

    // Positions populate once the force sim has run at least one tick
    // (regression coverage for the "isSettled() is trivially true before
    // any tick" bug: the RAF loop must not skip the first tick).
    await expect
      .poll(async () => {
        const raw = await graphView.getAttribute("data-graph-node-positions");
        return raw ? Object.keys(JSON.parse(raw)).length : 0;
      })
      .toBe(4);

    // Open a second, unrelated tab, then re-invoke "Open graph view" — it
    // should switch back to the existing graph tab (singleton view)
    // instead of stacking a duplicate "Graph view" tab.
    await window.keyboard.press(isMac ? "Meta+T" : "Control+T");
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(2);
    await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
    await window.locator(".prompt-input").fill("Graph view");
    await window.getByText("Graph view: Open graph view").click();
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(2); // still 2, not 3
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title:text-is('Graph view')")).toHaveCount(1);
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText(
      "Graph view"
    );

    // Click-to-open: compute Welcome.md's current screen position from its
    // world position (camera starts untransformed: pan 0,0, scale 1) and
    // click it, same as a user clicking a node.
    const box = (await graphView.boundingBox())!;
    const positions = JSON.parse((await graphView.getAttribute("data-graph-node-positions"))!) as Record<
      string,
      [number, number]
    >;
    const [wx, wy] = positions["Welcome.md"];
    await window.mouse.click(box.x + box.width / 2 + wx, box.y + box.height / 2 + wy);

    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText(
      "Welcome"
    );
    await expect(window.locator(".markdown-source-view")).toBeVisible();
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header-inner-title")).toHaveCount(2); // the other tab is untouched

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
