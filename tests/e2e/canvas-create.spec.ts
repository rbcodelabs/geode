import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const EMPTY_CANVAS = '{\n  "nodes": [],\n  "edges": []\n}\n';
const isMac = process.platform === "darwin";

async function runCommand(window: Page, name: string): Promise<void> {
  await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
  await window.locator(".prompt-input").fill(name);
  await window.getByText(name, { exact: true }).click();
}

async function expectOpenCanvas(window: Page, canvasPath: string): Promise<void> {
  await expect(window.locator(".canvas-view")).toBeVisible();
  await expect(window.locator(".canvas-view .canvas-node")).toHaveCount(0);
  await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path ?? null))
    .toBe(canvasPath);
}

test("creates and opens collision-safe canvases from command, folder menu, and built-in ribbon", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-create-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-create-user-"));
  fs.mkdirSync(path.join(vaultDir, "Projects"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Archive"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "Projects", "Active.md"), "# Active project\n");
  fs.writeFileSync(path.join(vaultDir, "Projects", "Untitled.canvas"), EMPTY_CANVAS);
  fs.writeFileSync(path.join(vaultDir, "Projects", "Untitled 1.canvas"), EMPTY_CANVAS);

  const pluginDir = path.join(vaultDir, ".geode", "plugins", "canvas-ribbon-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "canvas-ribbon-probe",
    name: "Canvas Ribbon Probe",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    description: "Verifies built-in and plugin ribbon action coexistence.",
    author: "geode",
  }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), `
    const { Plugin } = require('obsidian');
    module.exports = class extends Plugin {
      onload() { this.addRibbonIcon('message-square', 'Canvas ribbon probe', () => {}); }
    };
  `);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["canvas-ribbon-probe"]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    const ribbon = window.locator(".workspace-ribbon.mod-left");
    const ribbonActions = ribbon.locator(".workspace-ribbon-actions");
    const createCanvasAction = ribbonActions.getByRole("button", { name: "Create new canvas" });
    await expect(createCanvasAction).toHaveCount(1);
    await expect(createCanvasAction.locator(".lucide-layout-dashboard")).toBeVisible();
    await expect(ribbonActions.getByRole("button", { name: "Canvas ribbon probe" })).toBeVisible();
    await expect(ribbon.locator(".workspace-ribbon-bottom").getByRole("button", { name: "Manage vaults" })).toBeVisible();
    await expect(ribbon.locator(".workspace-ribbon-bottom").getByRole("button", { name: "Open settings" })).toBeVisible();

    await window.locator('.nav-folder-title:has-text("Projects")').click();
    await window.locator('.nav-file-title[data-path="Projects/Active.md"]').click();
    await runCommand(window, "Canvas: Create new canvas");
    const commandPath = "Projects/Untitled 2.canvas";
    await expectOpenCanvas(window, commandPath);
    await expect.poll(() => fs.existsSync(path.join(vaultDir, commandPath))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, commandPath), "utf8")).toBe(EMPTY_CANVAS);

    const archiveFolder = window.locator('.nav-folder-title:has-text("Archive")');
    await archiveFolder.click({ button: "right" });
    await window.locator(".context-menu-item", { hasText: "New canvas" }).click();
    const folderPath = "Archive/Untitled.canvas";
    await expectOpenCanvas(window, folderPath);
    await expect.poll(() => fs.existsSync(path.join(vaultDir, folderPath))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, folderPath), "utf8")).toBe(EMPTY_CANVAS);

    await window.locator('.nav-file-title[data-path="Projects/Active.md"]').click();
    await createCanvasAction.click();
    const ribbonPath = "Projects/Untitled 3.canvas";
    await expectOpenCanvas(window, ribbonPath);
    await expect.poll(() => fs.existsSync(path.join(vaultDir, ribbonPath))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, ribbonPath), "utf8")).toBe(EMPTY_CANVAS);
    await expect(createCanvasAction).toHaveCount(1);

    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
