import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function writeArtifact(dir: string, id: string, withBoard: boolean, rel: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifact.json"), JSON.stringify({
    schemaVersion: 1, id, title: id, entry: "index.html", runtime: "static", createdByThreadId: "t-board",
    viewport: { preset: "desktop", width: 1440, height: 900 }, permissions: { network: "none", clipboard: false },
  }));
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>${id}</title><main>${id}</main>`);
  if (withBoard) {
    fs.writeFileSync(path.join(dir, "board.canvas"), JSON.stringify({
      nodes: [{ id: "ab", type: "file", file: `${rel}/artifact.json`, x: 0, y: 0, width: 1440, height: 900 }], edges: [],
    }));
  }
}

test("artifact explorer open: board artifacts open board.canvas, no-board artifacts keep ArtifactView", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-board-explorer-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  writeArtifact(path.join(vaultPath, "Artifacts", "boarded"), "boarded", true, "Artifacts/boarded");
  writeArtifact(path.join(vaultPath, "Artifacts", "single"), "single", false, "Artifacts/single");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot, env: { ...process.env, GEODE_HEADLESS: "1" } });
  const window = await app.firstWindow();
  const shots = process.env.QA_SCREENSHOT_DIR ?? test.info().outputDir;
  const boardLeaves = () => window.evaluate(() => (window as any).app.workspace.getLeavesOfType("canvas").map((l: any) => l.getViewState()));
  const artifactLeaves = () => window.evaluate(() => (window as any).app.workspace.getLeavesOfType("geode-artifact").length);
  const closeAll = () => window.evaluate(() => {
    const ws = (window as any).app.workspace;
    [...ws.getLeavesOfType("canvas"), ...ws.getLeavesOfType("geode-artifact"), ...ws.getLeavesOfType("webviewer")].forEach((l: any) => l.detach());
  });
  try {
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    await window.waitForFunction(() => (window as any).app?.vault?.getAbstractFileByPath("Artifacts/boarded/board.canvas"));
    const folderRow = (p: string) => window.locator(`.nav-folder-title[data-path="${p}"]`);
    const fileRow = (p: string) => window.locator(`.nav-file-title[data-path="${p}"]`);
    await folderRow("Artifacts").click();
    const board = { type: "canvas", state: { file: "Artifacts/boarded/board.canvas" } };

    // 1. Clicking the artifact folder opens the board.
    await folderRow("Artifacts/boarded").click();
    await expect(window.locator(".canvas-node-artifact")).toHaveCount(1);
    expect(await boardLeaves()).toEqual([board]);
    expect(await artifactLeaves()).toBe(0);
    await closeAll();

    // 2. Expanding the folder (chevron) and clicking artifact.json / index.html opens the board too.
    await folderRow("Artifacts/boarded").locator(".nav-folder-arrow").click();
    await fileRow("Artifacts/boarded/artifact.json").click();
    await expect(window.locator(".canvas-node-artifact")).toHaveCount(1);
    expect(await boardLeaves()).toEqual([board]);
    await closeAll();
    await fileRow("Artifacts/boarded/index.html").click();
    await expect(window.locator(".canvas-node-artifact")).toHaveCount(1);
    expect(await boardLeaves()).toEqual([board]);
    expect(await artifactLeaves()).toBe(0);
    expect(await window.evaluate(() => (window as any).app.workspace.getLeavesOfType("webviewer").length)).toBe(0);
    await window.screenshot({ path: path.join(shots, "explorer-open-board.png") });
    await closeAll();

    // 3. The single page stays reachable: "Open artifact page" in the folder context menu.
    await folderRow("Artifacts/boarded").click({ button: "right" });
    await window.getByText("Open artifact page", { exact: true }).click();
    await expect(window.locator('.artifact-view-frame[src="geode-artifact://boarded/index.html"]')).toBeVisible();
    expect(await boardLeaves()).toEqual([]);
    await closeAll();

    // 4. Regression: a no-board artifact still opens ArtifactView, and no canvas appears.
    await folderRow("Artifacts/single").click();
    await expect(window.locator('.artifact-view-frame[src="geode-artifact://single/index.html"]')).toBeVisible();
    expect(await boardLeaves()).toEqual([]);
    expect(await artifactLeaves()).toBe(1);
    await window.screenshot({ path: path.join(shots, "explorer-open-no-board.png") });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
