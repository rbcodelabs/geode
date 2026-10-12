import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "e2e-launch",
  name: "E2E Launch",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Registers launch steps.",
  author: "geode-tests",
};
const MAIN_JS = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  onload() {
    this.app.launch.registerStep({
      id: "e2e-launch:slow", title: "Creating sandbox", order: 1, optional: false,
      async run(ctx) { ctx.setProgress("pulling image"); await new Promise((r) => setTimeout(r, 1800)); },
    });
    this.app.launch.registerStep({
      id: "e2e-launch:broken", title: "Broken step", order: 2,
      run() { throw new Error("nope"); },
    });
  }
};`;

test("launch screen shows plugin steps, then dismisses; failures never block the vault", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-"));
  const dir = path.join(vaultPath, ".geode", "plugins", "e2e-launch");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(dir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(["e2e-launch"]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot, env: { ...process.env } });
  try {
    const window = await app.firstWindow();
    const overlay = window.locator(".launch-overlay");
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(overlay.locator(".launch-overlay-step.is-running .launch-overlay-step-title")).toHaveText("Creating sandbox");
    await expect(overlay.locator(".launch-overlay-step.is-running .launch-overlay-step-detail")).toHaveText("pulling image");
    // Required step: no Skip button.
    await expect(overlay.locator(".launch-overlay-skip")).toBeHidden();
    await overlay.screenshot({ path: path.join(os.tmpdir(), "geode-launch-overlay.png") });

    await expect(overlay).toHaveCount(0, { timeout: 15_000 });
    await expect(window.locator(".workspace")).toBeVisible();
    await expect(window.locator(".notice", { hasText: "1 launch step failed (Broken step)" })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
