import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import { appDevice, hubCounts, tmpDir, rmrf, tree } from "../helpers/app-hub-harness";
import { put } from "../helpers/node-host-harness";

/**
 * The desktop hub provider (the real SyncService + HubSyncProvider, over a structured-clone "IPC" bridge to the real
 * HubStoreManager) and the headless CLI engine (`geode-wiki sync`, through the same run() the binary calls) against ONE
 * directory hub. Proves they speak one hub format: a store made by either is joined by the other, content converges
 * both ways without re-uploading, and a conflict and a delete behave. Config (raw.* vs projected documents) is the one
 * documented non-convergence; it is asserted below rather than assumed.
 */
vi.setConfig({ testTimeout: 90_000 });

const cleanups: string[] = [];
const dir = (prefix: string) => { const d = tmpDir(prefix); cleanups.push(d); return d; };
afterEach(() => { for (const d of cleanups.splice(0)) rmrf(d); });

async function cli(args: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [], err: string[] = [];
  const code = await run(args, { streams: { out: t => { out.push(t); }, err: t => { err.push(t); } }, env, stdin: Readable.from([]) });
  return { code, out: out.join(""), err: err.join(""), json: JSON.parse(out.join("").trim()) };
}

function cliDevice(name: string, hub: string) {
  const root = dir(name), home = dir(`${name}-home`), env = { GEODE_SYNC_HOME: home };
  const call = (sub: string, ...rest: string[]) => cli(["sync", sub, "--root", root, "--settle-ms", "0", "--json", ...rest], env);
  return {
    root, call,
    write: (rel: string, text: string) => put(root, rel, text),
    read: (rel: string) => readFileSync(join(root, rel), "utf8"),
    has: (rel: string) => existsSync(join(root, rel)),
    remove: (rel: string) => rmSync(join(root, rel), { force: true }),
    init: (create = false) => call("init", "--store", hub, ...(create ? ["--create"] : [])),
    async bootstrap() { await call("preview"); expect((await call("preview", "--approve")).code).toBe(0); const ran = await call("run"); expect(ran.code, ran.out + ran.err).toBe(0); return ran; },
  };
}

function appSide(name: string, hub: string) {
  const vault = dir(`${name}-vault`), userData = dir(`${name}-userdata`);
  return Object.assign(appDevice({ vault, userData }), {
    write: (rel: string, text: string) => put(vault, rel, text),
    read: (rel: string) => readFileSync(join(vault, rel), "utf8"),
    has: (rel: string) => existsSync(join(vault, rel)),
    remove: (rel: string) => rmSync(join(vault, rel), { force: true }),
    hub,
  });
}

describe("the app provider and the CLI engine share one hub", () => {
  it("converge in both directions without re-uploading, through a conflict and a delete", async () => {
    const hub = dir("hub");
    const cliDev = cliDevice("cli", hub), app = appSide("app", hub);

    // CLI starts the hub and publishes the first content (init --create, then the approved first run).
    cliDev.write("Home.md", "home"); cliDev.write("Projects/Plan.md", "plan v1"); cliDev.write("Shared.md", "shared v1"); cliDev.write("Doomed.md", "doomed"); cliDev.write("Keep.md", "keep");
    expect((await cliDev.init(true)).code).toBe(0);
    await cliDev.bootstrap();

    // The app is pointed at the same hub (no create: it must find the CLI's vault) and joins.
    await app.configure({ kind: "fs", path: hub });
    await app.connect("join");
    const before = hubCounts(hub);
    const first = await app.firstSync();
    // Uploads here are only the app's own projected settings documents (portable-config); no content is republished.
    expect(first.preview).toMatchObject({ deletes: 0, conflicts: 0, requiresApproval: true });
    expect(first.preview.downloads).toBeGreaterThanOrEqual(5);
    expect(tree(app.vault)).toEqual(tree(cliDev.root));
    // Joining a populated hub downloads; it must not republish what the CLI already published.
    expect(hubCounts(hub)).toEqual(before);

    // App edit -> hub -> CLI.
    app.write("Projects/Plan.md", "plan v2 (app)");
    app.write("FromApp.md", "app note");
    await app.sync();
    expect((await cliDev.call("run")).code).toBe(0);
    expect(cliDev.read("Projects/Plan.md")).toBe("plan v2 (app)");
    expect(cliDev.read("FromApp.md")).toBe("app note");

    // CLI edit -> hub -> app (the unattended path: no approval).
    cliDev.write("Home.md", "home (cli)");
    expect((await cliDev.call("run")).code).toBe(0);
    await app.sync();
    expect(app.read("Home.md")).toBe("home (cli)");

    // A concurrent edit of one file on both devices: the first to publish wins the line, the other sees a conflict.
    cliDev.write("Shared.md", "shared (cli)");
    app.write("Shared.md", "shared (app)");
    expect((await cliDev.call("run")).code).toBe(0);
    await app.sync();
    const conflicts = app.service.getHistoryDetails()!.conflicts;
    expect(conflicts.map(c => c.path)).toEqual(["Shared.md"]);
    expect(app.service.getStatus().state).toBe("conflict");
    expect(app.read("Shared.md"), "a conflict leaves the local file alone").toBe("shared (app)");
    // Resolve in the app by keeping the local version; the CLI then receives it.
    await app.service.resolveHistoryConflict({ entityId: conflicts[0].entityId, heads: conflicts[0].heads, choice: { kind: "current" } });
    await app.settle();
    expect(app.service.getHistoryDetails()!.conflicts).toEqual([]);
    expect((await cliDev.call("run")).code, "the CLI sees no conflict once the app resolved it").toBe(0);
    expect(cliDev.read("Shared.md")).toBe("shared (app)");

    // Deletes propagate both ways.
    cliDev.remove("Doomed.md");
    expect((await cliDev.call("run")).code).toBe(0);
    await app.sync();
    expect(app.has("Doomed.md")).toBe(false);
    app.remove("Keep.md");
    await app.sync();
    expect((await cliDev.call("run")).code).toBe(0);
    expect(cliDev.has("Keep.md")).toBe(false);

    // Both sides end identical, and a further round trip changes nothing.
    expect(tree(app.vault)).toEqual(tree(cliDev.root));
    const settled = hubCounts(hub);
    await app.sync(); expect((await cliDev.call("run")).code).toBe(0); await app.sync();
    expect(hubCounts(hub)).toEqual(settled);
    await app.close();
  });

  it("a hub created by the app is discovered and joined by the CLI (no --create)", async () => {
    const hub = dir("hub-by-app");
    const app = appSide("app", hub);
    app.write("A.md", "from the app"); app.write("Sub/B.md", "nested");
    await app.configure({ kind: "fs", path: hub }, true);
    await app.connect({ create: "Personal" });
    await app.firstSync();

    const cliDev = cliDevice("cli", hub);
    const init = await cliDev.init(false);
    expect(init.code, init.out + init.err).toBe(0);
    expect(init.json.result.name).toBe("Personal");
    await cliDev.bootstrap();
    expect(tree(cliDev.root)).toEqual({ "A.md": "from the app", "Sub/B.md": "nested" });
    await app.close();
  });

  it("config does not unify: the app ignores the CLI's raw.* config files, the CLI ignores projected documents", async () => {
    const hub = dir("hub-config");
    const cliDev = cliDevice("cli", hub), app = appSide("app", hub);
    cliDev.write("N.md", "note");
    cliDev.write(".obsidian/app.json", JSON.stringify({ vimMode: true }));
    cliDev.write(".obsidian/hotkeys.json", JSON.stringify({}));
    expect((await cliDev.init(true)).code).toBe(0);
    await cliDev.bootstrap();
    await app.configure({ kind: "fs", path: hub });
    await app.connect("join");
    const { preview } = await app.firstSync();
    // Content arrives; raw config is neither downloaded, blocked nor a conflict.
    expect(app.read("N.md")).toBe("note");
    expect(app.has(".obsidian/app.json")).toBe(false);
    expect(preview.conflicts).toBe(0);
    expect(app.service.getHistoryDetails()!.blocked).toEqual([]);
    expect(app.service.getStatus().state).toBe("idle");
    await app.close();
  });
});

describe("the app provider honours the same rails as the CLI", () => {
  async function pairWithFiles(count: number, hub: string) {
    const cliDev = cliDevice("cli", hub), app = appSide("app", hub);
    for (let i = 0; i < count; i++) cliDev.write(`n${String(i).padStart(3, "0")}.md`, `note ${i}`);
    expect((await cliDev.init(true)).code).toBe(0);
    await cliDev.bootstrap();
    await app.configure({ kind: "fs", path: hub });
    await app.connect("join");
    await app.firstSync();
    expect(Object.keys(tree(app.vault))).toHaveLength(count);
    return { cliDev, app };
  }

  it("(a) an unapproved device never syncs on the unattended path", async () => {
    const hub = dir("hub-a");
    const cliDev = cliDevice("cli", hub), app = appSide("app", hub);
    cliDev.write("X.md", "x"); expect((await cliDev.init(true)).code).toBe(0); await cliDev.bootstrap();
    await app.configure({ kind: "fs", path: hub }); await app.connect("join");
    await app.service.preview();
    await expect(app.service.run()).rejects.toThrow();
    expect(app.has("X.md"), "nothing is applied without a confirmed preview").toBe(false);
    await app.close();
  });

  it("(b) refuses a run that would delete more than max(20, 1%) and lifts only on an explicit one-shot override", async () => {
    const hub = dir("hub-b");
    const { cliDev, app } = await pairWithFiles(30, hub);
    for (let i = 0; i < 25; i++) cliDev.remove(`n${String(i).padStart(3, "0")}.md`);
    expect((await cliDev.call("run", "--override-delete-limit", "30", "--override-shrunk-scan")).code).toBe(0);

    await expect(app.sync()).rejects.toMatchObject({ status: "delete-limit-exceeded" });
    expect(Object.keys(tree(app.vault)), "refusal changes nothing").toHaveLength(30);
    expect(app.service.getRailRefusal()).toMatchObject({ status: "delete-limit-exceeded", detail: { deletions: 25, limit: 20 } });
    expect(app.service.getStatus().state).toBe("error");

    // A second unattended attempt is still refused: overrides are one-shot and only a person arms them.
    await expect(app.sync()).rejects.toMatchObject({ status: "delete-limit-exceeded" });

    app.service.allowRailOverrideOnce({ deleteLimit: 25 });
    await app.sync();
    expect(Object.keys(tree(app.vault))).toHaveLength(5);
    expect(app.service.getRailRefusal()).toBeUndefined();
    await app.close();
  });

  it("(b) the override replaces the limit, it does not disable it", async () => {
    const hub = dir("hub-b2");
    const { cliDev, app } = await pairWithFiles(40, hub);
    for (let i = 0; i < 30; i++) cliDev.remove(`n${String(i).padStart(3, "0")}.md`);
    expect((await cliDev.call("run", "--override-delete-limit", "40", "--override-shrunk-scan")).code).toBe(0);
    app.service.allowRailOverrideOnce({ deleteLimit: 5 });
    await expect(app.sync()).rejects.toMatchObject({ status: "delete-limit-exceeded" });
    expect(Object.keys(tree(app.vault))).toHaveLength(40);
    await app.close();
  });

  it("(c) refuses a scan that shrank below half of what the device knows, and publishes nothing", async () => {
    const hub = dir("hub-c");
    const { app } = await pairWithFiles(10, hub);
    for (let i = 0; i < 8; i++) app.remove(`n${String(i).padStart(3, "0")}.md`); // an unmounted volume looks like this
    const before = hubCounts(hub);
    await expect(app.sync()).rejects.toMatchObject({ status: "scan-shrunk" });
    expect(hubCounts(hub), "a short scan must never publish deletions").toEqual(before);
    expect(app.service.getRailRefusal()).toMatchObject({ status: "scan-shrunk", detail: { found: 2, known: 10 } });

    app.service.allowRailOverrideOnce({ shrunkScan: true });
    await app.sync();
    expect(hubCounts(hub).records).toBeGreaterThan(before.records); // the (user-confirmed) deletions are now published
    await app.close();
  });

  it("(d) an iCloud placeholder is blocked, never read as a deletion, and never fetched", async () => {
    const hub = dir("hub-d");
    const { cliDev, app } = await pairWithFiles(4, hub);
    // The real file is evicted: only its `.name.icloud` stand-in remains.
    rmSync(join(app.vault, "n001.md")); writeFileSync(join(app.vault, ".n001.md.icloud"), "stub");
    const before = hubCounts(hub);
    await app.sync();
    expect(hubCounts(hub), "an evicted file is not a deletion").toEqual(before);
    expect(app.service.getHistoryDetails()!.blocked).toEqual([expect.objectContaining({ path: "n001.md", reason: "icloud-not-downloaded" })]);
    expect(existsSync(join(app.vault, "n001.md")), "never hydrated").toBe(false);
    expect((await cliDev.call("run")).code).toBe(0);
    expect(cliDev.has("n001.md"), "the other device still has the file").toBe(true);
    await app.close();
  });
});

describe("configuration guards", () => {
  it("creating a hub vault needs the explicit create flag", async () => {
    const hub = dir("hub-nocreate");
    const app = appSide("app", hub);
    await app.configure({ kind: "fs", path: hub }, false);
    app.service.register("geode", app.provider);
    await app.service.activate("geode.hub");
    await expect(app.service.createVault("Nope")).rejects.toThrow(/switched off/);
    expect(await app.service.discoverVaults()).toEqual([]);
    await app.close();
  });

  it("an unconfigured provider says so instead of failing obscurely", async () => {
    const app = appSide("app", dir("hub-unconfigured"));
    app.service.register("geode", app.provider);
    await app.service.activate("geode.hub");
    await expect(app.service.discoverVaults()).rejects.toThrow(/No hub is configured/);
    await app.close();
  });
});
