import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "tasknotes");
const PLUGIN_ID = "tasknotes";
const BASES_VIEW_TYPES = ["tasknotesTaskList", "tasknotesKanban", "tasknotesCalendar", "tasknotesMiniCalendar"];

/**
 * COMPATIBILITY AUDIT (not a certification) for the real, unmodified TaskNotes
 * plugin (callumalpass/tasknotes). The bundle in tests/fixtures/plugins/tasknotes
 * is the shipped release artifact; see README.md there for provenance.
 *
 * Two scenarios:
 *  1. "as shipped": the manifest is untouched. Records how Geode's admission
 *     gate (plugin-manifest.ts `isPluginManifestCompatible`, ADR-0016) treats it.
 *  2. "manifest minAppVersion lowered": ONLY manifest.json is edited in the
 *     throwaway vault so the gate lets main.js run; main.js and styles.css stay
 *     byte-identical. Every probe then records what happens at runtime.
 *
 * Probes that fail today are marked `test.fail()` with the reason, so a fix
 * flips them to "unexpectedly passed" and forces the annotation to be removed.
 * Nothing here is added to test-vault/ (other specs count its files).
 */

const TASKS = [
  { file: "Write report", fm: "tags:\n  - task\nstatus: open\npriority: high\ndue: 2026-11-01\n" },
  { file: "Ship release", fm: "tags:\n  - task\nstatus: done\npriority: normal\n" },
  { file: "Plan offsite", fm: "tags:\n  - task\nstatus: in-progress\ncontexts:\n  - work\n" },
];

const TASK_BASE_YAML = [
  "filters:",
  "  and:",
  '    - file.folder == "TaskNotes/Tasks"',
  "views:",
  "  - type: tasknotesTaskList",
  "    name: Task List",
  "  - type: tasknotesKanban",
  "    name: Kanban",
  "  - type: tasknotesCalendar",
  "    name: Calendar",
  "",
].join("\n");

interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  vaultDir: string;
  consoleErrors: string[];
  cleanup: () => void;
}

function buildVault(minAppVersion: string | null): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-tasknotes-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-tasknotes-ud-"));
  fs.mkdirSync(path.join(vaultDir, "TaskNotes", "Tasks"), { recursive: true });
  for (const { file, fm } of TASKS) {
    fs.writeFileSync(path.join(vaultDir, "TaskNotes", "Tasks", `${file}.md`), `---\n${fm}---\n\n# ${file}\n`);
  }
  fs.writeFileSync(path.join(vaultDir, "Plain note.md"), "---\ntitle: not a task\n---\n\nhello\n");
  fs.writeFileSync(path.join(vaultDir, "Tasks.base"), TASK_BASE_YAML);

  const pluginDir = path.join(vaultDir, ".geode", "plugins", PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
  if (minAppVersion) manifest.minAppVersion = minAppVersion;
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(fixtureDir, "main.js"), path.join(pluginDir, "main.js"));
  fs.copyFileSync(path.join(fixtureDir, "styles.css"), path.join(pluginDir, "styles.css"));
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([PLUGIN_ID]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  return { vaultDir, userDataDir };
}

async function launch(minAppVersion: string | null): Promise<LaunchedApp> {
  const { vaultDir, userDataDir } = buildVault(minAppVersion);
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  const consoleErrors: string[] = [];
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(`pageerror: ${String(err)}`));
  await expect(window.locator('.nav-file-title[data-path="Plain note.md"]')).toBeVisible();
  return {
    app,
    window,
    vaultDir,
    consoleErrors,
    cleanup: () => {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Evaluate in the renderer; never throws, so a missing API is a recorded result. */
async function probe<T>(window: Page, fn: string): Promise<{ ok: boolean; value?: T; error?: string }> {
  return window.evaluate(async (body) => {
    try {
      // eslint-disable-next-line no-new-func
      const run = new Function(`return (async () => { ${body} })()`);
      return { ok: true, value: await run() };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.stack ?? e).slice(0, 600) };
    }
  }, fn);
}

const GET_PLUGIN = `
  const app = window.app;
  const pm = app.pluginManager;
  const plugin = (pm && pm.getPlugin('${PLUGIN_ID}')) || null;
`;

test.describe("TaskNotes as shipped (manifest untouched)", () => {
  test("admission gate: minAppVersion 1.12.2 vs Geode API version", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
    test.info().annotations.push({ type: "version", description: `${manifest.version} minAppVersion=${manifest.minAppVersion}` });
    const g = await launch(null);
    try {
      await g.window.waitForTimeout(2500);
      const state = await probe<{ loaded: boolean; loadError: string | null; views: string[]; commands: string[] }>(
        g.window,
        `${GET_PLUGIN}
         return { loaded: !!plugin, enabled: pm.isEnabled('${PLUGIN_ID}'), loadError: pm.getLoadError('${PLUGIN_ID}') || null,
           views: Array.from(app.basesViews.keys()).filter(k => k.startsWith('tasknotes')),
           commands: Object.keys(app.commands.commands || {}).filter(k => k.startsWith('tasknotes:')) };`
      );
      test.info().annotations.push({ type: "as-shipped-state", description: JSON.stringify(state) });
      // Expected today: blocked (1.12.2 > 1.10.2, no ADR-0016 certificate).
      expect(state.ok).toBe(true);
      expect(state.value?.loaded).toBe(false);
      expect(state.value?.views).toEqual([]);
    } finally {
      await g.app.close();
      g.cleanup();
    }
  });
});

test.describe("TaskNotes runtime (manifest minAppVersion lowered, main.js unmodified)", () => {
  // Default mode on purpose: one failing probe must not skip the rest (they share one app).
  let g: LaunchedApp;
  let pluginLoaded = false;
  let loadError: string | null = null;
  const BLOCKED = "Blocked: plugin fails to load (missing obsidian exports, see tests/unit/tasknotes-required-exports.test.ts)";

  test.beforeAll(async () => {
    g = await launch("1.8.0");
    await g.window.waitForTimeout(6000); // TaskNotes defers heavy init to layout-ready
    const r = await probe<{ loaded: boolean; err: string | null }>(
      g.window,
      `${GET_PLUGIN} return { loaded: !!plugin, err: pm.getLoadError('${PLUGIN_ID}') || null };`
    );
    pluginLoaded = !!r.value?.loaded;
    loadError = r.value?.err ?? null;
  });
  test.afterAll(async () => {
    await g?.app.close();
    g?.cleanup();
  });

  test("plugin loads and onload completes", async () => {
    test.info().annotations.push({ type: "load-error", description: String(loadError) });
    test.fail(!pluginLoaded, BLOCKED);
    const r = await probe<{ loaded: boolean; hasCache: boolean; hasService: boolean }>(
      g.window,
      `${GET_PLUGIN}
       return { loadError: pm.getLoadError('${PLUGIN_ID}') || null, loaded: !!plugin, hasCache: !!(plugin && plugin.cacheManager), hasService: !!(plugin && plugin.taskService) };`
    );
    test.info().annotations.push({ type: "result", description: JSON.stringify(r) });
    expect(r.ok).toBe(true);
    expect(r.value?.loaded).toBe(true);
    expect(r.value?.hasCache).toBe(true);
    expect(r.value?.hasService).toBe(true);
  });

  test("Bases views register", async () => {
    test.fail(!pluginLoaded, BLOCKED);
    const r = await probe<string[]>(g.window, `return Array.from(window.app.basesViews.keys());`);
    test.info().annotations.push({ type: "registered-views", description: JSON.stringify(r.value) });
    for (const type of BASES_VIEW_TYPES) expect(r.value ?? []).toContain(type);
  });

  test("task note detection (tag-based) and non-task exclusion", async () => {
    test.fail(!pluginLoaded, BLOCKED);
    const r = await probe<Record<string, unknown>>(
      g.window,
      `${GET_PLUGIN}
       const out = {};
       for (const p of ['TaskNotes/Tasks/Write report.md','TaskNotes/Tasks/Ship release.md','Plain note.md']) {
         const t = await plugin.cacheManager.getTaskInfo(p);
         out[p] = t ? { title: t.title, status: t.status, priority: t.priority, due: t.due } : null;
       }
       return out;`
    );
    test.info().annotations.push({ type: "result", description: JSON.stringify(r) });
    expect(r.ok, r.error).toBe(true);
    expect(r.value?.["TaskNotes/Tasks/Write report.md"]).toMatchObject({ status: "open", priority: "high" });
    expect(r.value?.["TaskNotes/Tasks/Ship release.md"]).toMatchObject({ status: "done" });
    expect(r.value?.["Plain note.md"]).toBeNull();
  });

  test("commands, settings tab and ribbon", async () => {
    test.fail(!pluginLoaded, BLOCKED);
    const r = await probe<{ commands: string[]; settingTab: boolean; ribbon: number }>(
      g.window,
      `const app = window.app;
       const cmds = Object.keys(app.commands.commands || {}).filter(k => k.startsWith('tasknotes:'));
       const settingTab = !!(app.settingTabs && app.settingTabs.has('${PLUGIN_ID}'));
       return { commands: cmds, settingTab,
                ribbon: document.querySelectorAll('.workspace-ribbon-actions .side-dock-ribbon-action').length };`
    );
    test.info().annotations.push({ type: "result", description: JSON.stringify(r.value) });
    expect(r.ok, r.error).toBe(true);
    expect(r.value?.commands.length).toBeGreaterThan(5);
    expect(r.value?.settingTab).toBe(true);
  });

  test("create a task through the plugin's taskService", async () => {
    test.fail(!pluginLoaded, BLOCKED);
    const r = await probe<{ path?: string; text?: string }>(
      g.window,
      `${GET_PLUGIN}
       const res = await plugin.taskService.createTask({ title: 'Created by audit', status: 'open', priority: 'normal', tags: ['task'], due: '2026-12-01' });
       const p = res.file ? res.file.path : (res.taskInfo && res.taskInfo.path);
       const f = app.vault.getAbstractFileByPath(p);
       return { path: p, text: f ? await app.vault.read(f) : null };`
    );
    test.info().annotations.push({ type: "result", description: JSON.stringify(r) });
    expect(r.ok, r.error).toBe(true);
    // TaskNotes stores the title in the file name by default, not the body.
    expect(r.value?.path).toContain("Created by audit");
    expect(r.value?.text).toContain("status: open");
    expect(r.value?.text).toContain("- task");
  });

  test("edit a task through the plugin (processFrontMatter path) and metadata cache refresh", async () => {
    test.fail(!pluginLoaded, BLOCKED);
    const r = await probe<{ fm: Record<string, unknown> | null; cacheStatus?: string }>(
      g.window,
      `${GET_PLUGIN}
       const path = 'TaskNotes/Tasks/Write report.md';
       const task = await plugin.cacheManager.getTaskInfo(path);
       await plugin.taskService.updateTask(task, { status: 'done', priority: 'low' });
       await new Promise(r => setTimeout(r, 1500));
       const f = app.vault.getAbstractFileByPath(path);
       const cache = app.metadataCache.getFileCache(f);
       const again = await plugin.cacheManager.getTaskInfo(path);
       return { fm: cache ? cache.frontmatter || null : null, cacheStatus: again && again.status };`
    );
    test.info().annotations.push({ type: "result", description: JSON.stringify(r) });
    expect(r.ok, r.error).toBe(true);
    expect(r.value?.fm).toMatchObject({ status: "done", priority: "low" });
    expect(r.value?.cacheStatus).toBe("done");
  });

  test("app.fileManager.processFrontMatter round-trips", async () => {
    const r = await probe<string>(
      g.window,
      `const app = window.app;
       const f = app.vault.getAbstractFileByPath('Plain note.md');
       await app.fileManager.processFrontMatter(f, fm => { fm.audit = 'ok'; });
       return await app.vault.read(f);`
    );
    expect(r.ok, r.error).toBe(true);
    expect(r.value).toContain("audit: ok");
  });

  test("a .base file renders TaskNotes views", async () => {
    test.fail(!pluginLoaded, BLOCKED);
    await g.window.locator('.nav-file-title[data-path="Tasks.base"]').click();
    await g.window.waitForTimeout(2500);
    const r = await probe<{ titlesFound: string[]; errorText: string | null; sample: string; pluginDom: number; builtinTableShown: boolean }>(
      g.window,
      `const root = document.querySelector('.workspace-leaf.mod-active') || document;
       const text = root.textContent || '';
       return { titlesFound: ['Write report','Ship release','Plan offsite'].filter(t => text.includes(t)),
                errorText: (root.querySelector('.bases-error, .bases-view-error') || {}).textContent || null,
                // Unknown view types fall back to the built-in table, which also lists the titles, so
                // titles alone prove nothing: require TaskNotes' own DOM and the table hidden.
                pluginDom: root.querySelectorAll('[class*="tasknotes"], [class*="task-card"]').length,
                builtinTableShown: !!root.querySelector('.bases-table-container') && (root.querySelector('.bases-table-container').offsetParent !== null),
                sample: text.slice(0, 300) };`
    );
    test.info().annotations.push({ type: "result", description: JSON.stringify(r.value) });
    expect(r.ok, r.error).toBe(true);
    expect(r.value?.pluginDom).toBeGreaterThan(0);
    expect(r.value?.builtinTableShown).toBe(false);
    expect(r.value?.titlesFound).toEqual(["Write report", "Ship release", "Plan offsite"]);
    expect(r.value?.errorText).toBeNull();
  });

  test("no console errors during load and use", async () => {
    // KNOWN GAP: MarkdownView.getMode() is absent (TaskNotes relationship/task-card widgets call it on every
    // layout change), so uncaught TypeErrors are emitted. Remove test.fail when Geode implements it.
    test.fail(true, "MarkdownView.getMode is not a function");
    test.info().annotations.push({ type: "console-errors", description: JSON.stringify(g.consoleErrors.slice(0, 20)) });
    expect(g.consoleErrors, `Console errors:\n${g.consoleErrors.join("\n")}`).toEqual([]);
  });
});
