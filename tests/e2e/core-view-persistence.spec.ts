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

function makeVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-coreview-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-coreview-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\n\n[[Beta]]\n");
  fs.writeFileSync(path.join(vaultDir, "Beta.md"), "# Beta\n");
  fs.writeFileSync(path.join(vaultDir, "Everything.base"), BASE_YAML);
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
}

// Regression: `graph` and `base` had no registered view factory, so
// `restoreLeafView` fell through to its EmptyView fallback and the next
// debounced save dropped the leaf entirely — open Graph and Bases tabs simply
// vanished on relaunch.
test("restores open Graph and Bases tabs across a relaunch", async () => {
  const { vaultDir, userDataDir } = makeVault();
  try {
    let app = await launch(userDataDir);
    let win = await app.firstWindow();
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    // `openGraphView` reuses the active (unpinned) leaf, so open the Bases tab
    // second — otherwise the graph would replace it rather than sit beside it.
    const opened = await win.evaluate(async () => {
      const a = (window as any).app;
      await a.openGraphView();
      await a.openFile(a.vault.getFileByPath("Everything.base"), true);
      return {
        graph: a.workspace.getLeavesOfType("graph").length,
        base: a.workspace.getLeavesOfType("base").length,
      };
    });
    expect(opened).toEqual({ graph: 1, base: 1 });

    // Wait for the debounced (400ms) layout save to reach disk with both types.
    const workspaceFile = path.join(vaultDir, ".geode", "workspace.json");
    await expect
      .poll(
        () => {
          if (!fs.existsSync(workspaceFile)) return [];
          return JSON.stringify(JSON.parse(fs.readFileSync(workspaceFile, "utf8")))
            .match(/"type":"(graph|base)"/g) ?? [];
        },
        { timeout: 5000 }
      )
      .toEqual(expect.arrayContaining(['"type":"graph"', '"type":"base"']));
    await app.close();

    app = await launch(userDataDir);
    win = await app.firstWindow();
    const consoleErrors: string[] = [];
    win.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await expect(win.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();

    const restored = await win.evaluate(() => {
      const a = (window as any).app;
      return {
        graph: a.workspace.getLeavesOfType("graph").length,
        base: a.workspace.getLeavesOfType("base").length,
        baseFile: a.workspace.getLeavesOfType("base")[0]?.view?.getFile?.()?.path ?? null,
      };
    });
    expect(restored.graph).toBe(1);
    expect(restored.base).toBe(1);
    // The Bases tab came back pointed at the same file, not blank.
    expect(restored.baseFile).toBe("Everything.base");
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    await app.close();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
