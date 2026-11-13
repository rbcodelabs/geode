import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Throwaway QA spec (not for merge): does Geode load the renamed
 * rbcodelabs/threads-artifacts plugin (b9c73a8, id `threads-artifacts`) and do
 * designs created by the previous build (70d1f3a, id `threads-design`) keep working?
 */
const repoRoot = path.resolve(__dirname, "..", "..");
const fx = path.join(repoRoot, "tests", "fixtures", "threads-artifacts-rename");
const LEGACY_OWNER = { pluginId: "threads-design", displayName: "Design for Agent Threads" };

function install(vaultDir: string, folder: string, src: "new" | "old" | "agent-threads") {
  const dir = path.join(vaultDir, ".geode", "plugins", folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(path.join(fx, src))) fs.copyFileSync(path.join(fx, src, f), path.join(dir, f));
  return dir;
}
function seedAgentThreads(vaultDir: string) {
  const dir = install(vaultDir, "claude-threads", "agent-threads");
  const dataFile = path.join(dir, "data.json");
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({
      threadViewPlacement: "conversation-first", hasSeenWelcome: true,
      threads: [], projects: [], scheduledItems: [], skillSources: [], mcpServers: {},
      statusLineCommand: "", autoSummarize: false, telemetryEnabled: false,
      wakeLockEnabled: false, remoteAccess: { enabled: false },
    }));
  }
}
function setup(prefix: string) {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-vault-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-ud-`));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Hello\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  return { vaultDir, userDataDir };
}
const enable = (vaultDir: string, ids: string[]) =>
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(ids));

async function launch(userDataDir: string, log: string[]) {
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const win = await app.firstWindow();
  win.on("console", (m) => { if (["error", "warning"].includes(m.type())) log.push(`[console.${m.type()}] ${m.text()}`); });
  win.on("pageerror", (e) => log.push(`[pageerror] ${String(e)}`));
  return { app, win };
}
const pm = (win: Page, id: string) => win.evaluate((pid) => {
  const m = (window as any).app?.pluginManager;
  if (!m) return { enabled: false, loadError: null, manifest: null, managerReady: false };
  return { managerReady: true, enabled: m.isEnabled(pid), loadError: m.getLoadError(pid) ?? null, manifest: m.getManifest(pid) ? { id: m.getManifest(pid).id, name: m.getManifest(pid).name, version: m.getManifest(pid).version } : null };
}, id);
const dump = (label: string, log: string[]) => console.log(`=== ${label}: console warnings/errors (${log.length}) ===\n${log.join("\n") || "(none)"}`);

test("T1 new id alone: threads-artifacts loads, no id/folder error, 'requires Agent Threads' Notice appears", async () => {
  test.setTimeout(90_000);
  const { vaultDir, userDataDir } = setup("ta-t1");
  install(vaultDir, "threads-artifacts", "new");
  enable(vaultDir, ["threads-artifacts"]);
  const log: string[] = [];
  const { app, win } = await launch(userDataDir, log);
  try {
    await expect.poll(() => pm(win, "threads-artifacts").then((s) => s.enabled), { timeout: 30_000 }).toBe(true);
    const state = await pm(win, "threads-artifacts");
    console.log("T1 pluginManager state:", JSON.stringify(state));
    expect(state.loadError).toBeNull();
    expect(state.manifest).toEqual({ id: "threads-artifacts", name: "Artifacts for Agent Threads", version: "0.8.2" });
    const instance = await win.evaluate(() => (window as any).app.pluginManager.getPlugin("threads-artifacts")?.constructor?.name ?? null);
    console.log("T1 plugin instance class:", instance);
    expect(instance).not.toBeNull();
    // No Agent Threads present: plugin's 15 s startup timer should surface its Notice.
    const notice = win.locator(".notice", { hasText: "requires Agent Threads with public API v1" });
    await expect(notice).toBeVisible({ timeout: 40_000 });
    console.log("T1 Notice text:", await notice.first().innerText());
  } finally {
    dump("T1", log);
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true }); fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("T2 negative: new manifest inside old folder name threads-design is rejected (id/folder mismatch)", async () => {
  test.setTimeout(60_000);
  const { vaultDir, userDataDir } = setup("ta-t2");
  install(vaultDir, "threads-design", "new"); // new manifest (id threads-artifacts) in the OLD folder name
  enable(vaultDir, ["threads-design"]);
  const log: string[] = [];
  const { app, win } = await launch(userDataDir, log);
  try {
    await expect.poll(() => pm(win, "threads-design").then((s) => s.managerReady && s.loadError), { timeout: 30_000 }).toBeTruthy();
    const old = await pm(win, "threads-design");
    const neu = await pm(win, "threads-artifacts");
    console.log("T2 state[threads-design]:", JSON.stringify(old));
    console.log("T2 state[threads-artifacts]:", JSON.stringify(neu));
    expect(old.enabled).toBe(false);
    expect(old.loadError).toContain('does not match its plugin folder name "threads-design"');
    expect(neu.enabled).toBe(false);
  } finally {
    dump("T2", log);
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true }); fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("T3 migration with real Agent Threads: design made by old threads-design build survives swap to threads-artifacts", async () => {
  test.setTimeout(180_000);
  const { vaultDir, userDataDir } = setup("ta-t3");
  seedAgentThreads(vaultDir);
  install(vaultDir, "threads-design", "old");
  enable(vaultDir, ["claude-threads", "threads-design"]);
  const ready = (win: Page, id: string) => win.evaluate((pid) => {
    const m = (window as any).app?.pluginManager;
    const p = m?.getPlugin("claude-threads");
    return !!p?.api?.v1 && m.isEnabled(pid);
  }, id);
  const log1: string[] = [];
  let threadId = ""; let artifactId = "legacy-design-0001"; let root = "";
  // ---- Phase 1: OLD build creates a design artifact ----
  {
    const { app, win } = await launch(userDataDir, log1);
    try {
      await expect.poll(() => ready(win, "threads-design"), { timeout: 60_000 }).toBe(true);
      const created = await win.evaluate(async ({ vaultDir, artifactId, owner }) => {
        const api = (window as any).app.pluginManager.getPlugin("claude-threads").api.v1;
        const { threadId } = await api.threads.create({ title: "Legacy design thread", cwd: vaultDir });
        const alloc = await api.artifacts.allocateStorage(threadId, artifactId, { location: "visible", folderName: "Legacy Pricing Page", owner: { pluginId: "threads-design" } });
        return { threadId, alloc, caps: api.capabilities.length };
      }, { vaultDir, artifactId, owner: LEGACY_OWNER });
      console.log("T3 phase1 allocation:", JSON.stringify(created));
      expect(created.alloc.success).toBe(true);
      threadId = created.threadId; root = created.alloc.path;
      expect(root).toContain(`${path.sep}Artifacts${path.sep}threads-design${path.sep}`);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Legacy</title><h1 id=hello>Legacy design</h1>");
      const manifestPath = path.join(root, "artifact.json");
      fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, id: artifactId, title: "Legacy Pricing Page", entry: "index.html", runtime: "static", createdByThreadId: threadId, viewport: { preset: "desktop", width: 1440, height: 900 }, permissions: { network: "none", clipboard: false } }));
      const attached = await win.evaluate(async ({ threadId, artifactId, root, manifestPath, owner }) => {
        const api = (window as any).app.pluginManager.getPlugin("claude-threads").api.v1;
        const res = await api.artifacts.attach(owner, threadId, {
          providerId: "agent-threads.design", kind: "design-static", schemaVersion: 2, id: artifactId, title: "Legacy Pricing Page", storageRoot: root,
          data: { id: artifactId, kind: "design-static", title: "Legacy Pricing Page", providerId: "agent-threads.design", schemaVersion: 2, runtime: "static", storageRoot: root, root, manifestPath, entryPath: root + "/index.html", createdAt: 1, updatedAt: 1 },
        });
        return { res, list: (await api.artifacts.list(threadId)).map((a: any) => ({ id: a.id, providerId: a.providerId, kind: a.kind })) };
      }, { threadId, artifactId, root, manifestPath, owner: LEGACY_OWNER });
      console.log("T3 phase1 attach (old id owner):", JSON.stringify(attached));
      expect(attached.res.success).toBe(true);
      expect(attached.list).toEqual([{ id: artifactId, providerId: "agent-threads.design", kind: "design-static" }]);
      // Wait for Agent Threads to persist the thread + artifact to its data.json.
      const dataFile = path.join(vaultDir, ".geode", "plugins", "claude-threads", "data.json");
      await expect.poll(() => fs.readFileSync(dataFile, "utf8").includes("Legacy Pricing Page"), { timeout: 30_000 }).toBe(true);
    } finally { dump("T3 phase1 (old build)", log1); await app.close(); }
  }
  // ---- Swap the plugin folder: threads-design -> threads-artifacts (the PR's migration instruction) ----
  fs.rmSync(path.join(vaultDir, ".geode", "plugins", "threads-design"), { recursive: true, force: true });
  install(vaultDir, "threads-artifacts", "new");
  enable(vaultDir, ["claude-threads", "threads-artifacts"]);
  // ---- Phase 2: NEW build, same vault ----
  const log2: string[] = [];
  const { app, win } = await launch(userDataDir, log2);
  try {
    await expect.poll(() => ready(win, "threads-artifacts"), { timeout: 60_000 }).toBe(true);
    console.log("T3 phase2 state:", JSON.stringify(await pm(win, "threads-artifacts")), JSON.stringify(await pm(win, "threads-design")));
    expect((await pm(win, "threads-artifacts")).loadError).toBeNull();
    await win.evaluate(async () => {
      const a = (window as any).app;
      await new Promise<void>((resolve) => a.workspace.onLayoutReady(resolve));
      await a.pluginManager.getPlugin("claude-threads").activateView();
    });
    // Give the new plugin time to register its provider (api-ready) and settle migration.
    await expect.poll(() => win.evaluate(async ({ threadId, artifactId }) => {
      const api = (window as any).app.pluginManager.getPlugin("claude-threads").api.v1;
      const r = await api.artifacts.invokeAction(threadId, artifactId, "definitely-unknown-action");
      return r.message ?? r.status;
    }, { threadId, artifactId }), { timeout: 30_000 }).toContain("Unknown design artifact action");
    const out = await win.evaluate(async ({ threadId, artifactId }) => {
      const api = (window as any).app.pluginManager.getPlugin("claude-threads").api.v1;
      const list = (await api.artifacts.list(threadId)).map((a: any) => ({ id: a.id, providerId: a.providerId, kind: a.kind, title: a.title }));
      const preview = await api.artifacts.invokeAction(threadId, artifactId, "preview");
      await new Promise((r) => setTimeout(r, 1500));
      const leaves = (window as any).app.workspace.getLeavesOfType("geode-artifact").length;
      return { list, preview, artifactLeaves: leaves, noNewNotice: !document.querySelector(".notice")?.textContent?.includes("requires Agent Threads") };
    }, { threadId, artifactId });
    console.log("T3 phase2 result:", JSON.stringify(out));
    expect(out.list).toEqual([{ id: artifactId, providerId: "agent-threads.design", kind: "design-static", title: "Legacy Pricing Page" }]);
    expect(out.preview.status).toBe("ok");
    expect(out.artifactLeaves).toBeGreaterThan(0);
    // The sidecar file location is still where the old build put it.
    expect(fs.existsSync(path.join(root, "artifact.json"))).toBe(true);
    await win.screenshot({ path: path.join(process.env.TA_OUT ?? os.tmpdir(), "t3-after-rename-preview.png") });
  } finally {
    dump("T3 phase2 (new build)", log2);
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true }); fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
