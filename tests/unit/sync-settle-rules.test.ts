import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import { buildHistoryPorts, type SyncHostLite } from "../../src/sync-core/ports";
import { DEFAULT_SETTLE_RULES, isUnsettled, mergeSettleRules, parseSettleRule, settleMsFor } from "../../src/sync-core/settle";
import { DEFAULT_SYNC_SCOPE } from "../../src/sync-core/scope";

const MIN = 60_000;

describe("settle rules", () => {
  it("defaults defer session logs for 10 minutes and leave other files alone", () => {
    expect(settleMsFor("Claude/logs/abc.jsonl", DEFAULT_SETTLE_RULES)).toBe(10 * MIN);
    expect(settleMsFor("Elsewhere/export.JSONL", DEFAULT_SETTLE_RULES)).toBe(10 * MIN);
    expect(settleMsFor("Claude/logs/notes.md", DEFAULT_SETTLE_RULES)).toBe(10 * MIN);
    expect(settleMsFor("Claude/other.md", DEFAULT_SETTLE_RULES)).toBe(0);
    expect(settleMsFor("Claude/logs-archive/a.md", DEFAULT_SETTLE_RULES)).toBe(0);
    expect(settleMsFor("note.md", DEFAULT_SETTLE_RULES)).toBe(0);
  });

  it("the most specific rule wins and ms 0 opts a path out", () => {
    const rules = mergeSettleRules([{ match: "Claude/logs/keep", ms: 0 }, { match: "Big", ms: 5 * MIN }]);
    expect(settleMsFor("Claude/logs/keep/a.jsonl", rules)).toBe(0);
    expect(settleMsFor("Claude/logs/x.jsonl", rules)).toBe(10 * MIN);
    expect(settleMsFor("Big/a.md", rules)).toBe(5 * MIN);
    // a user rule with the same match replaces the default instead of stacking
    expect(mergeSettleRules([{ match: "Claude/logs/", ms: 1000 }]).filter(r => r.match.startsWith("Claude/logs"))).toEqual([{ match: "Claude/logs/", ms: 1000 }]);
  });

  it("parses --settle-rule values", () => {
    expect(parseSettleRule("Claude/logs=60000")).toEqual({ match: "Claude/logs", ms: 60000 });
    expect(parseSettleRule("/Claude/logs/=0")).toEqual({ match: "Claude/logs", ms: 0 });
    expect(parseSettleRule("*.jsonl=1")).toEqual({ match: "*.jsonl", ms: 1 });
    for (const bad of ["nope", "=5", "a=", "a=-1", "a=1.5", "a=x"]) expect(typeof parseSettleRule(bad)).toBe("string");
  });

  it("a future mtime never settles and the window is exclusive", () => {
    expect(isUnsettled("a.jsonl", 2_000_000, 1_000_000, DEFAULT_SETTLE_RULES)).toBe(true);
    expect(isUnsettled("a.jsonl", 0, 10 * MIN - 1, DEFAULT_SETTLE_RULES)).toBe(true);
    expect(isUnsettled("a.jsonl", 0, 10 * MIN, DEFAULT_SETTLE_RULES)).toBe(false);
  });
});

describe("snapshot defers files inside their settle window", () => {
  const noPortable = { ...DEFAULT_SYNC_SCOPE, mainSettings: false, appearance: false, hotkeys: false, corePlugins: false, themesAndSnippets: false };
  const buf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

  function harness(files: Record<string, { mtime: number; text: string }>, clock: { now: number }) {
    const reads: string[] = [];
    const host: SyncHostLite = {
      vault: {
        reconcileScan: async () => ({ status: "complete", entries: Object.entries(files).map(([path, f]) => ({ path, isFolder: false, mtime: f.mtime, size: f.text.length })) }),
        readBinary: async path => (reads.push(path), buf(files[path].text)),
      },
      deviceState: { read: async () => null, write: async () => {} },
      safety: { storage: async () => ({}), apply: async () => ({ status: "applied", hash: null, recoveryPath: "r" }) },
      portableConfig: { project: async () => [] },
    };
    const ports = (settleRules?: Parameters<typeof buildHistoryPorts>[1]["settleRules"]) => buildHistoryPorts(host, {
      provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "b", stateKey: "s", lease: "l",
      assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {}, now: () => clock.now, ...(settleRules ? { settleRules } : {}),
    }).ports;
    return { ports, reads };
  }

  it("defers a log modified inside the window without reading it, syncs it once after, and never defers notes", async () => {
    const clock = { now: 1_000_000_000 };
    const files = { "Claude/logs/s.jsonl": { mtime: clock.now - 30_000, text: "line1\n" }, "note.md": { mtime: clock.now - 30_000, text: "hello" } };
    const { ports, reads } = harness(files, clock);

    const first = await ports().snapshot();
    expect(first.entries.map(e => e.path)).toEqual(["note.md"]);
    expect(first.blocked).toEqual([{ namespace: "content", path: "Claude/logs/s.jsonl", reason: "unsettled" }]);
    expect(reads).toEqual(["note.md"]); // the deferred log is not even read or hashed

    // The session keeps appending every 20 s for 9 minutes: every snapshot still defers it.
    for (let t = 0; t < 27; t++) {
      clock.now += 20_000; files["Claude/logs/s.jsonl"].mtime = clock.now; files["Claude/logs/s.jsonl"].text += `line${t}\n`;
      const snap = await ports().snapshot();
      expect(snap.entries.some(e => e.path === "Claude/logs/s.jsonl")).toBe(false);
      expect(snap.blocked.map(b => b.path)).toContain("Claude/logs/s.jsonl");
    }
    expect(reads.filter(p => p.endsWith(".jsonl"))).toEqual([]);

    // Quiet for the full window: it is published, and as exactly one version of the final content.
    clock.now += 10 * MIN;
    const settled = await ports().snapshot();
    expect(settled.blocked).toEqual([]);
    const log = settled.entries.find(e => e.path === "Claude/logs/s.jsonl");
    expect(log).toMatchObject({ kind: "file", size: files["Claude/logs/s.jsonl"].text.length });
    expect(reads.filter(p => p.endsWith(".jsonl"))).toEqual(["Claude/logs/s.jsonl"]);
  });

  it("a rule of 0 or an explicit empty list restores immediate sync", async () => {
    const clock = { now: 5_000_000 };
    const files = { "Claude/logs/s.jsonl": { mtime: clock.now - 1000, text: "x" } };
    const { ports } = harness(files, clock);
    expect((await ports([]).snapshot()).entries.map(e => e.path)).toEqual(["Claude/logs/s.jsonl"]);
    expect((await ports(mergeSettleRules([{ match: "Claude/logs", ms: 0 }, { match: "*.jsonl", ms: 0 }])).snapshot()).entries.map(e => e.path)).toEqual(["Claude/logs/s.jsonl"]);
  });
});

describe("geode-wiki sync end to end", () => {
  const roots: string[] = [];
  const dir = (name: string) => { const d = mkdtempSync(join(tmpdir(), `settle-${name}-`)); roots.push(d); return d; };
  afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

  it("a growing log is stored once after the quiet period, not once per run", async () => {
    const store = dir("store"), root = dir("root"), home = dir("home");
    mkdirSync(join(root, "Claude/logs"), { recursive: true });
    const log = join(root, "Claude/logs/s.jsonl"), note = join(root, "note.md");
    writeFileSync(note, "hello"); writeFileSync(log, "line0\n");
    const out: string[] = [];
    const cli = async (sub: string, ...rest: string[]) => { out.length = 0; const code = await run(["sync", sub, "--root", root, "--settle-ms", "0", "--json", ...rest], { streams: { out: s => { out.push(s); }, err: () => {} }, env: { GEODE_SYNC_HOME: home }, stdin: Readable.from([]) }); return code; };
    const blobs = () => readdirSync(join(store, "blobs")).length;

    expect(await cli("init", "--store", store, "--create")).toBe(0);
    expect(await cli("preview")).toBe(0); expect(await cli("preview", "--approve")).toBe(0);
    expect(await cli("run")).toBe(0);
    expect(out.join("")).toContain("Claude/logs/s.jsonl"); expect(out.join("")).toContain("unsettled");
    expect(blobs()).toBe(1); // note.md only

    // 20 runs while the log keeps growing: still nothing stored for it.
    for (let i = 0; i < 20; i++) { appendFileSync(log, `line${i + 1}\n`); expect(await cli("run")).toBe(0); }
    expect(blobs()).toBe(1);

    // Quiet for > 10 min: one run stores exactly one blob for the log, and a repeat run stores nothing more.
    const old = new Date(Date.now() - 11 * MIN); utimesSync(log, old, old);
    expect(await cli("run")).toBe(0); expect(blobs()).toBe(2);
    expect(await cli("run")).toBe(0); expect(blobs()).toBe(2);

    // An opt-out rule restores per-run sync for that path.
    appendFileSync(log, "more\n");
    expect(await cli("run", "--settle-rule", "Claude/logs=0", "--settle-rule", "*.jsonl=0")).toBe(0); expect(blobs()).toBe(3);
  }, 60_000);

  it("rejects a malformed --settle-rule as a usage error", async () => {
    const err: string[] = [];
    const code = await run(["sync", "status", "--root", dir("r"), "--settle-rule", "bogus", "--json"], { streams: { out: () => {}, err: s => { err.push(s); } }, env: { GEODE_SYNC_HOME: dir("h") }, stdin: Readable.from([]) });
    expect(code).not.toBe(0);
  });
});
