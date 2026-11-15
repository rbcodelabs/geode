import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOG_SETTLE_MS, DEFAULT_SETTLE_MS, mergeSettleRules, settleDelayMs } from "../../src/sync-core/settle";
import {
  HistoryController,
  MAX_COMPLETED_OPERATIONS,
  type HistoryControllerPorts,
  type HistoryControllerState,
  type HistoryLocalResource,
  type HistoryOperation,
} from "../../src/renderer/sync/history-controller";
import { APPEND_ONLY_PROTOCOL, type AppendOnlySession, type HistoryRecord } from "../../src/renderer/sync/history-types";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { DEFAULT_STRUCTURE_SCAN_CAP_BYTES, METADATA_PARSER_VERSION } from "../../src/wiki/constants";
import { createWikiSnapshot } from "../../src/wiki/snapshot";
import {
  METADATA_CACHE_SCHEMA_VERSION,
  MetadataCache,
  extractMentionIndexKeys,
  parseMetadata,
} from "../../src/renderer/metadata-cache";
import {
  openMetadataDb,
  queryMentionCandidates,
  readAllMetadataEntries,
  readHashCacheEntries,
  upsertHashCacheEntries,
  upsertMetadataEntries,
} from "../../src/main/metadata-cache-store";
import { DEFAULT_CONTENT_CACHE_MAX_BYTES, LruContentCache } from "../../src/renderer/vault";
import { Plugin } from "../../src/renderer/plugin";
import { PluginManager } from "../../src/renderer/plugin-manager";
import { FakeVault } from "../helpers/fake-vault";

const tmpRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(tmpRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function makeTmpRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-renderer-mem-"));
  tmpRoots.push(root);
  return root;
}

const encode = (value: string) => new TextEncoder().encode(value).buffer;
const sha256 = (data: ArrayBuffer) => createHash("sha256").update(new Uint8Array(data)).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function makeHistoryHarness(initial: Record<string, string> = {}) {
  const vaultId = randomUUID();
  const deviceId = randomUUID();
  const records = new Map<string, HistoryRecord>();
  const blobs = new Map<string, ArrayBuffer>();
  const session: AppendOnlySession = {
    scan: async () => ({ status: "complete", records: [...records.values()], cursor: String(records.size) }),
    putBlob: async (input) => {
      blobs.set(input.operationId, input.data.slice(0));
      return { id: input.operationId, sha256: input.sha256, size: input.size };
    },
    readBlob: async (ref) => blobs.get(ref.id)!.slice(0),
    appendRecord: async (record) => {
      records.set(record.recordId, clone(record));
    },
    close: async () => {},
  };
  const files = new Map<string, ArrayBuffer>(Object.entries(initial).map(([p, t]) => [p, encode(t)]));
  let state: HistoryControllerState | null = null;
  let saveCalls = 0;
  const operations = new Map<string, HistoryOperation>();
  const staged = new Map<string, ArrayBuffer>();
  const ports: HistoryControllerPorts = {
    load: async () => (state ? clone(state) : null),
    save: async (next) => {
      saveCalls += 1;
      state = clone(next);
    },
    loadOperations: async () => [...operations.values()].map(clone),
    saveOperation: async (op) => {
      operations.set(op.id, clone(op));
    },
    snapshot: async () => {
      const entries: HistoryLocalResource[] = [...files].map(([filePath, data]) => ({
        namespace: "content",
        path: filePath,
        kind: "file",
        sha256: sha256(data),
        size: data.byteLength,
      }));
      return { authoritative: true, scopeKey: "all", entries, excluded: [], blocked: [] };
    },
    read: async (resource) => files.get(resource.path)!.slice(0),
    stage: async (id, data) => {
      staged.set(id, data.slice(0));
      return id;
    },
    readStage: async (key) => staged.get(key)!.slice(0),
    apply: async (input) => {
      if (input.deleted) files.delete(input.path);
      else if (input.kind === "file" && input.data) files.set(input.path, input.data.slice(0));
    },
    isIncluded: () => true,
    assertContext: () => {},
    newId: () => randomUUID(),
  };
  const controller = new HistoryController({
    vaultId,
    deviceId,
    bindingKey: `${deviceId}:${vaultId}`,
    session,
    ports,
  });
  return {
    controller,
    files,
    getState: () => state,
    setState: (next: HistoryControllerState | null) => {
      state = next;
    },
    getSaveCalls: () => saveCalls,
    resetSaveCalls: () => {
      saveCalls = 0;
    },
  };
}

describe("Phase 1: sync settle, history controller idle/cap guards, and SyncService churn fixes", () => {
  it("computes per-path settle delays from default and custom settle rules", () => {
    expect(settleDelayMs("Notes/Idea.md")).toBe(DEFAULT_SETTLE_MS);
    expect(settleDelayMs("Claude/logs/2026-11-15-session.jsonl")).toBe(DEFAULT_LOG_SETTLE_MS);
    expect(settleDelayMs("Claude/logs/notes.md")).toBe(DEFAULT_LOG_SETTLE_MS);
    expect(settleDelayMs("logs/trace.jsonl")).toBe(DEFAULT_LOG_SETTLE_MS);
    const custom = mergeSettleRules([{ match: "Claude", ms: 30_000 }]);
    expect(settleDelayMs("Claude/2026-11-15-session.md", custom)).toBe(30_000);
  });

  it("skips HistoryController.save() on idle no-op runs and caps completedOperations", async () => {
    const h = makeHistoryHarness({ "Note.md": "hello" });
    const sig = new AbortController().signal;
    await h.controller.preview(sig);
    await h.controller.run({ approvePreview: true }, sig);
    expect(h.controller.didLastRunProgress()).toBe(true);
    expect(h.getSaveCalls()).toBeGreaterThan(0);

    // Steady-state idle run with zero remote or local changes must skip execute/replan/save.
    h.resetSaveCalls();
    const idleResult = await h.controller.run({}, sig);
    expect(idleResult.upToDate).toBe(true);
    expect(h.controller.didLastRunProgress()).toBe(false);
    expect(h.getSaveCalls()).toBe(0);

    // Inflate completedOperations past MAX_COMPLETED_OPERATIONS and confirm next mutating save trims it.
    const current = h.getState()!;
    const bloated = Array.from({ length: MAX_COMPLETED_OPERATIONS + 250 }, (_, idx) => `op-${idx}`);
    h.setState({ ...current, completedOperations: bloated });
    h.files.set("Second.md", encode("world"));
    await h.controller.run({}, sig);
    expect(h.controller.didLastRunProgress()).toBe(true);
    expect(h.getState()!.completedOperations.length).toBeLessThanOrEqual(MAX_COMPLETED_OPERATIONS);
    expect(h.getState()!.completedOperations).toContain(`op-${MAX_COMPLETED_OPERATIONS + 249}`);
    expect(h.getState()!.completedOperations).not.toContain("op-0");
  });

  it("defers unsettled watcher writes to settleTimer, deduplicates blocked logs, guards partial scans, and reads deviceState once per cycle", async () => {
    const stored = new Map<string, unknown>();
    const deviceStateRead = vi.fn(async (key: string) => structuredClone(stored.get(key) ?? null));
    const deviceStateWrite = vi.fn(async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value));
    });
    let onVaultChange: ((event: { event: "create" | "modify" | "delete"; path: string; mutationId?: string; renamedFrom?: string }) => void) | undefined;
    const baseEntries = Array.from({ length: 12 }, (_, idx) => ({
      path: `Note-${idx}.md`,
      isFolder: false,
      size: 5,
      mtime: 1_000,
      ctime: 1_000,
    }));
    let scanResult: { status: "complete" | "partial"; entries: Array<{ path: string; isFolder: boolean; size: number; mtime: number; ctime: number }> } = {
      status: "complete",
      entries: [
        ...baseEntries,
        { path: "TooBig.md", isFolder: false, size: 200 * 1024 * 1024, mtime: 1_000, ctime: 1_000 },
      ],
    };
    const descriptor = {
      schema: 1,
      protocol: APPEND_ONLY_PROTOCOL,
      vaultId: "12345678-1234-4234-8234-123456789012",
      rootId: "root",
      descriptorId: "descriptor",
      name: "Shared",
    };
    const records = new Map<string, HistoryRecord>();
    const blobs = new Map<string, ArrayBuffer>();
    const staged = new Map<string, ArrayBuffer>();
    const operations = new Map<string, unknown>();
    const host = {
      config: { read: async () => null, write: async () => {} },
      deviceState: {
        read: deviceStateRead,
        write: deviceStateWrite,
        remove: async (key: string) => {
          stored.delete(key);
        },
      },
      vaultFiles: {
        onChange: (cb: typeof onVaultChange) => {
          onVaultChange = cb;
          return () => {};
        },
        reconcileScan: async () => scanResult,
        readBinary: async () => encode("hello"),
      },
      hashCache: {
        readAll: async () => ({}),
        upsertBatch: async () => {},
        prune: async () => {},
      },
      syncSafety: {
        claimOwner: async () => "lease",
        releaseOwner: async () => {},
        storage: async (_token: string, _binding: string, request: any) => {
          if (request.action === "load-operations") return [...operations.values()];
          if (request.action === "save-operation") {
            operations.set(request.key, clone(request.value));
            return undefined;
          }
          if (request.action === "stage") {
            staged.set(request.key, request.data.slice(0));
            return request.key;
          }
          if (request.action === "read-stage") return staged.get(request.key)!.slice(0);
          return undefined;
        },
        apply: async () => {},
      },
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const service = new SyncService(host as never, () => "/synthetic/vault");
    service.register("owner", {
      id: "history",
      name: "History",
      protocol: APPEND_ONLY_PROTOCOL,
      safetyRails: true,
      capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
      discover: async () => [descriptor],
      createVault: async () => descriptor,
      open: async () => ({
        scan: async () => ({ status: "complete", records: [...records.values()], cursor: String(records.size) }),
        putBlob: async (input: { operationId: string; data: ArrayBuffer; sha256: string; size: number }) => {
          blobs.set(input.operationId, input.data.slice(0));
          return { id: input.operationId, sha256: input.sha256, size: input.size };
        },
        readBlob: async (ref: { id: string }) => blobs.get(ref.id)!.slice(0),
        appendRecord: async (record: HistoryRecord) => {
          records.set(record.recordId, clone(record));
        },
        close: async () => {},
      }),
    } as never);

    try {
      await service.activate("history");
      await service.createVault("Shared");
      await service.updateScope({
        other: false,
        mainSettings: false,
        appearance: false,
        themesAndSnippets: false,
        hotkeys: false,
        corePlugins: false,
      });

      await service.preview();
      const blockedLogsAfterFirst = logSpy.mock.calls.filter(([msg]) => String(msg).startsWith("[sync] blocked:"));
      expect(blockedLogsAfterFirst).toHaveLength(1);

      await service.run({ approvePreview: true });

      deviceStateRead.mockClear();
      await service.preview();
      const stateReadsInSecondPreview = deviceStateRead.mock.calls.filter(([k]) => k.startsWith("sync-history/"));
      expect(stateReadsInSecondPreview).toHaveLength(1);
      // Identical blocked list must not spam console.log a second time.
      const blockedLogsAfterSecond = logSpy.mock.calls.filter(([msg]) => String(msg).startsWith("[sync] blocked:"));
      expect(blockedLogsAfterSecond).toHaveLength(1);

      // Partial (non-authoritative) shrunk scan must surface "Authoritative local snapshot unavailable"
      // rather than poisoning railRefusal with a false shrunk-scan safety rail error.
      const completeScan = scanResult;
      scanResult = { status: "partial", entries: [] };
      await expect(service.preview()).rejects.toThrow("Authoritative local snapshot unavailable");
      expect(service.getRailRefusal()).toBeUndefined();
      scanResult = completeScan;
      await service.run();

      // Watcher event for long-settle path (Claude/logs/*.jsonl) must arm settleTimer, not fast debounce.
      clearTimeout((service as any).debounce);
      (service as any).debounce = undefined;
      clearTimeout((service as any).settleTimer);
      (service as any).settleTimer = undefined;
      onVaultChange?.({ event: "modify", path: "Claude/logs/live.jsonl" });
      expect((service as any).debounce).toBeUndefined();
      expect((service as any).settleTimer).toBeDefined();

      // Normal note modify still arms the fast debounce timer.
      onVaultChange?.({ event: "modify", path: "Note-0.md" });
      expect((service as any).debounce).toBeDefined();
    } finally {
      logSpy.mockRestore();
      await service.cancel();
    }
  });
});

describe("Phase 2: structure cap, SQLite mention queries, bounded content cache, and plugin retention", () => {
  it("omits sections and listItems above 64 KiB while preserving links, headings, blocks, and wiki #^block subpaths", () => {
    const small = [
      "---",
      "aliases: [SmallAlias]",
      "---",
      "# Intro",
      "- item one ^item1",
      "Paragraph [[Target]] #tag ^para1",
    ].join("\n");
    const smallMeta = parseMetadata(small);
    expect(smallMeta.sections).toBeDefined();
    expect(smallMeta.listItems).toBeDefined();
    expect(smallMeta.blocks?.item1).toBeDefined();
    expect(smallMeta.blocks?.para1).toBeDefined();

    const padding = "Transcript line without structural tokens but realistic prose words.\n".repeat(1_100);
    expect(padding.length).toBeGreaterThan(DEFAULT_STRUCTURE_SCAN_CAP_BYTES);
    const large = [
      "---",
      "aliases: [LargeAlias]",
      "---",
      "# Session Heading ^head1",
      padding,
      "- action item ^listblock",
      "Closing summary linking [[Architecture]] with #perf ^endblock",
    ].join("\n");
    const largeMeta = parseMetadata(large);
    expect(largeMeta.sections).toBeUndefined();
    expect(largeMeta.listItems).toBeUndefined();
    expect(largeMeta.aliases).toEqual(["LargeAlias"]);
    expect(largeMeta.headings[0].heading).toContain("Session Heading");
    expect(largeMeta.links.map((l) => l.link)).toEqual(["Architecture"]);
    expect(largeMeta.tags.map((t) => t.tag)).toEqual(["perf"]);
    expect(largeMeta.blocks?.head1).toBeDefined();
    expect(largeMeta.blocks?.listblock).toBeDefined();
    expect(largeMeta.blocks?.endblock).toBeDefined();

    // Wiki snapshot #^block-id subpath resolution works on >64 KiB notes via metadata.blocks.
    const snapshot = createWikiSnapshot([
      { path: "Claude/Session.md", kind: "note", text: large },
      { path: "Index.md", kind: "note", text: "See [[Claude/Session#^endblock]] and [[Claude/Session#^listblock]]" },
    ]);
    expect(snapshot.resolve("Index.md", "Claude/Session#^endblock")).toMatchObject({
      status: "resolved",
      path: "Claude/Session.md",
      subpath: { status: "found" },
    });
    expect(snapshot.resolve("Index.md", "Claude/Session#^listblock")).toMatchObject({
      status: "resolved",
      path: "Claude/Session.md",
      subpath: { status: "found" },
    });
    expect(snapshot.resolve("Index.md", "Claude/Session#^missingblock")).toMatchObject({
      status: "resolved",
      path: "Claude/Session.md",
      subpath: { status: "missing" },
    });
  });

  it("invalidates stale parser_version rows while keeping hash_cache_entries, preserves mention_keys_json on metadata-only upsert, and queries mentions accurately", async () => {
    const root = await makeTmpRoot();
    let db = openMetadataDb(root);
    const dummyMeta = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };
    upsertMetadataEntries(db, {
      "Alpha.md": { mtimeMs: 1, size: 10, metadata: dummyMeta, mentionKeys: ["w:project", "w:atlas", 'w:50%_off\\deal"x'] },
      "Beta.md": { mtimeMs: 1, size: 10, metadata: dummyMeta, mentionKeys: ["w:project"] },
    });
    upsertHashCacheEntries(db, {
      "Alpha.md": { mtimeMs: 1, size: 10, sha256: "keep-me", excludeReason: null, providerId: "history" },
    });

    // Omit mentionKeys on read when includeMentionKeys: false.
    const withoutMentions = readAllMetadataEntries(db, { includeMentionKeys: false });
    expect(withoutMentions.entries["Alpha.md"].mentionKeys).toBeUndefined();
    expect(readAllMetadataEntries(db).entries["Alpha.md"].mentionKeys).toEqual(["w:project", "w:atlas", 'w:50%_off\\deal"x']);

    // Upserting without mentionKeys preserves existing mention_keys_json via COALESCE.
    upsertMetadataEntries(db, {
      "Alpha.md": { mtimeMs: 2, size: 12, metadata: dummyMeta },
    });
    expect(readAllMetadataEntries(db).entries["Alpha.md"].mentionKeys).toEqual(["w:project", "w:atlas", 'w:50%_off\\deal"x']);

    // SQLite LIKE mention candidate queries handle multi-key AND + special characters safely.
    expect(queryMentionCandidates(db, ["w:project"]).sort()).toEqual(["Alpha.md", "Beta.md"]);
    expect(queryMentionCandidates(db, ["w:project", "w:atlas"])).toEqual(["Alpha.md"]);
    expect(queryMentionCandidates(db, ['w:50%_off\\deal"x'])).toEqual(["Alpha.md"]);
    expect(queryMentionCandidates(db, ['w:50a_off\\deal"x'])).toEqual([]);

    // Simulate older parser_version stamp and reopen: metadata_entries clears, hash_cache_entries stays.
    db.exec("UPDATE metadata_meta SET value = '3' WHERE key = 'parser_version'");
    db.close();

    db = openMetadataDb(root);
    try {
      expect(readAllMetadataEntries(db).entries).toEqual({});
      expect(readHashCacheEntries(db)["Alpha.md"]?.sha256).toBe("keep-me");
      const row = db.prepare("SELECT value FROM metadata_meta WHERE key = 'parser_version'").get() as { value: string };
      expect(row.value).toBe(String(METADATA_PARSER_VERSION));
    } finally {
      db.close();
    }
  });

  it("queries unlinked mentions on demand with 0 renderer mention maps, tracks live overrides, and releases backgroundSnapshot entries", async () => {
    const fake = new FakeVault({
      "Target Note.md": "# Target Note",
      "Mentioner.md": "We discussed Target Note yesterday.",
      "Other.md": "Unrelated content.",
    });
    const target = fake.getFileByPath("Target Note.md")!;
    const mentioner = fake.getFileByPath("Mentioner.md")!;
    const other = fake.getFileByPath("Other.md")!;

    const sqliteRows = new Map<string, string[]>([
      ["Target Note.md", extractMentionIndexKeys("# Target Note")],
      ["Mentioner.md", extractMentionIndexKeys("We discussed Target Note yesterday.")],
      ["Other.md", extractMentionIndexKeys("Unrelated content.")],
    ]);
    const queryMetadataMentionCandidates = vi.fn(async (keys: string[]) => {
      const matches: string[] = [];
      for (const [p, storedKeys] of sqliteRows) {
        if (keys.every((k) => storedKeys.includes(k))) matches.push(p);
      }
      return matches;
    });

    let deliver: (msg: unknown) => void = () => {};
    const stored = {
      schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
      parserVersion: METADATA_PARSER_VERSION,
      entries: {
        "Target Note.md": { mtimeMs: target.mtime, size: target.size, metadata: parseMetadata("# Target Note") },
        "Mentioner.md": { mtimeMs: mentioner.mtime, size: mentioner.size, metadata: parseMetadata("We discussed Target Note yesterday.") },
        "Other.md": { mtimeMs: other.mtime, size: other.size, metadata: parseMetadata("Unrelated content.") },
      },
    };
    vi.stubGlobal("window", {
      geode: {
        readMetadataCache: vi.fn(async () => stored),
        writeMetadataCache: vi.fn(async () => {}),
        queryMetadataMentionCandidates,
        startMetadataIndexer: vi.fn(async () => true),
        onMetadataIndexerMessage: vi.fn((cb: (msg: unknown) => void) => {
          deliver = cb;
          return () => {};
        }),
      },
    });

    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect((cache as any).mentionSourcesByKey.size).toBe(0);
    expect((cache as any).mentionKeysBySource.size).toBe(0);
    expect(cache.isUnlinkedMentionsReady()).toBe(true);

    const initialMentions = await cache.getUnlinkedMentions(target);
    expect(queryMetadataMentionCandidates).toHaveBeenCalled();
    expect(initialMentions.map((m) => m.source.path)).toEqual(["Mentioner.md"]);

    // Live edit on Other.md before SQLite flushes should surface via localMentionOverrides.
    const editedText = "Now Other also mentions Target Note inline.";
    fake.setFile("Other.md", editedText, { mtime: other.mtime + 10 });
    fake.trigger("modify", fake.getFileByPath("Other.md")!);
    deliver({
      type: "delta",
      path: "Other.md",
      entry: {
        mtimeMs: other.mtime + 10,
        size: editedText.length,
        metadata: parseMetadata(editedText),
        mentionKeys: extractMentionIndexKeys(editedText),
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    const afterEdit = await cache.getUnlinkedMentions(target);
    expect(afterEdit.map((m) => m.source.path).sort()).toEqual(["Mentioner.md", "Other.md"]);
    expect((cache as any).mentionSourcesByKey.size).toBe(0);
    expect((cache as any).mentionKeysBySource.size).toBe(0);

    // Live delete of Mentioner.md before SQLite flushes removes it via localMentionOverrides (null).
    const mentionerBeforeDelete = fake.getFileByPath("Mentioner.md")!;
    fake.removeFile("Mentioner.md");
    fake.trigger("delete", mentionerBeforeDelete);
    deliver({ type: "delta", path: "Mentioner.md", deleted: true });
    await new Promise((r) => setTimeout(r, 10));
    const afterDelete = await cache.getUnlinkedMentions(target);
    expect(afterDelete.map((m) => m.source.path)).toEqual(["Other.md"]);

    // Background snapshot merges cleanly and releases snapshot.entries while staying truthy.
    deliver({ type: "snapshot-start", schemaVersion: METADATA_CACHE_SCHEMA_VERSION, totalEntries: 1 });
    deliver({
      type: "snapshot-chunk",
      sequence: 0,
      entries: {
        "Target Note.md": { mtimeMs: target.mtime, size: target.size, metadata: stored.entries["Target Note.md"].metadata },
      },
    });
    deliver({ type: "snapshot-complete", totalChunks: 1 });
    await cache.waitForBackgroundIdle();
    expect((cache as any).backgroundSnapshot).toEqual({
      schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
      entries: {},
    });

    cache.dispose();
  });

  it("enforces UTF-16 byte cap on LruContentCache", () => {
    expect(DEFAULT_CONTENT_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
    const lru = new LruContentCache(100, 200); // 200 bytes = 100 UTF-16 code units
    lru.set("a.md", "x".repeat(40)); // 80 bytes
    lru.set("b.md", "y".repeat(40)); // 80 bytes (total 160)
    expect(lru.get("a.md")).toBeDefined(); // touch a.md so b.md becomes oldest
    lru.set("c.md", "z".repeat(40)); // +80 => evicts b.md
    expect(lru.get("b.md")).toBeUndefined();
    expect(lru.get("a.md")).toBeDefined();
    expect(lru.get("c.md")).toBeDefined();

    // Oversized single entry (> maxBytes) is not retained in cache.
    lru.set("giant.md", "g".repeat(150)); // 300 bytes > 200 maxBytes
    expect(lru.get("giant.md")).toBeUndefined();
    expect(lru.byteLength).toBe(160);
  });

  it("deduplicates Plugin.saveData via digest without retaining raw JSON strings and drops desktop source code in PluginManager", async () => {
    const fsFiles = new Map<string, string>();
    const fsConfig = new Map<string, unknown>();
    fsFiles.set(
      ".geode/plugins/demo/manifest.json",
      JSON.stringify({
        id: "demo",
        name: "Plugin demo",
        version: "1.0.0",
        minAppVersion: "0.1.0",
        description: "Demo plugin",
        author: "Test",
      }),
    );
    fsFiles.set(
      ".geode/plugins/demo/main.js",
      `
        const { Plugin } = require('geode');
        class DemoPlugin extends Plugin { onload() {} }
        module.exports.default = DemoPlugin;
      `,
    );

    const write = vi.fn(async (filePath: string, data: string) => {
      fsFiles.set(filePath, data);
      return { mtime: 0, size: data.length };
    });
    vi.stubGlobal("window", {
      geode: {
        listPluginIds: vi.fn(async () => ["demo"]),
        read: vi.fn(async (filePath: string) => {
          const content = fsFiles.get(filePath);
          if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
          return content;
        }),
        write,
        readConfig: vi.fn(async (name: string) => fsConfig.get(name) ?? null),
        writeConfig: vi.fn(async (name: string, data: unknown) => {
          fsConfig.set(name, data);
        }),
        getPluginPolicy: vi.fn(async () => null),
        getCrashRecoveryState: vi.fn(async () => ({ suppressPlugins: false, entries: [] })),
        reportCrashDiagnostic: vi.fn(async () => {}),
      },
    });

    const fakeApp = {
      commands: { add: vi.fn(), remove: vi.fn() },
      notify: vi.fn(),
      host: { runtime: { runtime: "electron" } },
    } as any;

    class TestPlugin extends Plugin {
      onload() {}
    }
    const plugin = new TestPlugin(fakeApp, { id: "demo", name: "Demo", version: "1.0.0" });
    await plugin.saveData({ blob: "A".repeat(10_000) });
    await plugin.flushData();
    expect(write).toHaveBeenCalledTimes(1);

    // Identical save deduplicates via digest without retaining .text string.
    await plugin.saveData({ blob: "A".repeat(10_000) });
    await plugin.flushData();
    expect(write).toHaveBeenCalledTimes(1);

    // Different payload writes again.
    await plugin.saveData({ blob: "B".repeat(10_000) });
    await plugin.flushData();
    expect(write).toHaveBeenCalledTimes(2);
    await plugin.unloadAndWait();

    // Desktop PluginManager retains empty code and undefined files after CJS evaluation.
    const manager = new PluginManager(fakeApp);
    await manager.rescan();
    await manager.enable("demo");
    const loaded = (manager as any).loaded.get("demo");
    expect(loaded).toBeDefined();
    expect(loaded.code).toBe("");
    expect(loaded.files).toBeUndefined();
    await manager.disable("demo");
  });
});
