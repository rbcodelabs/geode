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

      const fragment = document.createDocumentFragment();
      fragment.append('fragment content ');
      const action = document.createElement('button');
      action.textContent = 'Run action';
      action.addEventListener('click', () => action.dataset.clicked = 'true');
      fragment.append(action);
      new Notice(fragment, 0);

      this.app.notify('app persistent', 0);

      // The timed notices are emitted on demand, not at load: a 500 ms notice
      // created at plugin load can expire before a slow CI runner finishes
      // launching and running the assertions that precede its visibility check.
      this.addCommand({
        id: 'emit-timed',
        name: 'Emit timed notices',
        callback: () => {
          new Notice('plugin timed', 500);
          this.app.notify('app timed', 500);
        },
      });
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

    // Emit the timed notices and observe them inside the page in the same task
    // sequence. Checking from the test process would race the 500 ms timeout
    // against Playwright round-trips, which are slow on a loaded runner.
    const shownWhileLive = await window.evaluate(async () => {
      const app = (window as any).app;
      const present = (text: string) => [...document.querySelectorAll(".notice")].some((el) => el.textContent?.includes(text));
      app.commands.executeCommandById("notices-probe:emit-timed");
      const deadline = performance.now() + 400;
      while (performance.now() < deadline && !(present("plugin timed") && present("app timed"))) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return { plugin: present("plugin timed"), app: present("app timed") };
    });
    expect(shownWhileLive).toEqual({ plugin: true, app: true });

    await expect(window.locator(".notice", { hasText: "plugin timed" })).toHaveCount(0, { timeout: 5_000 });
    await expect(window.locator(".notice", { hasText: "app timed" })).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
