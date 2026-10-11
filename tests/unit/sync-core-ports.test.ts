import { expect, it } from "vitest";
import { buildHistoryPorts, type SyncHostLite } from "../../src/sync-core/ports";
import { DEFAULT_SYNC_SCOPE } from "../../src/sync-core/scope";
import { SyncService } from "../../src/renderer/sync/sync-service";

const OLD = Date.now() - 60_000;
const FILES = [
  { path: "note.md", isFolder: false, mtime: OLD, ctime: OLD, size: 5 },
  { path: "ignored.md", isFolder: false, mtime: OLD, ctime: OLD, size: 3 },
  { path: "dir", isFolder: true, mtime: OLD, ctime: OLD, size: 0 },
  { path: ".hidden/x.md", isFolder: false, mtime: OLD, ctime: OLD, size: 1 },
];
const BYTES: Record<string, string> = { "note.md": "hello", "ignored.md": "abc", ".hidden/x.md": "x" };
const buf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const noPortable = { ...DEFAULT_SYNC_SCOPE, mainSettings: false, appearance: false, hotkeys: false, corePlugins: false, themesAndSnippets: false };

/** One recorder shared by both hosts, so call traces can be compared verbatim. */
function recorder() {
  const log: unknown[] = []; const state = new Map<string, unknown>();
  const cache: Record<string, any> = {};
  return {
    log, state, cache,
    vaultFiles: { reconcileScan: async () => (log.push("scan"), { status: "complete" as const, entries: FILES }), readBinary: async (path: string) => (log.push(["read", path]), buf(BYTES[path] ?? "")) },
    hashCache: { readAll: async () => (log.push("cache.readAll"), { ...cache }), upsertBatch: async (entries: Record<string, any>) => { log.push(["cache.upsert", entries]); Object.assign(cache, entries); }, prune: async (keep: string[]) => { log.push(["cache.prune", keep]); } },
    deviceState: { read: async (key: string) => (log.push(["state.read", key]), state.get(key) ?? null), write: async (key: string, value: unknown) => { log.push(["state.write", key, value]); state.set(key, value); } },
    storage: async (token: string, binding: string, request: unknown) => (log.push(["storage", token, binding, request]), request),
    apply: async (token: string, input: unknown) => (log.push(["apply", token, input]), { status: "applied" as const, hash: null, recoveryPath: "r" }),
  };
}

const provider = { id: "p", excludePath: async (path: string) => path === "ignored.md" ? "ignored by rule" : null };
const context = (assert: () => void, hints = new Map<string, string>()) => ({ provider, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "bk", stateKey: "sk", lease: "lease", assertContext: assert, renameHints: hints, portableChanged: async () => {} });

async function exercise(host: SyncHostLite, log: unknown[]) {
  let asserts = 0; const { ports, storage } = buildHistoryPorts(host, context(() => { asserts++; }, new Map([["note.md", "old-note.md"]])));
  const snap = await ports.snapshot(); const again = await ports.snapshot();
  await ports.save({ marker: 1 } as never); const loaded = await ports.load();
  await ports.stage("op", buf("s")); await ports.readStage("op"); await ports.release!("op"); await storage({ action: "gc", retain: [] });
  await ports.apply({ namespace: "content", operationId: "op", path: "note.md", expectedHash: null, deleted: false, kind: "file", data: buf("n") } as never);
  return { snap, again, loaded, included: [ports.isIncluded("content", "note.md"), ports.isIncluded("content", ".hidden/x.md"), ports.isIncluded("portable-config", "hotkeys.json")], log, asserts };
}

it("buildHistoryPorts over a fake SyncHostLite matches the SyncService HostServices adapter", async () => {
  const direct = recorder();
  const lite: SyncHostLite = { vault: direct.vaultFiles, hashCache: direct.hashCache, deviceState: direct.deviceState, safety: { storage: direct.storage, apply: direct.apply }, portableConfig: { project: async () => [] } };
  const viaLite = await exercise(lite, direct.log);

  const adapted = recorder();
  const service = new SyncService({ vaultFiles: adapted.vaultFiles, hashCache: adapted.hashCache, deviceState: adapted.deviceState, syncSafety: { storage: adapted.storage, apply: adapted.apply }, config: { read: async () => ({}) } } as never, () => "/synthetic/vault");
  const viaService = await exercise((service as any).liteHost(), adapted.log);

  expect(viaService).toEqual(viaLite);
  // Behavior sanity: the content rule excluded one file, hidden paths never entered, rename hints applied.
  expect(viaLite.snap.entries.map(e => e.path).sort()).toEqual(["dir", "note.md"]);
  expect(viaLite.snap.entries.find(e => e.path === "note.md")).toMatchObject({ renamedFrom: "old-note.md", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(viaLite.snap.excluded).toEqual([{ namespace: "content", path: "ignored.md", reason: "ignored by rule" }]);
  expect(viaLite.loaded).toEqual({ marker: 1 });
  expect(viaLite.included).toEqual([true, false, false]);
  expect(direct.log).toContainEqual(["apply", "lease", expect.objectContaining({ kind: "write", path: "note.md" })]);
  // Second snapshot is served from the (old-enough) hash cache: note.md is read exactly once across both snapshots.
  expect(direct.log.filter(entry => Array.isArray(entry) && entry[0] === "read")).toHaveLength(1);
});

it("SyncService adapter projects portable config lazily with initial-default detection", async () => {
  const reads: string[] = [];
  const service = new SyncService({ config: { read: async (name: string) => (reads.push(name), name === "app" ? { readableLineLength: true } : {}) } } as never, () => "/synthetic/vault");
  const lite: SyncHostLite = (service as any).liteHost();
  const docs = await lite.portableConfig.project({ ...DEFAULT_SYNC_SCOPE, appearance: false, hotkeys: false, corePlugins: false });
  expect(docs.map(d => d.name)).toEqual(["editor.json"]);
  expect(reads).toEqual(["app"]);
  expect(await docs[0].isInitialDefault()).toBe(false);
  expect(new TextDecoder().decode(docs[0].data)).toContain("readableLineLength");
});
