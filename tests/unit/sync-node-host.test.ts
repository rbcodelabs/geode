import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { buildHistoryPorts, SyncBlockedError } from "../../src/sync-core/ports";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope } from "../../src/sync-core/scope";
import { NodeHost, SyncLockedError, SyncStateDirError, conflictCopyBase, defaultStateDir, hydrateIcloudPaths, scanVault, type ScanIo } from "../../src/sync-node/index";
import { currentBootId } from "../../src/sync-node/store-lock";
import { noPortable, openHost, put, rmrf, tmp } from "../helpers/node-host-harness";

const cleanups: string[] = [];
const dir = (prefix: string) => { const d = tmp(prefix); cleanups.push(d); return d; };
afterEach(() => { for (const d of cleanups.splice(0)) { try { chmodSync(join(d, "locked"), 0o755); } catch { /* absent */ } rmrf(d); } });
const paths = (items: Array<{ path: string }> | undefined) => (items ?? []).map(i => i.path);
const reasons = (items: Array<{ path: string; reason: string }> | undefined) => Object.fromEntries((items ?? []).map(i => [i.path, i.reason]));
const scan = (root: string, extra = {}) => scanVault({ root, settleMs: 0, detectEvicted: false, ...extra });

describe("vault scan", () => {
  it("lists files and folders, skips dotted names (.geode, .git, staging) and returns a complete scan", async () => {
    const root = dir("scan");
    put(root, "a.md"); put(root, "Notes/b.md"); put(root, ".geode/app.json"); put(root, ".git/HEAD"); put(root, ".geode-sync-tmp/.geode-sync-x"); put(root, ".trash/old.md");
    const report = await scan(root);
    expect(report.status).toBe("complete");
    expect(paths(report.entries)).toEqual(["Notes", "Notes/b.md", "a.md"]);
    expect(report.entries.find(e => e.path === "Notes")).toMatchObject({ isFolder: true });
    expect(report.blocked).toEqual([]);
    // the staging directory is also a reserved sync path, so it can never be uploaded as content even if listed
    expect(isPathInSyncScope(".geode-sync-tmp/.geode-sync-x", DEFAULT_SYNC_SCOPE)).toBe(false);
  });

  it("maps .name.icloud placeholders to the logical path as BLOCKED icloud-not-downloaded, never absent", async () => {
    const root = dir("icloud");
    put(root, "Notes/.Plan.md.icloud", "stub"); put(root, "real.md");
    const report = await scan(root);
    expect(paths(report.entries)).toEqual(["Notes", "real.md"]);
    expect(reasons(report.blocked)).toEqual({ "Notes/Plan.md": "icloud-not-downloaded" });
  });

  it("a real file wins over a stale stub of the same name", async () => {
    const root = dir("icloud-both");
    put(root, ".Same.md.icloud", "stub"); put(root, "Same.md");
    const report = await scan(root);
    expect(paths(report.entries)).toEqual(["Same.md"]); expect(report.blocked).toEqual([]);
  });

  it("reports evicted files that keep their name (blocks === 0, size > 0) as BLOCKED icloud-evicted", async () => {
    const root = dir("evicted");
    put(root, "gone.md", "contents"); put(root, "empty.md", ""); put(root, "here.md", "x");
    const io: ScanIo = {
      opendir: dir => import("node:fs/promises").then(fs => fs.opendir(dir)),
      lstat: async file => { const fs = await import("node:fs/promises"); const s = await fs.lstat(file); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { blocks: file.endsWith("gone.md") || file.endsWith("empty.md") ? 0 : s.blocks }); },
    };
    const report = await scan(root, { io, detectEvicted: true });
    expect(reasons(report.blocked)).toEqual({ "gone.md": "icloud-evicted" }); // an empty file with zero blocks is just empty
    expect(paths(report.entries)).toEqual(["empty.md", "here.md"]);
  });

  it("defers files modified inside the settle window as BLOCKED unsettled", async () => {
    const root = dir("settle");
    put(root, "old.md", "o", 60_000); put(root, "fresh.md", "f", 100);
    const report = await scan(root, { settleMs: 5000 });
    expect(paths(report.entries)).toEqual(["old.md"]);
    expect(reasons(report.blocked)).toEqual({ "fresh.md": "unsettled" });
    const future = join(root, "future.md"); writeFileSync(future, "x"); const t = (Date.now() + 3_600_000) / 1000; utimesSync(future, t, t);
    expect(reasons((await scan(root, { settleMs: 5000 })).blocked)["future.md"]).toBe("unsettled");
  });

  it("reports symlinks (file and directory) as blocked instead of following or omitting them", async () => {
    const root = dir("symlink"), outside = dir("outside");
    put(outside, "secret.md"); put(root, "real.md");
    symlinkSync(join(outside, "secret.md"), join(root, "link.md")); symlinkSync(outside, join(root, "linkdir"));
    const report = await scan(root);
    expect(paths(report.entries)).toEqual(["real.md"]);
    expect(reasons(report.blocked)).toEqual({ "link.md": "symlink", linkdir: "symlink" });
  });

  it("--exclude folders are reported as excluded and not walked", async () => {
    const root = dir("exclude");
    put(root, "Archive/old.md"); put(root, "keep/new.md");
    const report = await scan(root, { excludeFolders: ["Archive"] });
    expect(paths(report.entries)).toEqual(["keep", "keep/new.md"]);
    expect(reasons(report.excluded)).toEqual({ Archive: "excluded-folder" });
  });

  describe("iCloud conflict copies", () => {
    it("recognises only <stem> <N>.<ext> shapes", () => {
      expect(conflictCopyBase("Note 2.md")).toBe("Note.md");
      expect(conflictCopyBase("My Note 12.md")).toBe("My Note.md");
      expect(conflictCopyBase("Note 1.md")).toBeNull();
      expect(conflictCopyBase("Note 100.md")).toBeNull();
      expect(conflictCopyBase("Note 02.md")).toBeNull();
      expect(conflictCopyBase("Note 2")).toBeNull();
      expect(conflictCopyBase("Note2.md")).toBeNull();
      expect(conflictCopyBase("Note (2).md")).toBeNull();
    });
    it("excludes the copy only when the un-suffixed sibling also exists", async () => {
      const root = dir("conflict");
      put(root, "Note.md"); put(root, "Note 2.md"); put(root, "Note 3.md");
      put(root, "Chapter 2.md");                     // no "Chapter.md": legitimately named
      put(root, "Top 10.md"); put(root, "Top.txt");   // different extension: not a sibling
      put(root, "sub/Plan.md"); put(root, "Plan 2.md"); // sibling in a different folder does not count
      const report = await scan(root);
      expect(reasons(report.excluded)).toEqual({ "Note 2.md": "icloud-conflict-copy", "Note 3.md": "icloud-conflict-copy" });
      expect(paths(report.entries).filter(p => !p.endsWith("sub"))).toEqual(["Chapter 2.md", "Note.md", "Plan 2.md", "Top 10.md", "Top.txt", "sub/Plan.md"].sort());
    });
    it("a placeholder sibling counts as the base", async () => {
      const root = dir("conflict-stub");
      put(root, ".Note.md.icloud", "stub"); put(root, "Note 2.md");
      const report = await scan(root);
      expect(reasons(report.excluded)).toEqual({ "Note 2.md": "icloud-conflict-copy" });
      expect(reasons(report.blocked)).toEqual({ "Note.md": "icloud-not-downloaded" });
    });
  });

  it("an unreadable directory yields a PARTIAL scan, and the engine then refuses to plan (never infers deletes)", async () => {
    const root = dir("partial"), state = dir("partial-state");
    put(root, "ok.md"); put(root, "locked/hidden.md");
    chmodSync(join(root, "locked"), 0o000);
    const report = await scan(root);
    expect(report.status).toBe("partial");
    expect(report.failures).toEqual([{ path: "locked", code: "EACCES" }]);
    // through the real ports: a non-authoritative snapshot is what makes the controller throw rather than plan deletes
    const host = await openHost(root, join(state, "s"));
    await host.run(async lease => {
      const { ports } = buildHistoryPorts(host, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} });
      expect((await ports.snapshot()).authoritative).toBe(false);
    });
    chmodSync(join(root, "locked"), 0o755);
    expect((await scan(root)).status).toBe("complete");
  });

  it("a directory that vanishes mid-walk (ENOENT) is simply gone, not a partial scan", async () => {
    const root = dir("vanish"); put(root, "a/x.md"); put(root, "b.md");
    const real = await import("node:fs/promises");
    const io: ScanIo = { opendir: async d => { if (d.endsWith("/a")) { const e = new Error("gone") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } return real.opendir(d); }, lstat: f => real.lstat(f) };
    const report = await scan(root, { io });
    expect(report.status).toBe("complete"); expect(paths(report.entries)).toContain("b.md");
  });
});

describe("blocked paths reach the engine's snapshot", () => {
  it("scan.blocked / scan.excluded become snapshot.blocked / excluded and their paths are not entries", async () => {
    const root = dir("snap"), state = dir("snap-state");
    put(root, "Notes/.Plan.md.icloud", "stub"); put(root, "Note.md"); put(root, "Note 2.md"); put(root, "ok.md");
    const host = await openHost(root, join(state, "s"));
    await host.run(async lease => {
      const { ports } = buildHistoryPorts(host, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} });
      const snap = await ports.snapshot();
      expect(snap.authoritative).toBe(true);
      expect(snap.blocked).toEqual([{ namespace: "content", path: "Notes/Plan.md", reason: "icloud-not-downloaded" }]);
      expect(snap.excluded).toEqual([{ namespace: "content", path: "Note 2.md", reason: "icloud-conflict-copy" }]);
      expect(snap.entries.map(e => e.path).sort()).toEqual(["Note.md", "Notes", "ok.md"]);
    });
  });

  it("a read that fails because the file was evicted mid-run demotes that file to blocked instead of failing the run", async () => {
    const root = dir("midrun"), state = dir("midrun-state");
    put(root, "a.md"); put(root, "b.md");
    const host = await openHost(root, join(state, "s"));
    const real = host.vault.readBinary; host.vault.readBinary = async p => { if (p === "b.md") throw new SyncBlockedError("icloud-evicted"); return real(p); };
    await host.run(async lease => {
      const { ports } = buildHistoryPorts(host, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} });
      const snap = await ports.snapshot();
      expect(snap.authoritative).toBe(true);
      expect(snap.blocked).toEqual([{ namespace: "content", path: "b.md", reason: "icloud-evicted" }]);
      expect(snap.entries.map(e => e.path)).toEqual(["a.md"]);
    });
  });

  it("readBinary maps a placeholder-only name and a zero-block file to SyncBlockedError, and ENOENT stays a plain error", async () => {
    const root = dir("readmap"), state = dir("readmap-state");
    put(root, ".Gone.md.icloud", "stub"); put(root, "evicted.md", "data");
    const host = await openHost(root, join(state, "s"), { detectEvicted: false });
    await expect(host.vault.readBinary("Gone.md")).rejects.toMatchObject({ syncBlockedReason: "icloud-not-downloaded" });
    await expect(host.vault.readBinary("missing.md")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(host.vault.readBinary("../etc/passwd")).rejects.toThrow("Unsafe");
    expect((await host.vault.readBinary("evicted.md")).byteLength).toBe(4);
  });
});

describe("hash cache", () => {
  const setup = async (now?: () => number) => {
    const root = dir("hc"), state = dir("hc-state"); const host = await openHost(root, join(state, "s"));
    let reads = 0; const real = host.vault.readBinary; host.vault.readBinary = async p => (reads++, real(p));
    const snapshot = () => host.run(async lease => buildHistoryPorts(host, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {}, now }).ports.snapshot());
    return { root, state: join(state, "s"), host, snapshot, reads: () => reads };
  };
  it("is reused when (path,size,mtime,provider) are unchanged, persisted atomically as JSON, and invalidated by a stat change", async () => {
    const t = await setup();
    put(t.root, "a.md", "aaa"); put(t.root, "b.md", "bbb");
    const first = await t.snapshot(); expect(t.reads()).toBe(2);
    const file = join(t.state, "hash-cache.json"); expect(existsSync(file)).toBe(true);
    expect(readdirSync(t.state).filter(n => n.includes(".tmp-"))).toEqual([]);
    const second = await t.snapshot(); expect(t.reads()).toBe(2);
    expect(second.entries).toEqual(first.entries);
    // a fresh host (new process) loads the same cache from disk
    const again = await openHost(t.root, t.state); let reads = 0; const real = again.vault.readBinary; again.vault.readBinary = async p => (reads++, real(p));
    await again.run(async lease => { await buildHistoryPorts(again, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} }).ports.snapshot(); });
    expect(reads).toBe(0);
    put(t.root, "a.md", "changed!", 60_000);
    await t.snapshot(); expect(t.reads()).toBe(3);
    // a different provider id never inherits verdicts
    await t.host.run(async lease => { await buildHistoryPorts(t.host, { provider: { id: "other" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} }).ports.snapshot(); });
    expect(t.reads()).toBe(5);
  });
  it("keeps the racy-write guard: a file touched inside RACY_WRITE_WINDOW_MS is re-read every time, then trusted once it ages", async () => {
    let clock = Date.now(); const t = await setup(() => clock);
    put(t.root, "hot.md", "hot", 100);
    await t.snapshot(); await t.snapshot(); expect(t.reads()).toBe(2);
    // once its mtime has aged out of the window, the row written by the earlier read is trusted: no further reads
    clock += 3000; await t.snapshot(); await t.snapshot(); expect(t.reads()).toBe(2);
  });
  it("prunes rows for files that no longer exist (complete scans only)", async () => {
    const t = await setup(); put(t.root, "a.md"); put(t.root, "b.md");
    await t.snapshot(); const { rmSync } = await import("node:fs"); rmSync(join(t.root, "b.md"));
    await t.snapshot();
    const rows = JSON.parse((await import("node:fs")).readFileSync(join(t.state, "hash-cache.json"), "utf8")).entries;
    expect(Object.keys(rows)).toEqual(["a.md"]);
  });
});

describe("state directory", () => {
  it("rejects a state dir inside the vault (even via a not-yet-existing path or a symlink) and a vault inside the state dir", async () => {
    const root = dir("sd-vault");
    await expect(openHost(root, join(root, ".state"))).rejects.toBeInstanceOf(SyncStateDirError);
    await expect(openHost(root, join(root, "a", "b", "c"))).rejects.toBeInstanceOf(SyncStateDirError);
    await expect(openHost(root, root)).rejects.toBeInstanceOf(SyncStateDirError);
    const outside = dir("sd-out"); symlinkSync(root, join(outside, "viaLink"));
    await expect(openHost(root, join(outside, "viaLink", "state"))).rejects.toBeInstanceOf(SyncStateDirError);
    const parent = dir("sd-parent"); mkdirSync(join(parent, "vault")); 
    await expect(openHost(join(parent, "vault"), parent)).rejects.toBeInstanceOf(SyncStateDirError);
    await expect(NodeHost.open({ root })).rejects.toThrow("vaultId or stateDir");
  });
  it("defaults to ~/.geode/sync/<vaultId>, honours GEODE_SYNC_HOME, and refuses path-like vault ids", () => {
    expect(defaultStateDir("v1", {}, "/home/u")).toBe("/home/u/.geode/sync/v1");
    expect(defaultStateDir("v1", { GEODE_SYNC_HOME: "/data/sync" }, "/home/u")).toBe("/data/sync/v1");
    expect(() => defaultStateDir("../x", {}, "/h")).toThrow(SyncStateDirError);
  });
  it("persists device state durably and lays out ops/, trash/, recovery/ under it; storage and apply demand the lease", async () => {
    const root = dir("layout"), state = join(dir("layout-state"), "s");
    const host = await openHost(root, state);
    await expect(host.safety.storage("nope", "a".repeat(64), { action: "load-operations" })).rejects.toThrow("ownership");
    const binding = "b".repeat(64), op = "11111111-1111-4111-8111-111111111111";
    await host.run(async lease => {
      await host.deviceState.write("k", { n: 1 });
      await host.safety.storage(lease, binding, { action: "save-operation", key: op, value: { id: op } });
      await expect(host.safety.storage(lease, "../x", { action: "load-operations" })).rejects.toThrow("binding");
      await host.safety.apply(lease, { operationId: "22222222-2222-4222-8222-222222222222", path: "n.md", expectedHash: null, kind: "write", data: new TextEncoder().encode("hi").buffer as ArrayBuffer });
      await host.safety.apply(lease, { operationId: "33333333-3333-4333-8333-333333333333", path: "n.md", expectedHash: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4", kind: "trash" });
    });
    const reopened = await openHost(root, state);
    expect(await reopened.deviceState.read("k")).toEqual({ n: 1 });
    expect(readdirSync(join(state, "ops", binding))).toEqual([`${op}.json`]);
    expect(existsSync(join(state, "trash", "33333333-3333-4333-8333-333333333333", "n.md"))).toBe(true);
    expect(existsSync(join(state, "recovery", "22222222-2222-4222-8222-222222222222", "intent.json"))).toBe(true);
    // nothing of ours leaked into the vault except the (possibly empty) staging dir
    expect(readdirSync(root).filter(n => n !== ".geode-sync-tmp")).toEqual([]);
    expect(readdirSync(join(root, ".geode-sync-tmp"))).toEqual([]);
  });
});

describe("cross-process lock", () => {
  it("a second run in the same process and a foreign live owner both report locked; release makes it available again", async () => {
    const root = dir("lock"), state = join(dir("lock-state"), "s");
    const a = await openHost(root, state), b = await openHost(root, state);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const holding = a.run(async () => { await gate; return "done"; });
    await new Promise(r => setTimeout(r, 30));
    await expect(b.run(async () => 1)).rejects.toBeInstanceOf(SyncLockedError);
    expect(existsSync(join(state, "lock", "owner.json"))).toBe(true);
    release(); expect(await holding).toBe("done");
    expect(existsSync(join(state, "lock"))).toBe(false);
    expect(await b.run(async () => 2)).toBe(2);
    // a lock held by a different live process (pid 1, this boot) is respected
    mkdirSync(join(state, "lock"));
    writeFileSync(join(state, "lock", "owner.json"), JSON.stringify({ pid: 1, bootId: currentBootId(), token: "x", startedAt: Date.now() }));
    await expect(a.run(async () => 3)).rejects.toMatchObject({ code: "locked" });
  });
  it("recovers a stale lock: dead pid, or a different boot id", async () => {
    const root = dir("stale"), state = join(dir("stale-state"), "s"); const host = await openHost(root, state);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    for (const owner of [{ pid: dead, bootId: currentBootId() }, { pid: process.pid, bootId: "a-previous-boot" }]) {
      mkdirSync(join(state, "lock"), { recursive: true });
      writeFileSync(join(state, "lock", "owner.json"), JSON.stringify({ ...owner, token: "stale", startedAt: 1 }));
      expect(await host.run(async () => "ran")).toBe("ran");
    }
  });
  it("sweeps orphaned staging files left by a dead run", async () => {
    const root = dir("sweep"), state = join(dir("sweep-state"), "s"); const host = await openHost(root, state);
    mkdirSync(join(root, ".geode-sync-tmp")); writeFileSync(join(root, ".geode-sync-tmp", ".geode-sync-orphan"), "x");
    await host.run(async () => {});
    expect(readdirSync(join(root, ".geode-sync-tmp"))).toEqual([]);
  });
});

describe("opt-in iCloud hydration", () => {
  it("never runs a command by default", async () => {
    const root = dir("nohydrate"), state = join(dir("nohydrate-state"), "s"); put(root, ".A.md.icloud", "stub");
    const calls: string[][] = [];
    const host = await openHost(root, state, { hydrate: { runner: async (c, a) => (calls.push([c, ...a]), { code: 0, stderr: "" }) } });
    const scanned = await host.vault.reconcileScan();
    expect(calls).toEqual([]); expect(reasons(scanned.blocked)).toEqual({ "A.md": "icloud-not-downloaded" });
  });
  it("with hydrateIcloud, runs brctl download with bounded parallelism, polls until materialised, rescans, and leaves failures blocked", async () => {
    const root = dir("hydrate"), state = join(dir("hydrate-state"), "s");
    put(root, ".A.md.icloud", "stub"); put(root, ".B.md.icloud", "stub"); put(root, ".C.md.icloud", "stub"); put(root, ".D.md.icloud", "stub");
    let live = 0, peak = 0; const calls: string[] = [];
    let host!: NodeHost;
    const runner = async (command: string, args: string[]) => {
      expect(command).toBe("brctl"); expect(args[0]).toBe("download"); calls.push(args[1]);
      live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 20)); live--;
      const stub = args[1]; const real = join(stub, "..", stub.split("/").pop()!.slice(1, -".icloud".length));
      if (real.endsWith("C.md")) return { code: 1, stderr: "denied" };
      if (!real.endsWith("D.md")) { const fs = await import("node:fs"); fs.rmSync(stub); put(root, relative(host.root, real), "hydrated"); }
      return { code: 0, stderr: "" }; // D: command succeeds but never materialises -> timeout
    };
    host = await openHost(root, state, { hydrateIcloud: true, hydrate: { runner, concurrency: 2, timeoutMs: 120, pollMs: 20 } });
    const scanned = await host.vault.reconcileScan();
    expect(peak).toBe(2); expect(calls).toHaveLength(4);
    expect(paths(scanned.entries)).toEqual(["A.md", "B.md"]);
    expect(reasons(scanned.blocked)).toEqual({ "C.md": "icloud-not-downloaded", "D.md": "icloud-not-downloaded" });
    expect(host.lastHydration).toMatchObject({ requested: 4, hydrated: ["A.md", "B.md"], failed: [{ path: "C.md", reason: "brctl-exit-1" }, { path: "D.md", reason: "hydrate-timeout" }] });
  });
  it("hydrateIcloudPaths ignores non-iCloud issues", async () => {
    const calls: string[] = [];
    const report = await hydrateIcloudPaths("/x", [{ path: "a", reason: "symlink" }, { path: "b", reason: "unsettled" }], { runner: async () => (calls.push("x"), { code: 0, stderr: "" }) });
    expect(report).toEqual({ requested: 0, hydrated: [], failed: [] }); expect(calls).toEqual([]);
  });
});
