import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const BASE_YAML = `filters:
  and: []
formulas: {}
properties: {}
summaries: {}
views:
  - type: table
    name: Table
`;
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-coreview-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-coreview-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\n\n[[Beta]]\n");
  fs.writeFileSync(path.join(vaultDir, "Beta.md"), "# Beta\n");
  fs.writeFileSync(path.join(vaultDir, "Everything.base"), BASE_YAML);
  fs.writeFileSync(path.join(vaultDir, "Preview.png"), ONE_PIXEL_PNG);
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

// Regression: `graph` and `base` had no registered view factory, so
// `restoreLeafView` fell through to its EmptyView fallback and the next
// debounced save dropped the leaf entirely — open Graph and Bases tabs simply
// vanished on relaunch. Graph's own view factory registration is now used only
// for this main-pane backward-compat path (a leaf saved before Graph moved to
// the sidebar, see graph-view.spec.ts and app.ts's openGraphView) — a *new*
// Graph invocation docks in the right sidebar instead, covered separately
// below so a fresh sidebar-docked pane doesn't regress into a duplicate on
// relaunch either.
test("restores open Bases and Image tabs across a relaunch", async () => {
  const { vaultDir, userDataDir } = makeVault();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const opened = await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Everything.base"), true);
      await a.openFile(a.vault.getFileByPath("Preview.png"), true);
      return {
        base: a.workspace.getLeavesOfType("base").length,
        image: a.workspace.getLeavesOfType("image").length,
      };
    });
    expect(opened).toEqual({ base: 1, image: 1 });

    // Wait for the debounced (400ms) layout save to reach disk with all types.
    const workspaceFile = path.join(vaultDir, ".geode", "workspace.json");
    await expect
      .poll(
        () => {
          if (!fs.existsSync(workspaceFile)) return [];
          return JSON.stringify(JSON.parse(fs.readFileSync(workspaceFile, "utf8")))
            .match(/"type":"(base|image)"/g) ?? [];
        },
        { timeout: 5000 }
      )
      .toEqual(expect.arrayContaining(['"type":"base"', '"type":"image"']));
    await app.close();
    app = undefined;

    app = await launch(userDataDir);
    win = await app.firstWindow();
    const consoleErrors: string[] = [];
    win.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const restored = await win.evaluate(() => {
      const a = (window as any).app;
      return {
        base: a.workspace.getLeavesOfType("base").length,
        image: a.workspace.getLeavesOfType("image").length,
        baseFile: a.workspace.getLeavesOfType("base")[0]?.view?.getFile?.()?.path ?? null,
        imageFile: a.workspace.getLeavesOfType("image")[0]?.view?.getFile?.()?.path ?? null,
      };
    });
    expect(restored.base).toBe(1);
    expect(restored.image).toBe(1);
    // The Bases tab came back pointed at the same file, not blank.
    expect(restored.baseFile).toBe("Everything.base");
    expect(restored.imageFile).toBe("Preview.png");
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app?.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Regression coverage for Compass feedback 397035c4-3ebd-4422-8148-193721f68df1:
// Graph view now docks a leaf in the right sidebar (`Sidebar.addLeaf` +
// `setView`, the same mechanism as a plugin's docked pane — see
// calendar-plugin.spec.ts) rather than the center pane. That leaf serializes
// like any other sidebar-docked leaf, so it must come back as exactly one
// leaf after a relaunch, not zero (the old "vanishes on relaunch" bug) and
// not two (a naive fix could double-create it: one from the persisted
// sidebar leaf, one freshly minted by `openGraphView`'s own singleton check
// if that check doesn't search sidebars — see workspace.ts's
// `findLeafByViewType`).
test("restores the sidebar-docked Graph view across a relaunch, without duplicating it", async () => {
  const { vaultDir, userDataDir } = makeVault();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const opened = await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openGraphView();
      return {
        graphLeaves: a.workspace.getLeavesOfType("graph").length,
        graphInSidebar: a.workspace.rightSidebar.leaves.some((l: any) => l.view?.viewType === "graph"),
        graphInCenter: a.workspace.getLeavesOfType("graph").some((l: any) =>
          a.workspace.groups.some((g: any) => g.leaves.includes(l))
        ),
      };
    });
    expect(opened).toEqual({ graphLeaves: 1, graphInSidebar: true, graphInCenter: false });

    // Re-invoking the command must reveal the same leaf, not mint another.
    await win.evaluate(async () => {
      await (window as any).app.openGraphView();
    });
    expect(
      await win.evaluate(() => (window as any).app.workspace.getLeavesOfType("graph").length)
    ).toBe(1);

    const workspaceFile = path.join(vaultDir, ".geode", "workspace.json");
    await expect
      .poll(
        () => {
          if (!fs.existsSync(workspaceFile)) return [];
          return JSON.stringify(JSON.parse(fs.readFileSync(workspaceFile, "utf8")))
            .match(/"type":"graph"/g) ?? [];
        },
        { timeout: 5000 }
      )
      .toEqual(['"type":"graph"']);
    await app.close();
    app = undefined;

    app = await launch(userDataDir);
    win = await app.firstWindow();
    const consoleErrors: string[] = [];
    win.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const restored = await win.evaluate(() => {
      const a = (window as any).app;
      return {
        graphLeaves: a.workspace.getLeavesOfType("graph").length,
        graphInSidebar: a.workspace.rightSidebar.leaves.some((l: any) => l.view?.viewType === "graph"),
      };
    });
    expect(restored.graphLeaves).toBe(1); // not 0 (vanished) and not 2 (duplicated)
    expect(restored.graphInSidebar).toBe(true);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app?.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
