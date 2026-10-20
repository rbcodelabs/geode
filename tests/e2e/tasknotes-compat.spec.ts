import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "tasknotes");
const PLUGIN_ID = "tasknotes";
const BASES_VIEW_TYPES = ["tasknotesTaskList", "tasknotesKanban", "tasknotesCalendar", "tasknotesMiniCalendar"];

/**
 * Certification evidence for the real, unmodified TaskNotes plugin
 * (callumalpass/tasknotes) at the exact version in ADR-0016's certificate.
 * The bundle in tests/fixtures/plugins/tasknotes is the shipped release
 * artifact; see README.md there for provenance. The manifest is NOT edited in
 * the supported scenario: admission goes through the real certificate.
 *
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

test.describe("TaskNotes admission (ADR-0016 certificate)", () => {
  test("the shipped manifest is admitted through the exact certificate", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
    expect(manifest.version).toBe("4.13.10");
    const g = await launch(null);
    try {
      await g.window.waitForTimeout(2500);
      const state = await probe<{ loaded: boolean; loadError: string | null }>(
        g.window,
        `${GET_PLUGIN} return { loaded: !!plugin, loadError: pm.getLoadError('${PLUGIN_ID}') || null };`
      );
      expect(state.ok, state.error).toBe(true);
      expect(state.value).toEqual({ loaded: true, loadError: null });
    } finally {
      await g.app.close();
      g.cleanup();
    }
  });

  test("a manifest declaring a higher minAppVersion than the certificate is still blocked", async () => {
    const g = await launch("1.12.3");
    try {
      await g.window.waitForTimeout(2500);
      const state = await probe<{ loaded: boolean; loadError: string | null }>(
        g.window,
        `${GET_PLUGIN} return { loaded: !!plugin, loadError: pm.getLoadError('${PLUGIN_ID}') || null };`
      );
      expect(state.value?.loaded).toBe(false);
    } finally {
      await g.app.close();
      g.cleanup();
    }
  });
});

test.describe("TaskNotes runtime (unmodified manifest and bundle)", () => {
  // Default mode on purpose: one failing probe must not skip the rest (they share one app).
  let g: LaunchedApp;
  let pluginLoaded = false;
  let loadError: string | null = null;

  test.beforeAll(async () => {
    g = await launch(null);
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
    const r = await probe<string[]>(g.window, `return Array.from(window.app.basesViews.keys());`);
    test.info().annotations.push({ type: "registered-views", description: JSON.stringify(r.value) });
    for (const type of BASES_VIEW_TYPES) expect(r.value ?? []).toContain(type);
  });

  test("task note detection (tag-based) and non-task exclusion", async () => {
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

  test("a hand-written .base renders the TaskNotes task list, with the built-in table hidden", async () => {
    await g.window.locator('.nav-file-title[data-path="Tasks.base"]').click();
    await expect(g.window.locator(".workspace-leaf.mod-active .task-card").first()).toBeVisible({ timeout: 10_000 });
    const r = await probe<{ titlesFound: string[]; errorText: string | null; builtinTableShown: boolean; cards: number }>(
      g.window,
      `const root = document.querySelector('.workspace-leaf.mod-active') || document;
       const text = root.textContent || '';
       const table = root.querySelector('.bases-table-container');
       return { titlesFound: ['Write report','Ship release','Plan offsite'].filter(t => text.includes(t)),
                errorText: (root.querySelector('.bases-error, .bases-view-error') || {}).textContent || null,
                cards: root.querySelectorAll('.task-card').length,
                builtinTableShown: !!table && table.offsetParent !== null };`
    );
    expect(r.ok, r.error).toBe(true);
    expect(r.value?.cards).toBeGreaterThanOrEqual(3);
    expect(r.value?.builtinTableShown).toBe(false);
    expect(r.value?.titlesFound).toEqual(["Write report", "Ship release", "Plan offsite"]);
    expect(r.value?.errorText).toBeNull();
  });

  // TaskNotes' own generated default views (formulas, groupBy, view options), not a hand-written base.
  for (const [command, baseFile, assertion] of [
    ["open-tasks-view", "tasks-default.base", ".task-card"],
    ["open-kanban-view", "kanban-default.base", ".kanban-view__column .task-card, .kanban-view__card, .task-card"],
    ["open-calendar-view", "mini-calendar-default.base", ".mini-calendar-view, [class*='mini-calendar']"],
  ] as const) {
    test(`tasknotes:${command} renders its default Base view`, async ({}, testInfo) => {
      const r = await probe<{ file: string | null; table: boolean }>(
        g.window,
        `await app.commands.executeCommandById('tasknotes:${command}');
         await new Promise(r => setTimeout(r, 1500));
         const root = document.querySelector('.workspace-leaf.mod-active');
         const t = root.querySelector('.bases-table-container');
         return { file: app.workspace.getActiveFile()?.path || null, table: !!t && t.offsetParent !== null };`
      );
      expect(r.ok, r.error).toBe(true);
      expect(r.value?.file).toContain(baseFile);
      expect(r.value?.table).toBe(false);
      const active = g.window.locator(".workspace-leaf.mod-active");
      await expect(active.locator(assertion).first()).toBeVisible({ timeout: 10_000 });
      if (command !== "open-calendar-view") {
        // Every seeded task shows up as a card (kanban columns may scroll horizontally, so count DOM nodes).
        const titles = await active.locator(".task-card").allTextContents();
        for (const title of ["Write report", "Ship release", "Plan offsite"]) {
          expect(titles.some((text) => text.includes(title)), `${title} card in ${command}`).toBe(true);
        }
        await expect(active.getByText("requires a 'group by'")).toHaveCount(0);
      }
      // Evidence screenshot, attached to the run (inspect via the Playwright report / test-results).
      await testInfo.attach(`${command}.png`, { body: await g.window.screenshot(), contentType: "image/png" });
    });
  }

  test("AbstractInputSuggest drives a working popover in a TaskNotes modal", async ({}, testInfo) => {
    await probe(g.window, `await app.commands.executeCommandById('tasknotes:create-new-task');`);
    const modal = g.window.locator(".modal");
    await expect(modal.first()).toBeVisible({ timeout: 10_000 });
    await modal.locator("[aria-label='Show detailed options']").click();
    // The contexts field is a comma-separated text input backed by AbstractInputSuggest.
    const input = modal.locator("input[placeholder*='context' i]").first();
    await expect(input).toBeVisible();
    // TaskNotes moves focus to its natural-language box shortly after opening; wait for that to settle so
    // the blur it causes does not (correctly) dismiss the popover mid-test.
    await g.window.waitForTimeout(1000);
    await input.click();
    await expect(input).toBeFocused();
    await input.fill("w");
    const popover = g.window.locator(".geode-input-suggest");
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await expect(popover.locator(".suggestion-item").first()).toContainText(/work/i);
    await testInfo.attach("input-suggest.png", { body: await g.window.screenshot(), contentType: "image/png" });
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(popover).toHaveCount(0);
    await expect(input).toHaveValue(/work/i);
    // Escape closes only the popover, never the modal behind it.
    await input.fill("w");
    await expect(popover).toBeVisible();
    await input.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(modal.first()).toBeVisible();
    await g.window.keyboard.press("Escape");
  });

  test("no uncaught errors during load and use; only the documented editor fallback is logged", async () => {
    test.info().annotations.push({ type: "console-errors", description: JSON.stringify(g.consoleErrors.slice(0, 20)) });
    // Uncaught page errors and Geode's own console errors are never acceptable.
    const uncaught = g.consoleErrors.filter((e) => e.startsWith("pageerror:"));
    expect(uncaught, `Uncaught errors:\n${uncaught.join("\n")}`).toEqual([]);
    // KNOWN LIMITATION (docs/spec/03-plugin-api.md): TaskNotes' task modals try to embed Obsidian's private
    // markdown editor via `app.embedRegistry`, which Geode does not provide. TaskNotes catches that, logs
    // through console.error and falls back to a plain textarea; those handled logs are the only allowed noise.
    const handledFallback = /\[TaskNotes\]\[Modals\/[A-Za-z]+\]\[persistence\]\[create(-nlp)?-markdown-editor\]/;
    const unexpected = g.consoleErrors.filter((e) => !handledFallback.test(e));
    expect(unexpected, `Unexpected console errors:\n${unexpected.join("\n")}`).toEqual([]);
  });
});
