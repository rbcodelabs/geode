import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Regression for the design-canvas end-to-end check: a plugin opens a board with
 * `host.openView({ type: "canvas", state: { file } })`, which resolves to
 * `WorkspaceLeaf.setViewState` (Obsidian-native behaviour). Geode used to throw
 * `No view registered for type "canvas"`. This spec deliberately never uses
 * `openFile`. It also checks that a live (Interact) artboard fills its frame.
 */
test("setViewState({type:'canvas', state:{file}}) opens a board; live artboard guest fills the frame", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-openview-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-openview-user-"));
  const folderRel = "Artifacts/threads-artifacts/board-one";
  const dir = path.join(vaultDir, folderRel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifact.json"), JSON.stringify({
    schemaVersion: 1, id: "board-one", title: "Board One", entry: "index.html", runtime: "static",
    createdByThreadId: "t1", viewport: { preset: "desktop", width: 1440, height: 900 },
    permissions: { network: "none", clipboard: false },
  }));
  // Background on <body> only, no explicit height: it must propagate to the whole viewport.
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><body style="margin:0;background:rgb(0,128,0)"><h1>Home</h1></body>`);
  fs.writeFileSync(path.join(dir, "board.canvas"), JSON.stringify({
    nodes: [{ id: "ab", type: "file", file: `${folderRel}/artifact.json`, x: 0, y: 0, width: 1440, height: 900 }],
    edges: [],
  }));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot, env: { ...process.env, GEODE_HEADLESS: "1" } });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const boardRel = `${folderRel}/board.canvas`;

    const error = await window.evaluate(async (rel) => {
      try {
        await (window as any).app.workspace.getLeaf(true).setViewState({ type: "canvas", state: { file: rel }, active: true });
        return null;
      } catch (e) { return String(e); }
    }, boardRel);
    expect(error).toBeNull();

    await expect(window.locator(".canvas-node-artifact")).toHaveCount(1);
    const state = await window.evaluate(() => (window as any).app.workspace.getLeavesOfType("canvas")[0].getViewState());
    expect(state).toEqual({ type: "canvas", state: { file: boardRel } });

    // Live artboard: guest viewport must be the full frame height, and body background must paint it all.
    await window.locator('.canvas-node[data-node-id="ab"] .canvas-artboard-interact-btn').click();
    const webview = window.locator('.canvas-node[data-node-id="ab"] webview');
    await expect(webview).toHaveCount(1);
    await expect.poll(async () => webview.evaluate(async (el: any) => {
      try { return await el.executeJavaScript("window.innerHeight"); } catch { return 0; }
    }), { timeout: 20_000 }).toBeGreaterThan(800);
    const probe = await webview.evaluate(async (el: any) => {
      const guest = await el.executeJavaScript("getComputedStyle(document.body).backgroundColor + '|' + document.documentElement.clientHeight");
      const [bg, h] = String(guest).split("|");
      return { bg, guestHeight: Number(h), frameHeight: el.clientHeight };
    });
    // Guest viewport equals the frame (stage below the header), not Chromium's 150px iframe default.
    expect(probe.bg).toBe("rgb(0, 128, 0)");
    expect(probe.frameHeight).toBeGreaterThan(800);
    expect(Math.abs(probe.guestHeight - probe.frameHeight)).toBeLessThanOrEqual(1);
    await window.screenshot({ path: path.join(process.env.QA_SCREENSHOT_DIR ?? test.info().outputDir, "live-artboard.png") });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
