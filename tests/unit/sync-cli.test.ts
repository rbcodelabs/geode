import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import { EXIT, exitNameFor } from "../../src/cli/output";
import { NodeHost, classifySyncError, deleteLimitFor, syncRun, SyncRailError, SyncRefusal } from "../../src/sync-node/index";
import { put, rmrf, tmp } from "../helpers/node-host-harness";

/**
 * `geode-wiki sync` through the same `run()` the binary calls, against real directories and the real
 * FsStore hub. scripts/run-wiki-sync-proof.mjs repeats the headline claims in real subprocesses over
 * a stand-in for ssh; these tests localise a regression to a rule.
 */

// Each test drives several real syncs (hash, hub IO); the shared machine is routinely loaded.
vi.setConfig({ testTimeout: 90_000 });

const cleanups: string[] = [];
const dir = (prefix: string) => { const d = tmp(prefix); cleanups.push(d); return d; };
afterEach(() => { for (const d of cleanups.splice(0)) rmrf(d); });

interface Result { code: number; out: string; err: string; json: any }
async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  const out: string[] = [], err: string[] = [];
  const code = await run(args, { streams: { out: t => { out.push(t); }, err: t => { err.push(t); } }, env, stdin: Readable.from([]) });
  const text = out.join("");
  let json: any = null;
  if (args.includes("--json")) { json = JSON.parse(text.trim()); expect(json.exit.code, "envelope exit must equal the returned code").toBe(code); }
  return { code, out: text, err: err.join(""), json };
}

/** One device: a vault directory and its own GEODE_SYNC_HOME, bound to a shared hub directory. */
function device(name: string, hub: string) {
  const root = dir(name), home = dir(`${name}-home`), env = { GEODE_SYNC_HOME: home };
  const call = (sub: string, ...rest: string[]) => cli(["sync", sub, "--root", root, "--settle-ms", "0", "--json", ...rest], env);
  const d = {
    root, home, env, call,
    write: (rel: string, text: string) => put(root, rel, text),
    read: (rel: string) => readFileSync(join(root, rel), "utf8"),
    has: (rel: string) => existsSync(join(root, rel)),
    init: (create = false) => call("init", "--store", hub, ...(create ? ["--create"] : [])),
    /** The documented first-run ritual: preview, approve, run. */
    async bootstrap() { await call("preview"); const approved = await call("preview", "--approve"); expect(approved.code, approved.out).toBe(0); const ran = await call("run"); expect(ran.code, ran.out + ran.err).toBe(0); return ran; },
  };
  return d;
}
const hubDir = () => dir("hub");
const bulk = (d: ReturnType<typeof device>, n: number, prefix = "n") => { for (let i = 0; i < n; i++) d.write(`${prefix}${String(i).padStart(3, "0")}.md`, `note ${i}`); };

describe("exit vocabulary", () => {
  it("adds exactly 4 (conflicts) and 5 (locked) to the original four", () => {
    expect(EXIT).toEqual({ ok: 0, refused: 1, usage: 2, unavailable: 3, conflicts: 4, locked: 5 });
    expect(exitNameFor("conflicts")).toBe("conflicts");
    expect(exitNameFor("locked")).toBe("locked");
    expect(exitNameFor("store-unavailable")).toBe("unavailable");
    for (const refused of ["approval-required", "approval-stale", "delete-limit-exceeded", "scan-shrunk", "not-initialised"]) expect(exitNameFor(refused), refused).toBe("refused");
  });
  it("classifies thrown errors onto statuses", () => {
    expect(classifySyncError(new SyncRailError("scan-shrunk", "m", { a: 1 }, "--x"))).toMatchObject({ status: "scan-shrunk", override: "--x" });
    expect(classifySyncError(new SyncRefusal("not-initialised", "m")).status).toBe("not-initialised");
    expect(classifySyncError(new Error("Resume pending sync before preview")).status).toBe("pending-batch");
    expect(classifySyncError(new Error("Authoritative local snapshot unavailable")).status).toBe("scan-incomplete");
    expect(classifySyncError(new Error("boom")).status).toBe("sync-failed");
  });
  it("delete limit is max(20, 1%)", () => { expect(deleteLimitFor(0)).toBe(20); expect(deleteLimitFor(1999)).toBe(20); expect(deleteLimitFor(5000)).toBe(50); });
});

describe("usage and init", () => {
  it("argument errors exit 2 and never touch the vault", async () => {
    const a = device("usage", hubDir());
    expect((await cli(["sync"])).code).toBe(2);
    expect((await cli(["sync", "frobnicate"])).code).toBe(2);
    expect((await cli(["sync", "run"])).code).toBe(2); // no --root
    expect((await a.call("run", "--bogus")).code).toBe(2);
    expect((await a.call("run", "--override-delete-limit", "many")).code).toBe(2);
    expect((await a.call("resolve", "x.md")).code).toBe(2); // neither --keep nor --version
    expect((await a.call("resolve", "x.md", "--keep", "middle")).code).toBe(2);
    expect((await a.call("resolve", "x.md", "--keep", "local", "--version", "r")).code).toBe(2);
    expect((await a.call("init")).code).toBe(2); // no --store
    expect((await a.call("gc", "--trash-days", "soon")).code).toBe(2);
    expect((await cli(["sync", "serve"])).code).toBe(2);
    expect((await cli(["sync", "serve", "--store", "/tmp/x"])).code).toBe(2); // no raw stdout in-process
    expect((await cli(["sync", "--help"])).out).toContain("Safety rails");
  });

  it("an unbound vault is refused by name, not crashed on", async () => {
    const a = device("unbound", hubDir());
    for (const sub of ["status", "preview", "run", "conflicts"]) { const r = await a.call(sub); expect([sub, r.json.status, r.code]).toEqual([sub, "not-initialised", 1]); }
  });

  it("refuses an empty store without --create, creates with it, refuses to rebind, and a second device joins", async () => {
    const hub = hubDir(), a = device("a", hub), b = device("b", hub);
    const empty = await a.init(false);
    expect([empty.json.status, empty.code]).toEqual(["store-empty", 1]);
    expect(existsSync(join(a.home))).toBe(true);
    expect(readdirSync(a.home)).toEqual([]); // nothing written on refusal
    const created = await a.init(true);
    expect([created.json.status, created.json.result.created]).toEqual(["ok", true]);
    const again = await a.init(true);
    expect(again.json.status).toBe("already-initialised");
    const joined = await b.init(false);
    expect([joined.json.status, joined.json.result.created, joined.json.result.vaultId]).toEqual(["ok", false, created.json.result.vaultId]);
    expect(joined.json.result.deviceId).not.toBe(created.json.result.deviceId);
  });

  it("rejects bad --exclude and a state dir inside the vault", async () => {
    const hub = hubDir(), a = device("a", hub);
    expect((await a.call("init", "--store", hub, "--create", "--exclude", "../up")).json.status).toBe("invalid-exclude");
    const inside = await cli(["sync", "init", "--root", a.root, "--state-dir", join(a.root, "state"), "--store", hub, "--create", "--json"], a.env);
    expect(inside.json.status).toBe("state-dir-invalid");
  });

  it("an unreachable vault folder is vault-unavailable (3)", async () => {
    const r = await cli(["sync", "status", "--root", "/definitely/not/here", "--json"], { GEODE_SYNC_HOME: dir("h") });
    expect([r.json.status, r.code]).toEqual(["vault-unavailable", 3]);
  });
});

describe("rail (a): first run needs an approved preview", () => {
  it("run without an approved preview is refused and changes nothing; a stale approval is refused; a matching one runs", async () => {
    const hub = hubDir(), a = device("a", hub);
    a.write("one.md", "1"); await a.init(true);

    const bare = await a.call("run");
    expect([bare.json.status, bare.code]).toEqual(["approval-required", 1]);
    expect(readdirSync(join(hub, "records"))).toEqual([]);

    const peek = await a.call("preview");
    expect(peek.json.result.preview).toMatchObject({ uploads: 1, requiresApproval: true });
    expect(peek.json.result.approvalRecorded).toBe(false);
    expect((await a.call("run")).json.status).toBe("approval-required"); // a plain preview is not approval

    expect((await a.call("preview", "--approve")).json.result.approvalRecorded).toBe(true);
    a.write("two.md", "2"); // the vault moves after the human looked
    const stale = await a.call("run");
    expect([stale.json.status, stale.code]).toEqual(["approval-stale", 1]);
    expect(stale.json.result.now.uploads).toBe(2);
    expect(stale.json.result.approved.uploads).toBe(1);

    await a.call("preview", "--approve");
    const ran = await a.call("run");
    expect([ran.json.status, ran.json.result.planned.uploads, ran.json.result.after.upToDate]).toEqual(["ok", 2, true]);
    expect(readdirSync(join(hub, "records")).length).toBeGreaterThan(0);

    a.write("three.md", "3"); // later runs need no approval
    expect((await a.call("run")).json.status).toBe("ok");
    const status = (await a.call("status")).json.result;
    expect([status.approved, status.approvalRecorded, status.knownFiles]).toEqual([true, null, 3]);
  });

  it("a joining device must also approve before its first run", async () => {
    const hub = hubDir(), a = device("a", hub), b = device("b", hub);
    a.write("n.md", "n"); await a.init(true); await a.bootstrap();
    await b.init(false);
    expect((await b.call("run")).json.status).toBe("approval-required");
    await b.bootstrap();
    expect(b.read("n.md")).toBe("n");
  });
});

describe("convergence, deletes and conflicts (exit 4)", () => {
  async function pair() {
    const hub = hubDir(), a = device("a", hub), b = device("b", hub);
    a.write("base.md", "base"); a.write("Notes/keep.md", "keep");
    await a.init(true); await a.bootstrap(); await b.init(false); await b.bootstrap();
    return { hub, a, b };
  }

  it("propagates edits and deletions both ways; deleted files go to the device trash", async () => {
    const { a, b } = await pair();
    expect(b.read("base.md")).toBe("base");
    a.write("fresh.md", "fresh"); await a.call("run"); await b.call("run");
    expect(b.read("fresh.md")).toBe("fresh");
    rmSync(join(a.root, "Notes/keep.md")); const ran = await a.call("run");
    expect(ran.json.result.planned.deletions).toBe(1);
    const got = await b.call("run");
    expect([got.json.status, b.has("Notes/keep.md")]).toEqual(["ok", false]);
    const status = (await b.call("status")).json.result;
    expect(readdirSync(join(status.stateDir, "trash")).length).toBeGreaterThan(0);
  });

  it("concurrent edits stop at exit 4 with both versions intact, list under `conflicts`, and resolve either way", async () => {
    const { a, b } = await pair();
    a.write("base.md", "from A"); expect((await a.call("run")).code).toBe(0);
    b.write("base.md", "from B");
    const clash = await b.call("run");
    expect([clash.json.status, clash.code]).toEqual(["conflicts", 4]);
    expect(clash.json.result.after.conflicts.map((c: any) => c.path)).toEqual(["base.md"]);
    expect(b.read("base.md")).toBe("from B"); // never overwritten

    expect((await b.call("preview")).code).toBe(4);
    expect((await b.call("status")).code).toBe(4);
    const listed = await b.call("conflicts");
    expect([listed.json.status, listed.code, listed.json.result.count]).toEqual(["conflicts", 4, 1]);
    expect(listed.json.result.conflicts[0].heads.map((h: any) => h.device).sort()).toEqual(["other", "this"]);
    expect((await a.call("conflicts")).code).toBe(0);

    expect((await b.call("resolve", "nope.md", "--keep", "local")).json.status).toBe("no-such-conflict");
    expect((await b.call("resolve", "base.md", "--version", "not-a-record")).json.status).toBe("invalid-version");

    const resolved = await b.call("resolve", "base.md", "--keep", "remote");
    expect([resolved.json.status, resolved.code]).toEqual(["ok", 0]);
    expect(b.read("base.md")).toBe("from A");
    expect((await b.call("conflicts")).code).toBe(0);
    await a.call("run"); expect(a.read("base.md")).toBe("from A");
  });

  it("--keep local publishes this device's version", async () => {
    const { a, b } = await pair();
    a.write("base.md", "from A"); await a.call("run");
    b.write("base.md", "from B"); expect((await b.call("run")).code).toBe(4);
    expect((await b.call("resolve", "base.md", "--keep", "local")).code).toBe(0);
    await a.call("run");
    expect(a.read("base.md")).toBe("from B");
    expect((await a.call("conflicts")).code).toBe(0);
  });
});

describe("rail (b): deletion limit", () => {
  async function bigVault(files: number) {
    const hub = hubDir(), a = device("a", hub), b = device("b", hub);
    bulk(a, files); await a.init(true); await a.bootstrap(); await b.init(false); await b.bootstrap();
    return { a, b };
  }

  it("refuses more than max(20, 1%) deletions, leaves the hub and the other device untouched, and an explicit number lifts it", async () => {
    const { a, b } = await bigVault(60);
    for (let i = 0; i < 25; i++) rmSync(join(a.root, `n${String(i).padStart(3, "0")}.md`));
    const refused = await a.call("run");
    expect([refused.json.status, refused.code]).toEqual(["delete-limit-exceeded", 1]);
    expect(refused.json.result).toMatchObject({ deletions: 25, limit: 20, vaultFiles: 35, override: "--override-delete-limit <n>" });
    expect(refused.out).toContain("--override-delete-limit");
    expect((await b.call("run")).json.result.after.upToDate).toBe(true);
    expect(readdirSync(b.root).filter(n => n.endsWith(".md")).length).toBe(60); // B never saw a deletion

    // The override is a number, not "off": 24 is still under the 25 planned.
    const short = await a.call("run", "--override-delete-limit", "24");
    expect(short.json.status).toBe("delete-limit-exceeded");
    expect(short.err).toContain("WARNING: --override-delete-limit 24 is active");

    const forced = await a.call("run", "--override-delete-limit", "25");
    expect([forced.json.status, forced.json.result.planned.deletions, forced.json.result.rails.overridesActive]).toEqual(["ok", 25, ["--override-delete-limit 25"]]);
    expect(forced.err).toContain("WARNING: --override-delete-limit 25 is active");
    // The rail guards the receiving side too: B is asked to delete 25 files because A did.
    expect((await b.call("run")).json.status).toBe("delete-limit-exceeded");
    expect((await b.call("run", "--override-delete-limit", "25")).json.status).toBe("ok");
    expect(readdirSync(b.root).filter(n => n.endsWith(".md")).length).toBe(35);
  });

  it("preview reports the refusal too, and will not record an approval for a plan the run would refuse", async () => {
    const hub = hubDir(), a = device("a", hub);
    // 25 deletions cannot be planned on a fresh device; a remote deletion applied here can. Use two devices.
    const b = device("b", hub);
    bulk(a, 60); await a.init(true); await a.bootstrap(); await b.init(false); await b.bootstrap();
    for (let i = 0; i < 25; i++) rmSync(join(a.root, `n${String(i).padStart(3, "0")}.md`));
    expect((await a.call("run", "--override-delete-limit", "25")).json.status).toBe("ok");
    const p = await b.call("preview");
    expect([p.json.status, p.json.result.deletions]).toEqual(["delete-limit-exceeded", 25]);
    const before = readdirSync(b.root).length;
    expect((await b.call("run")).json.status).toBe("delete-limit-exceeded");
    expect(readdirSync(b.root).length).toBe(before); // remote deletions were NOT applied locally
  });
});

describe("rail (c): scan that finds under half of the known files", () => {
  it("an unmounted (empty) vault is refused before anything is planned; the override is loud and explicit", async () => {
    const hub = hubDir(), a = device("a", hub);
    bulk(a, 10); await a.init(true); await a.bootstrap();
    for (const f of readdirSync(a.root)) rmSync(join(a.root, f)); // the mount point comes back empty
    const refused = await a.call("run");
    expect([refused.json.status, refused.code]).toEqual(["scan-shrunk", 1]);
    expect(refused.json.result).toMatchObject({ found: 0, known: 10, override: "--override-shrunk-scan" });
    expect((await a.call("preview")).json.status).toBe("scan-shrunk");
    // And nothing was published as deleted.
    const b = device("b", hub); await b.init(false); await b.bootstrap();
    expect(readdirSync(b.root).filter(n => n.endsWith(".md")).length).toBe(10);

    const forced = await a.call("run", "--override-shrunk-scan");
    expect(forced.err).toContain("WARNING: --override-shrunk-scan is active");
    expect(forced.json.status).toBe("ok");
    expect(forced.json.result.planned.deletions).toBe(10);
  });

  it("exactly half is fine (the rule is strictly under 50%)", async () => {
    const hub = hubDir(), a = device("a", hub);
    bulk(a, 10); await a.init(true); await a.bootstrap();
    for (let i = 0; i < 5; i++) rmSync(join(a.root, `n00${i}.md`));
    const ran = await a.call("run");
    expect([ran.json.status, ran.json.result.rails.scan]).toEqual(["ok", { known: 10, found: 5 }]);
  });

  it("blocked placeholders count as seen, so a vault of unsettled placeholders is not mistaken for an unmounted one", async () => {
    const hub = hubDir(), a = device("a", hub);
    bulk(a, 4); await a.init(true); await a.bootstrap();
    for (let i = 0; i < 4; i++) { rmSync(join(a.root, `n00${i}.md`)); put(a.root, `.n00${i}.md.icloud`, "stub"); }
    const ran = await a.call("run");
    expect(ran.json.status).toBe("ok");
    expect(ran.json.result.after.blocked.map((b: any) => b.path).sort()).toEqual(["n000.md", "n001.md", "n002.md", "n003.md"]);
    expect(ran.json.result.planned.deletions).toBe(0);
  });
});

describe("rail (d): iCloud placeholders", () => {
  it("are blocked, never deleted locally or remotely, and never downloaded unless --hydrate-icloud", async () => {
    const hub = hubDir(), a = device("a", hub), b = device("b", hub);
    a.write("Plan.md", "plan"); a.write("other.md", "o");
    await a.init(true); await a.bootstrap(); await b.init(false); await b.bootstrap();
    // On B, Plan.md is evicted: only the placeholder remains. On A, the real file is deleted and that is published.
    rmSync(join(b.root, "Plan.md")); put(b.root, ".Plan.md.icloud", "stub");
    rmSync(join(a.root, "Plan.md")); await a.call("run");

    const ctx = (flags: object) => ({ root: b.root, env: b.env, settleMs: 0, ...flags });
    const calls: string[][] = [];
    const runner = async (_c: string, args: string[]) => { calls.push(args); return { code: 1, stderr: "stub" }; };
    const result = await syncRun(ctx({ hostOptions: { hydrate: { runner, timeoutMs: 1 } } }));
    expect(calls, "no download without opt-in").toEqual([]);
    expect(result.after.blocked).toEqual([{ namespace: "content", path: "Plan.md", reason: "icloud-not-downloaded" }]);
    expect(existsSync(join(b.root, ".Plan.md.icloud"))).toBe(true);
    const state = (await b.call("status")).json.result;
    expect(state.blocked.map((x: any) => x.path)).toEqual(["Plan.md"]);

    await syncRun(ctx({ hostOptions: { hydrate: { runner, timeoutMs: 1 } } }), { overrides: { hydrateIcloud: true } });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c[0] === "download" && c[1].endsWith(".Plan.md.icloud")), "opt-in asks brctl for exactly the placeholder").toBe(true);
    expect(existsSync(join(b.root, ".Plan.md.icloud")), "a failed hydrate leaves the placeholder alone").toBe(true);
  });

  it("--hydrate-icloud prints a loud warning", async () => {
    const hub = hubDir(), a = device("a", hub);
    a.write("x.md", "x"); await a.init(true); await a.call("preview", "--approve");
    const r = await a.call("run", "--hydrate-icloud");
    expect(r.err).toContain("WARNING: --hydrate-icloud is active");
  });
});

describe("the lock (exit 5)", () => {
  it("a second run while one holds the lock exits 5 and does nothing; status still answers", async () => {
    const hub = hubDir(), a = device("a", hub);
    a.write("x.md", "x"); await a.init(true); await a.bootstrap();
    a.write("y.md", "y");
    const stateDir = (await a.call("status")).json.result.stateDir as string;
    const holder = await NodeHost.open({ root: a.root, stateDir, settleMs: 0, detectEvicted: false });
    await holder.run(async () => {
      const blocked = await a.call("run");
      expect([blocked.json.status, blocked.code]).toEqual(["locked", 5]);
      expect((await a.call("preview")).code).toBe(5);
      expect((await a.call("resolve", "x.md", "--keep", "local")).code).toBe(5);
      expect((await a.call("gc")).code).toBe(5);
      const status = await a.call("status");
      expect(status.code).toBe(0);
      expect(status.json.result.running).toMatchObject({ pid: process.pid });
    });
    expect(readdirSync(join(hub, "records")).length).toBeGreaterThan(0);
    const after = await a.call("run");
    expect([after.json.status, after.json.result.planned.uploads]).toEqual(["ok", 1]);
    expect((await a.call("status")).json.result.running).toBeNull();
  });
});

describe("gc and status", () => {
  it("gc runs under the lock and purges only trash older than --trash-days", async () => {
    const hub = hubDir(), a = device("a", hub), b = device("b", hub);
    a.write("x.md", "x"); a.write("y.md", "y"); a.write("z.md", "z"); await a.init(true); await a.bootstrap(); await b.init(false); await b.bootstrap();
    rmSync(join(a.root, "x.md")); expect((await a.call("run")).json.status).toBe("ok"); await b.call("run");
    const stateDir = (await b.call("status")).json.result.stateDir as string;
    const trash = join(stateDir, "trash");
    expect(readdirSync(trash).length).toBe(1);
    const keep = await b.call("gc", "--trash-days", "7");
    expect([keep.json.status, keep.json.result.trashRemoved]).toEqual(["ok", []]);
    const all = await b.call("gc", "--trash-days", "0");
    await new Promise(r => setTimeout(r, 5));
    const purge = await b.call("gc", "--trash-days", "0");
    expect(readdirSync(trash)).toEqual([]);
    expect(all.json.status).toBe("ok"); expect(purge.json.status).toBe("ok");
    expect((await b.call("gc")).json.result.trashDays).toBeNull();
  });

  it("status reports the binding without touching the store", async () => {
    const hub = hubDir(), a = device("a", hub);
    a.write("x.md", "x"); await a.init(true);
    rmrf(hub); // the store is gone; status must still answer
    const s = await a.call("status");
    expect([s.code, s.json.result.initialised, s.json.result.ran, s.json.result.approved]).toEqual([0, true, false, false]);
    const human = await cli(["sync", "status", "--root", a.root], a.env);
    expect(human.out).toContain("approved    false");
  });

  it("an unreachable store is store-unavailable or store-failed (exit 3), not a crash", async () => {
    const hub = hubDir(), a = device("a", hub);
    a.write("x.md", "x"); await a.init(true); await a.call("preview", "--approve");
    rmrf(hub); mkdirSync(hub); writeFileSync(join(hub, "descriptor.json"), "{"); // garbage hub
    const r = await a.call("run");
    expect(r.code).toBe(3);
    expect(["store-unavailable", "store-failed"]).toContain(r.json.status);
  });
});
