import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "tasks-compat-plugin",
  name: "Tasks Compat Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises the obsidian-compat surfaces obsidian-tasks needs to render a query.",
  author: "geode",
};

/**
 * Hermetic stand-in for the surfaces obsidian-tasks touches while building its
 * cache and rendering a ```tasks query — each of which used to throw an
 * uncaught error that aborted the render (verified against the real plugin,
 * fixed incrementally):
 *   1. `parseFrontMatterTags` / `getAllTags` module exports (were undefined →
 *      "not a function" mid cache-scan)
 *   2. `app.metadataTypeManager.getAllProperties()/setType()` (was absent →
 *      `setObsidianPropertiesTypes` threw)
 *   3. `el.isShown()` / `show` / `hide` DOM helpers (were absent → threw in the
 *      query renderer's IntersectionObserver callback)
 * The plugin asserts all three and notifies a single pass marker only if every
 * check holds. (The 4th fix — `getFileCache(...).frontmatter === undefined`
 * for a note without frontmatter — is asserted at the parseMetadata layer in
 * tests/unit/metadata-cache.test.ts; the cache isn't reliably populated at
 * onload() to check it here.)
 */
const MAIN_JS = `
  const o = require('obsidian');

  module.exports.default = class TasksCompatPlugin extends o.Plugin {
    onload() {
      const checks = [];

      // 1. frontmatter/tag helpers exist and behave.
      checks.push(typeof o.parseFrontMatterTags === 'function');
      checks.push(JSON.stringify(o.parseFrontMatterTags({ tags: ['a', 'b'] })) === '["#a","#b"]');
      checks.push(o.parseFrontMatterTags(null) === null);
      checks.push(typeof o.getAllTags === 'function');

      // 2. metadataTypeManager shim exists and round-trips.
      const mtm = this.app.metadataTypeManager;
      checks.push(!!mtm && typeof mtm.getAllProperties === 'function');
      mtm.setType('due', 'date');
      checks.push(mtm.getAllProperties()['due'] && mtm.getAllProperties()['due'].type === 'date');

      // 3. isShown / show / hide DOM helpers exist and report visibility.
      const el = document.body.createDiv();
      checks.push(typeof el.isShown === 'function' && el.isShown() === true);
      el.hide();
      checks.push(el.isShown() === false);
      el.remove();

      const passed = checks.every(Boolean);
      this.app.notify(passed ? 'tasks-compat OK' : 'tasks-compat FAIL ' + checks.map((c,i)=>i+':'+c).join(','));
    }
  };
`;

test("obsidian-tasks compat surfaces (frontmatter helpers, metadataTypeManager, isShown) all hold", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-taskscompat-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-taskscompat-e2e-"));

  fs.writeFileSync(path.join(vaultDir, "NoFm.md"), "# No frontmatter\n\n- [ ] a task\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "tasks-compat-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "plugins.json"),
    JSON.stringify(["tasks-compat-plugin"])
  );
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const consoleErrors: string[] = [];
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    await expect(window.locator(".notice", { hasText: "tasks-compat OK" })).toBeVisible();
    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
