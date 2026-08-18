import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MAIN_JS = `
  const { Notice, Plugin } = require('obsidian');

  module.exports.default = class extends Plugin {
    onload() {
      new Notice('plugin persistent', 0);
      new Notice('plugin timed', 500);

      const fragment = document.createDocumentFragment();
      fragment.append('fragment content ');
      const action = document.createElement('button');
      action.textContent = 'Run action';
      action.addEventListener('click', () => action.dataset.clicked = 'true');
      fragment.append(action);
      new Notice(fragment, 0);

      this.app.notify('app persistent', 0);
      this.app.notify('app timed', 500);
    }
  };
`;

test("notices can be dismissed without breaking interactive content and still time out", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-notices-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-notices-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "notices-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "notices-probe",
    name: "Notices Probe",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    description: "Exercises dismissible notices.",
    author: "geode",
  }));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["notices-probe"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const pluginPersistent = window.locator(".notice", { hasText: "plugin persistent" });
    const appPersistent = window.locator(".notice", { hasText: "app persistent" });
    const fragmentNotice = window.locator(".notice", { hasText: "fragment content" });

    await expect(pluginPersistent).toBeVisible();
    await expect(appPersistent).toBeVisible();
    await expect(fragmentNotice).toBeVisible();
    await expect(window.locator(".notice", { hasText: "plugin timed" })).toBeVisible();
    await expect(window.locator(".notice", { hasText: "app timed" })).toBeVisible();

    const pluginClose = pluginPersistent.getByRole("button", { name: "Dismiss notification" });
    await expect(pluginClose).toBeVisible();
    await pluginClose.click();
    await expect(pluginPersistent).toHaveCount(0);
    await expect(appPersistent).toBeVisible();

    const action = fragmentNotice.getByRole("button", { name: "Run action" });
    await action.click();
    await expect(action).toHaveAttribute("data-clicked", "true");
    await expect(fragmentNotice).toBeVisible();
    await fragmentNotice.click({ position: { x: 4, y: 4 } });
    await expect(fragmentNotice).toHaveCount(0);

    await appPersistent.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(appPersistent).toHaveCount(0);

    await expect(window.locator(".notice", { hasText: "plugin timed" })).toHaveCount(0, { timeout: 5_000 });
    await expect(window.locator(".notice", { hasText: "app timed" })).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
