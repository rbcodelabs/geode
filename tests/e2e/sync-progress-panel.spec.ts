import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const root = path.resolve(__dirname, "../..");

/**
 * Registers a synthetic append-only provider whose uploads are deliberately slow,
 * so a real sync stays in flight long enough to watch the panel update. The
 * whole point of the feature is that a long run is legible while it runs, which
 * cannot be observed against an instant fixture.
 */
/**
 * @param planDelayMs slows `excludePath`, which the host calls per entry inside
 * the local reconcile walk. That walk is the countable half of planning, so this
 * is to the planning phase what uploadDelayMs is to transferring: the only way to
 * observe a phase that is otherwise over before a single assertion can run.
 */
const FIXTURE = (uploadDelayMs: number, planDelayMs = 0) => `(() => {
  const app = window.app;
  const descriptor = { schema: 1, protocol: "append-only-history-v1", vaultId: "12345678-1234-4234-8234-123456789012", rootId: "synthetic-root", descriptorId: "synthetic-descriptor", name: "Synthetic shared vault" };
  const blobs = new Map();
  const records = [];
  app.sync.register("synthetic-progress", {
    id: "history.fixture", name: "Immutable fixture", protocol: "append-only-history-v1",
    capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
    discover: async () => [descriptor],
    createVault: async () => descriptor,
    ...(${planDelayMs} ? { excludePath: async () => { await new Promise(done => setTimeout(done, ${planDelayMs})); return null; } } : {}),
    open: async () => ({
      scan: async () => ({ status: "complete", records: records.map(r => JSON.parse(JSON.stringify(r))) }),
      putBlob: async (input) => { await new Promise(done => setTimeout(done, ${uploadDelayMs})); blobs.set(input.operationId, input.data.slice(0)); return { id: input.operationId, sha256: input.sha256, size: input.size }; },
      readBlob: async (ref) => blobs.get(ref.id).slice(0),
      appendRecord: async (record) => { records.push(JSON.parse(JSON.stringify(record))); },
      close: async () => {},
    }),
  });
  app.setting.openTabById("sync");
})()`;

function launchVault(fileCount: number) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-progress-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-progress-profile-"));
  for (let index = 0; index < fileCount; index++) {
    fs.writeFileSync(path.join(vault, `note-${String(index).padStart(2, "0")}.md`), `body ${index}\n`.repeat(64));
  }
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  return { vault, profile };
}

test("the sync panel reports live progress during a run without re-rendering the tab", async ({}, info) => {
  const { vault, profile } = launchVault(10);
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.evaluate(FIXTURE(700));

    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    await modal.getByRole("textbox", { name: "Shared vault name" }).fill("Synthetic shared vault");
    await modal.getByRole("button", { name: "Create shared vault", exact: true }).click();
    await expect(modal).toContainText("Shared vault created");
    await modal.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(modal).toContainText("upload");

    const activity = modal.locator(".sync-progress");
    const phase = modal.locator(".sync-progress-phase");
    const counts = modal.locator(".sync-progress-counts");
    const elapsed = modal.locator(".sync-progress-elapsed");
    const currentPath = modal.locator(".sync-progress-path");

    await modal.getByRole("button", { name: "Approve & sync", exact: true }).click();
    // Visible before any tick can have arrived: the click itself paints the
    // activity surface, so the panel is never blank while work is in flight.
    await expect(activity).toBeVisible();
    await expect(phase).toHaveText("Transferring", { timeout: 20_000 });
    await expect(currentPath).toContainText(".md");

    // Stamp the live element, scroll away from the top and park focus *inside
    // the run*. The actions that settle around Preview legitimately re-render
    // the tab several times; what must never happen is a re-render while an
    // action is in flight, which is exactly the window this measures.
    const before = await page.evaluate(() => {
      const activityEl = document.querySelector(".sync-progress") as (HTMLElement & { __probe?: string }) | null;
      if (activityEl) activityEl.__probe = "kept";
      let scroller: HTMLElement | null = activityEl;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) scroller = scroller.parentElement;
      if (scroller) scroller.scrollTop = 120;
      // The settings nav sits outside the tab container, so it is the one
      // focusable control that survives perform()'s disable-everything pass.
      document.querySelector<HTMLElement>(".vertical-tab-nav-item")?.focus();
      return { probed: Boolean(activityEl), scrollTop: scroller?.scrollTop ?? null, focused: document.activeElement?.className ?? null };
    });
    expect(before.probed).toBe(true);
    expect(before.scrollTop).toBeGreaterThan(0);

    // The counter must actually advance on screen while the run continues.
    const firstCounts = await counts.textContent();
    expect(firstCounts).toMatch(/\d+ \/ \d+ \(\d+%\)/);
    await expect.poll(() => counts.textContent(), { timeout: 15_000 }).not.toBe(firstCounts);
    await expect(elapsed).toContainText("Elapsed");

    // The load-bearing assertion for "update in place, do not re-render": the
    // very same DOM node is still there, carrying a property no rebuild could
    // reproduce, and the scroll position was never reset. `running` is captured
    // in the same evaluate so that a future timing regression — probing after
    // the run has already finished and legitimately re-rendered — fails loudly
    // instead of quietly proving nothing.
    const during = await page.evaluate(() => {
      const activityEl = document.querySelector(".sync-progress") as (HTMLElement & { __probe?: string }) | null;
      let scroller: HTMLElement | null = activityEl;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) scroller = scroller.parentElement;
      return {
        probe: activityEl?.__probe ?? null,
        scrollTop: scroller?.scrollTop ?? null,
        focused: document.activeElement?.className ?? null,
        role: activityEl?.getAttribute("role") ?? null,
        running: Boolean((window as any).app.sync.getStatus().progress),
      };
    });
    expect(during.running).toBe(true);
    expect(during.probe).toBe("kept");
    expect(during.scrollTop).toBe(before.scrollTop);
    expect(during.focused).toBe(before.focused);
    expect(during.role).toBe("status");

    await page.screenshot({ path: info.outputPath("sync-progress-running.png") });

    // And when the run ends, the progress surface is retired rather than left
    // showing a frozen percentage over a finished sync.
    await expect(activity).toBeHidden({ timeout: 30_000 });
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * Planning used to report (0, 0): a label, a bar with no numbers in it and a
 * clock, for the longest silent stretch of a large sync. This drives the real
 * app through a real reconcile over a few thousand files and demands the numbers
 * on screen — the only evidence that the denominator survives the whole path
 * from the host's walk, through the port, the throttle and into the DOM.
 */
test("the planning phase counts the local reconcile against a real denominator", async ({}, info) => {
  const shots = process.env.GEODE_SHOT_DIR;
  const { vault, profile } = launchVault(1500);
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.evaluate(FIXTURE(0, 3));

    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    await modal.getByRole("textbox", { name: "Shared vault name" }).fill("Synthetic shared vault");
    await modal.getByRole("button", { name: "Create shared vault", exact: true }).click();
    await expect(modal).toContainText("Shared vault created");

    const phase = modal.locator(".sync-progress-phase");
    const counts = modal.locator(".sync-progress-counts");
    const bar = modal.locator(".sync-progress-bar");

    await modal.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(phase).toHaveText("Planning changes", { timeout: 60_000 });
    // The whole fix, as a user sees it: a count, a denominator and a percentage
    // during the phase that used to render as an empty bar.
    await expect(counts).toHaveText(/[\d,]+ \/ [\d,]+ \(\d+%\)/, { timeout: 60_000 });

    // A determinate bar, not the indeterminate one planning was stuck with.
    expect(await bar.getAttribute("value")).not.toBeNull();
    const parse = async () => {
      const [completed, total] = (await counts.textContent())!.match(/[\d,]+/g)!.slice(0, 2).map(n => Number(n.replace(/,/g, "")));
      return { completed, total };
    };
    const first = await parse();
    // 1,500 generated files: a denominator that is real, not a placeholder.
    expect(first.total).toBeGreaterThan(1000);
    expect(first.completed).toBeLessThanOrEqual(first.total);
    // And it climbs well past where it started — a count that merely appeared
    // once would still be a bar that only looks alive.
    await expect.poll(async () => (await parse()).completed, { timeout: 60_000 }).toBeGreaterThan(first.total / 5);
    const later = await parse();
    expect(later.total).toBe(first.total);
    await expect(modal.locator(".sync-progress-elapsed")).toContainText("Elapsed");
    // Captured here rather than on first paint, so the artifact shows the phase
    // genuinely underway instead of a 1% that proves less than it appears to.
    if (shots) await page.screenshot({ path: path.join(shots, "planning-real-denominator.png") });
    await page.screenshot({ path: info.outputPath("sync-planning-counts.png") });
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * The restart signal, rendered the same injected way as the stall warning below
 * and for the same reason: producing a genuine fourth consecutive failed run
 * end-to-end would mean driving a provider to fail four times on a backoff that
 * reaches 16s. What this proves is the part that matters on screen — that a
 * restarted pass does not read like a continuing one. The counter's lifecycle
 * across endProgress() is covered in tests/unit/sync-progress.test.ts.
 */
test("a restarted pass names itself instead of passing for continued progress", async ({}, info) => {
  const shots = process.env.GEODE_SHOT_DIR;
  const { vault, profile } = launchVault(2);
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.evaluate(FIXTURE(0));
    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    await expect(modal).toContainText("Create or join a shared vault");

    await page.evaluate(() => {
      const sync = (window as any).app.sync;
      const now = Date.now();
      sync.status = {
        state: "syncing", providerId: "history.fixture", conflicts: 0,
        progress: { phase: "planning", completed: 3102, total: 17251, currentPath: "note-2.md", startedAt: now - 23_000, lastProgressAt: now, attempt: 4 },
      };
      sync.trigger("status", sync.status);
    });

    const phase = modal.locator(".sync-progress-phase");
    // 23 seconds elapsed on attempt four is the user's report made legible: the
    // clock restarting no longer masquerades as one slow first pass.
    await expect(phase).toHaveText("Planning changes — attempt 4");
    await expect(modal.locator(".sync-progress-counts")).toHaveText("3,102 / 17,251 (17%)");
    await expect(modal.locator(".sync-progress-elapsed")).toContainText("Elapsed 23s");
    if (shots) await page.screenshot({ path: path.join(shots, "planning-restart-attempt.png") });
    await page.screenshot({ path: info.outputPath("sync-planning-attempt.png") });
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * Stall rendering is driven by injecting a status whose lastProgressAt is already
 * old, because the alternative is a 5-minute e2e test. What this still proves
 * end-to-end is everything that is not arithmetic: that the panel subscribes,
 * that it renders the warning naming the file, and — the part that cannot be
 * faked — that the duration keeps climbing on the panel's own ticker while the
 * sync service emits nothing at all. The threshold arithmetic itself is covered
 * in tests/unit/sync-progress.test.ts.
 */
test("a stalled sync keeps counting up in the panel even though it emits no events", async ({}, info) => {
  const { vault, profile } = launchVault(2);
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.evaluate(FIXTURE(0));

    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    // activate() finishes asynchronously and sets its own status. Injecting
    // before that lands would have the activation immediately overwrite it.
    await expect(modal).toContainText("Create or join a shared vault");

    const events = await page.evaluate(() => {
      const sync = (window as any).app.sync;
      let emitted = 0;
      sync.on("status", () => { emitted++; });
      const now = Date.now();
      sync.status = {
        state: "syncing", providerId: "history.fixture", conflicts: 0,
        progress: { phase: "transferring", completed: 1234, total: 17251, currentPath: "--clip", startedAt: now - 45 * 60_000, lastProgressAt: now - 42 * 60_000 },
      };
      sync.trigger("status", sync.status);
      (window as any).__emitted = () => emitted;
      return emitted;
    });
    expect(events).toBe(1);

    const stall = modal.locator(".sync-progress-stall");
    await expect(stall).toBeVisible();
    await expect(stall).toContainText("No progress for 42m");
    await expect(stall).toContainText("--clip");
    await expect(modal.locator(".sync-progress")).toHaveClass(/is-stalled/);
    // Warn-only: the run is not cancelled, aborted or retried on our behalf.
    await expect(stall).toContainText("has not been cancelled");

    await page.screenshot({ path: info.outputPath("sync-progress-stalled.png") });

    const first = await stall.textContent();
    await expect.poll(() => stall.textContent(), { timeout: 10_000 }).not.toBe(first);
    // Nothing new arrived on the status bus: the growing duration is the panel's
    // own 1s ticker, which is the only way a wedged sync can report itself.
    expect(await page.evaluate(() => (window as any).__emitted())).toBe(1);
    await page.screenshot({ path: info.outputPath("sync-progress-stalled-later.png") });

    // Leaving the tab must retire the subscription. activateTab() empties the
    // content container but leaves the container itself connected, so nothing
    // about the DOM would reveal a leaked listener — count it directly.
    const listeners = () => page.evaluate(() => (window as any).app.sync.handlers.get("status").size as number);
    const open = await listeners();
    await modal.getByRole("tab", { name: "Appearance" }).click();
    expect(await listeners()).toBe(open - 1);
    await expect(modal.locator(".sync-progress")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
