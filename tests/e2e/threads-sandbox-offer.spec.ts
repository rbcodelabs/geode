import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Real Geode + REAL claude-threads plugin build, driving the "sandbox offer
 * before launch" behaviour end to end on any OS (incl. headless Linux/xvfb).
 *
 * Run: THREADS_PLUGIN_DIST=<agent-threads checkout>/dist \
 *        xvfb-run -a npx playwright test tests/e2e/threads-sandbox-offer.spec.ts
 * (see `npm run e2e:threads-plugin`). Skipped when THREADS_PLUGIN_DIST is unset.
 *
 * Seams (all test-only, inert in production):
 *  - CLAUDE_THREADS_DEMO_SCRIPT: the plugin's existing ReplaySession replaces the
 *    real Claude session, so no auth/network is needed. Its canned reply text is
 *    the "session started" signal.
 *  - ThreadManager.sandboxSetupSupported (existing field), .sandboxCapabilityProbe
 *    and .sandboxSetupRunner (added for this harness) are set via page.evaluate.
 */
const pluginDist = process.env.THREADS_PLUGIN_DIST;
test.skip(!pluginDist, "set THREADS_PLUGIN_DIST to a built claude-threads dist/ directory");

const repoRoot = path.resolve(__dirname, "../..");
const REPLY = "REPLAY-REPLY-OK";
const SCREENSHOT_DIR = process.env.THREADS_E2E_SCREENSHOT_DIR ?? "/tmp";

interface Fixture { base: string; vault: string; userData: string; app: ElectronApplication; page: Page }

async function launchFixture(pluginSettings: Record<string, unknown> = {}): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-threads-sandbox-offer-"));
  const userData = path.join(base, "userdata");
  const vault = path.join(base, "vault");
  const plugin = path.join(vault, ".geode/plugins/claude-threads");
  await Promise.all([fs.mkdir(plugin, { recursive: true }), fs.mkdir(userData)]);
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await fs.copyFile(path.join(pluginDist!, file), path.join(plugin, file));
  }
  await fs.writeFile(path.join(plugin, "data.json"), JSON.stringify({ harnessVmMode: "auto", ...pluginSettings }));
  await fs.writeFile(path.join(vault, ".geode/plugins.json"), JSON.stringify(["claude-threads"]));
  await fs.writeFile(path.join(vault, "Welcome.md"), "hi");
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));
  const script = path.join(base, "replay.json");
  await fs.writeFile(script, JSON.stringify({
    version: 1, pacing: { charsPerSecond: 2000 },
    turns: [], fallback: [{ type: "message", text: REPLY }],
  }));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_THREADS_DEMO_SCRIPT: script } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForFunction(() => !!(window as any).app?.pluginManager?.getPlugin("claude-threads")?.manager);
  await page.evaluate(() => (window as any).app.commands.executeCommandById("claude-threads:open-claude-threads"));
  await expect(page.locator(".ct-input")).toBeVisible();
  return { base, vault, userData, app, page };
}

/** Installs the fakes: the platform gate says "supported", the probe says "runtime missing" until setup succeeds. */
async function installSeams(page: Page, opts: { setupFails?: boolean } = {}): Promise<void> {
  await page.evaluate((setupFails) => {
    const w = window as any;
    const manager = w.app.pluginManager.getPlugin("claude-threads").manager;
    w.__sandboxReady = false;
    w.__probeCalls = 0;
    w.__setupRuns = 0;
    manager.sandboxSetupSupported = () => true;
    manager.sandboxCapabilityProbe = async () => {
      w.__probeCalls++;
      return w.__sandboxReady ? { capable: true } : { capable: false, code: "runtime-missing", reason: "fake: container CLI unavailable" };
    };
    manager.sandboxSetupRunner = {
      getStatus: async () => ({ supported: true, runtime: "missing", running: false, images: { base: "missing", harness: "missing" } }),
      run: async ({ onProgress }: { onProgress: (p: unknown) => void }) => {
        w.__setupRuns++;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        onProgress({ step: "runtime", stepNumber: 1, totalSteps: 3, label: "Installing the runtime", percent: 40 });
        await sleep(400);
        onProgress({ step: "images", stepNumber: 3, totalSteps: 3, label: "Preparing the image", line: "fake build output" });
        await sleep(400);
        if (setupFails) throw new Error("fake setup failure");
        w.__sandboxReady = true;
        return { installedRuntime: true, startedRuntime: true, pulledBase: true, builtHarness: true, stepsRun: ["runtime", "start", "images"] };
      },
    };
  }, !!opts.setupFails);
}

async function newThread(page: Page): Promise<string> {
  const before = await page.evaluate(() => (window as any).app.pluginManager.getPlugin("claude-threads").manager.getThreads().length);
  await page.locator('.view-action[aria-label="New thread"]').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).app.pluginManager.getPlugin("claude-threads").manager.getThreads().length)).toBe(before + 1);
  return page.evaluate(() => {
    const threads = (window as any).app.pluginManager.getPlugin("claude-threads").manager.getThreads();
    return threads[threads.length - 1].id as string;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator(".ct-input").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const card = (page: Page) => page.locator(".ct-sandbox-offer");
const reply = (page: Page) => page.locator(".ct-message-assistant", { hasText: REPLY });
// An empty `.ct-streaming` bubble is the view's "working" placeholder; only text counts as output.
const noAssistantOutput = async (page: Page) =>
  (await page.locator(".ct-message-assistant").evaluateAll((els) => els.filter((e) => (e.textContent ?? "").trim() !== "").length));

/** Wraps the parked thread's session.start() so the test can prove whether it was ever called. */
async function watchSessionStart(page: Page, threadId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as any;
    const session = w.app.pluginManager.getPlugin("claude-threads").manager.sessions.get(id);
    if (!session) throw new Error("no parked session to watch");
    w.__startCalls = 0;
    const original = session.start.bind(session);
    session.start = (...args: unknown[]) => { w.__startCalls++; return original(...args); };
  }, threadId);
}
const startCalls = (page: Page) => page.evaluate(() => (window as any).__startCalls as number);

async function cleanup(f?: Fixture): Promise<void> {
  await f?.app.close().catch(() => undefined);
  if (f) await fs.rm(f.base, { recursive: true, force: true });
}

test.describe("sandbox offer before launch (real app + real plugin)", () => {
  test.describe.configure({ mode: "serial" });

  test("card holds the session start; Not now releases it and removes the card", async () => {
    let f: Fixture | undefined;
    try {
      f = await launchFixture();
      const { page } = f;
      await installSeams(page);
      const id = await newThread(page);
      await send(page, "hello");
      await expect(card(page)).toBeVisible();
      await watchSessionStart(page, id);
      await expect(card(page).locator(".ct-sandbox-offer-title")).toHaveText("Run this thread in a sandbox?");
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "sandbox-offer-card.png") });
      // Held: nothing starts while the card is up (give a stray start time to show up).
      await page.waitForTimeout(2500);
      await expect(card(page)).toBeVisible();
      expect(await noAssistantOutput(page)).toBe(0);
      expect(await startCalls(page)).toBe(0);
      await expect(page.locator("body")).not.toContainText(REPLY);
      await card(page).getByRole("button", { name: "Not now" }).click();
      await expect(card(page)).toHaveCount(0);
      await expect(reply(page)).toBeVisible();
      expect(await startCalls(page)).toBe(1);
    } finally { await cleanup(f); }
  });

  test("Don't ask again starts the session, persists the setting, and a second thread shows no card", async () => {
    let f: Fixture | undefined;
    try {
      f = await launchFixture();
      const { page, vault } = f;
      await installSeams(page);
      const first = await newThread(page);
      await send(page, "hello");
      await expect(card(page)).toBeVisible();
      await watchSessionStart(page, first);
      await card(page).getByRole("button", { name: "Don't ask again" }).click();
      await expect(card(page)).toHaveCount(0);
      await expect(reply(page)).toBeVisible();
      expect(await startCalls(page)).toBe(1);
      await expect.poll(async () => JSON.parse(await fs.readFile(path.join(vault, ".geode/plugins/claude-threads/data.json"), "utf8")).sandboxSetupPromptDismissed).toBe(true);
      await newThread(page);
      const probesBefore = await page.evaluate(() => (window as any).__probeCalls);
      await send(page, "second");
      await expect(reply(page)).toBeVisible();
      await expect(card(page)).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__probeCalls)).toBe(probesBefore);
    } finally { await cleanup(f); }
  });

  test("Set up sandbox: progress, then done text, then the session starts", async () => {
    let f: Fixture | undefined;
    try {
      f = await launchFixture();
      const { page } = f;
      await installSeams(page);
      const id = await newThread(page);
      await send(page, "hello");
      await expect(card(page)).toBeVisible();
      await watchSessionStart(page, id);
      await card(page).getByRole("button", { name: "Set up sandbox" }).click();
      // The real confirm modal (download estimate) is shown before anything runs.
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const progress = card(page).locator(".ct-sandbox-offer-progress");
      await expect(progress).toContainText("Installing the runtime");
      expect(await noAssistantOutput(page)).toBe(0);
      expect(await startCalls(page)).toBe(0);
      await expect(progress).toContainText("Sandbox ready. This thread is starting inside it.");
      await expect(reply(page)).toBeVisible();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "sandbox-offer-done.png") });
      expect(await startCalls(page)).toBe(1);
      expect(await page.evaluate(() => (window as any).__setupRuns)).toBe(1);
      await card(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(card(page)).toHaveCount(0);
    } finally { await cleanup(f); }
  });

  test("a failed setup keeps the session held and the card actionable", async () => {
    let f: Fixture | undefined;
    try {
      f = await launchFixture();
      const { page } = f;
      await installSeams(page, { setupFails: true });
      const id = await newThread(page);
      await send(page, "hello");
      await expect(card(page)).toBeVisible();
      await watchSessionStart(page, id);
      await card(page).getByRole("button", { name: "Set up sandbox" }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(card(page).locator(".ct-sandbox-offer-error")).toContainText("fake setup failure");
      await expect(card(page).getByRole("button", { name: "Not now" })).toBeEnabled();
      await page.waitForTimeout(1500);
      expect(await noAssistantOutput(page)).toBe(0);
      expect(await startCalls(page)).toBe(0);
    } finally { await cleanup(f); }
  });

  test("deleting the thread while the card is up starts nothing", async () => {
    let f: Fixture | undefined;
    try {
      f = await launchFixture();
      const { page } = f;
      await installSeams(page);
      const id = await newThread(page);
      await send(page, "hello");
      await expect(card(page)).toBeVisible();
      await watchSessionStart(page, id);
      await page.evaluate((threadId) => (window as any).app.pluginManager.getPlugin("claude-threads").manager.deleteThread(threadId), id);
      await page.waitForTimeout(2500);
      // (The view may open a fresh empty thread afterwards, so check the id, not the count.)
      expect(await page.evaluate((threadId) => !!(window as any).app.pluginManager.getPlugin("claude-threads").manager.getThread(threadId), id)).toBe(false);
      await expect(card(page)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(REPLY);
      expect(await startCalls(page)).toBe(0);
      expect(await page.evaluate((threadId) => !!(window as any).app.pluginManager.getPlugin("claude-threads").manager.sessions.get(threadId), id)).toBe(false);
    } finally { await cleanup(f); }
  });
});
