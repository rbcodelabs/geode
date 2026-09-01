import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import {
  METADATA_CACHE_SCHEMA_VERSION,
  MetadataCache,
  extractMentionIndexKeys,
  parseMetadata,
} from "../../src/renderer/metadata-cache";
import {
  METADATA_SNAPSHOT_CHUNK_MAX_BYTES,
  METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES,
  type PersistedMetadataIndexEntry,
} from "../../src/indexer/metadata-indexer";

type CacheApi = {
  readMetadataCache: ReturnType<typeof vi.fn>;
  writeMetadataCache: ReturnType<typeof vi.fn>;
};

function installCacheApi(stored: unknown): CacheApi {
  const api = {
    readMetadataCache: vi.fn(async () => stored),
    writeMetadataCache: vi.fn(async () => {}),
  };
  vi.stubGlobal("window", { geode: api });
  return api;
}

afterEach(() => vi.unstubAllGlobals());

describe("MetadataCache persistence", () => {
  it("hydrates the warm cache without awaiting a slow utility reconciliation", async () => {
    const fake = new FakeVault({ "A.md": "# Warm" });
    const file = fake.getFileByPath("A.md")!;
    const stored = {
      schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
      entries: {
        "A.md": { mtimeMs: file.mtime, size: file.size, metadata: parseMetadata("# Warm") },
      },
    };
    let resolveWorker!: (available: true) => void;
    let deliver: (message: unknown) => void = () => {};
    const worker = new Promise<true>((resolve) => { resolveWorker = resolve; });
    const api = {
      readMetadataCache: vi.fn(async () => stored),
      writeMetadataCache: vi.fn(async () => {}),
      startMetadataIndexer: vi.fn(() => worker),
      onMetadataIndexerMessage: vi.fn((cb: (message: unknown) => void) => { deliver = cb; }),
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();

    expect(cache.getFileCache(file)?.headings[0].heading).toBe("Warm");
    expect(cache.isUnlinkedMentionsReady()).toBe(false);
    expect(api.startMetadataIndexer).toHaveBeenCalledOnce();
    let workerSettled = false;
    void worker.then(() => { workerSettled = true; });
    await Promise.resolve();
    expect(workerSettled).toBe(false);

    deliver({ type: "snapshot-start", schemaVersion: METADATA_CACHE_SCHEMA_VERSION, totalEntries: 1 });
    deliver({
      type: "snapshot-chunk",
      sequence: 0,
      entries: {
        "A.md": { ...stored.entries["A.md"], mentionKeys: extractMentionIndexKeys("# Warm") },
      },
    });
    deliver({ type: "snapshot-complete", totalChunks: 1 });
    resolveWorker(true);
    await cache.waitForBackgroundIdle();
    expect(cache.isUnlinkedMentionsReady()).toBe(true);
  });

  it("does no mention-content processing on the synchronous warm-start path", async () => {
    const content = "Plain mention of Target. ".repeat(100_000);
    const fake = new FakeVault({ "Source.md": content, "Target.md": "# Target" });
    const source = fake.getFileByPath("Source.md")!;
    const target = fake.getFileByPath("Target.md")!;
    const stored = {
      schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
      entries: {
        "Source.md": { mtimeMs: source.mtime, size: source.size, metadata: parseMetadata(content) },
        "Target.md": { mtimeMs: target.mtime, size: target.size, metadata: parseMetadata("# Target") },
      },
    };
    let resolveWorker!: (available: true) => void;
    const worker = new Promise<true>((resolve) => { resolveWorker = resolve; });
    vi.stubGlobal("window", { geode: {
      readMetadataCache: vi.fn(async () => stored),
      writeMetadataCache: vi.fn(async () => {}),
      startMetadataIndexer: vi.fn(() => worker),
      onMetadataIndexerMessage: vi.fn(),
    } });

    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    expect(cache.isUnlinkedMentionsReady()).toBe(false);
    expect(await cache.getUnlinkedMentions(target)).toEqual([]);
    resolveWorker(true);
  });

  it("progressively fills mention keys for oversized paths omitted from the worker snapshot", async () => {
    const fake = new FakeVault({
      "Source.md": "Plain mention of Target.",
      "Target.md": "# Target",
    });
    const source = fake.getFileByPath("Source.md")!;
    const target = fake.getFileByPath("Target.md")!;
    const stored = {
      schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
      entries: {
        "Source.md": {
          mtimeMs: source.mtime,
          size: source.size,
          metadata: parseMetadata("Plain mention of Target."),
        },
        "Target.md": {
          mtimeMs: target.mtime,
          size: target.size,
          metadata: parseMetadata("# Target"),
        },
      },
    };
    let deliver: (message: unknown) => void = () => {};
    const api = {
      readMetadataCache: vi.fn(async () => stored),
      writeMetadataCache: vi.fn(async () => {}),
      onMetadataIndexerMessage: vi.fn((cb: (message: unknown) => void) => { deliver = cb; }),
      startMetadataIndexer: vi.fn(async () => {
        deliver({ type: "snapshot-start", schemaVersion: METADATA_CACHE_SCHEMA_VERSION, totalEntries: 2 });
        deliver({ type: "snapshot-chunk", sequence: 0, entries: {
          "Target.md": {
            ...stored.entries["Target.md"],
            mentionKeys: extractMentionIndexKeys("# Target"),
          },
        } });
        deliver({ type: "snapshot-complete", totalChunks: 1 });
        return true;
      }),
    };
    vi.stubGlobal("window", { geode: api });
    const readSpy = vi.spyOn(fake, "cachedRead");
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(readSpy.mock.calls.map(([file]) => file.path)).toEqual(["Source.md"]);
    expect(cache.isUnlinkedMentionsReady()).toBe(true);
    expect((await cache.getUnlinkedMentions(target)).map((entry) => entry.source.path)).toEqual(["Source.md"]);
  });

  it("assembles ordered utility-process chunks and applies parsed deltas without renderer reads", async () => {
    const fake = new FakeVault({ "A.md": "# Old" });
    const initial = fake.getFileByPath("A.md")!;
    let deliver: (message: unknown) => void = () => {};
    const api = {
      readMetadataCache: vi.fn(async () => null),
      writeMetadataCache: vi.fn(async () => {}),
      startMetadataIndexer: vi.fn(async () => {
        deliver({ type: "snapshot-start", schemaVersion: METADATA_CACHE_SCHEMA_VERSION, totalEntries: 1 });
        deliver({ type: "snapshot-chunk", sequence: 0, entries: {
          "A.md": { mtimeMs: initial.mtime, size: initial.size, metadata: parseMetadata("# Old") },
        } });
        deliver({ type: "snapshot-complete", totalChunks: 1 });
        return true;
      }),
      onMetadataIndexerMessage: vi.fn((cb: (message: unknown) => void) => { deliver = cb; }),
    };
    vi.stubGlobal("window", { geode: api });
    const readSpy = vi.spyOn(fake, "cachedRead");
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(readSpy).not.toHaveBeenCalled();
    expect(api.readMetadataCache).toHaveBeenCalledOnce();
    expect(api.writeMetadataCache).not.toHaveBeenCalled();

    fake.setFile("A.md", "# New");
    fake.trigger("modify", fake.getFileByPath("A.md"));
    deliver({
      type: "delta",
      path: "A.md",
      entry: { mtimeMs: 2, size: 5, metadata: parseMetadata("# New") },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readSpy).not.toHaveBeenCalled();
    expect(cache.getFileCache(fake.getFileByPath("A.md")!)?.headings[0].heading).toBe("New");
  });

  it("progressively rebuilds and persists when the utility process is unavailable", async () => {
    const fake = new FakeVault({ "A.md": "# A" });
    const api = {
      readMetadataCache: vi.fn(async () => { throw new Error("must not read full cache"); }),
      writeMetadataCache: vi.fn(async () => {}),
      startMetadataIndexer: vi.fn(async () => null),
      onMetadataIndexerMessage: vi.fn(),
    };
    vi.stubGlobal("window", { geode: api });
    const readSpy = vi.spyOn(fake, "cachedRead");
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    await cache.waitForBackgroundIdle();
    expect(readSpy).toHaveBeenCalledOnce();
    expect(api.readMetadataCache).toHaveBeenCalledOnce();
    expect(api.writeMetadataCache).toHaveBeenCalledOnce();
    expect(cache.getFileCache(fake.getFileByPath("A.md")!)).not.toBeNull();
  });

  it("does not lose a live delta delivered while snapshot chunks are arriving", async () => {
    const fake = new FakeVault({ "A.md": "# Old" });
    let deliver: (message: unknown) => void = () => {};
    const api = {
      readMetadataCache: vi.fn(),
      writeMetadataCache: vi.fn(),
      onMetadataIndexerMessage: vi.fn((cb: (message: unknown) => void) => { deliver = cb; }),
      startMetadataIndexer: vi.fn(async () => {
        deliver({ type: "snapshot-start", schemaVersion: 1, totalEntries: 1 });
        deliver({ type: "snapshot-chunk", sequence: 0, entries: {
          "A.md": { mtimeMs: 1, size: 5, metadata: parseMetadata("# Old") },
        } });
        fake.setFile("A.md", "# New");
        fake.trigger("modify", fake.getFileByPath("A.md"));
        deliver({ type: "delta", path: "A.md", entry: {
          mtimeMs: 2, size: 5, metadata: parseMetadata("# New"),
        } });
        deliver({ type: "snapshot-complete", totalChunks: 1 });
        return true;
      }),
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    await cache.waitForBackgroundIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.getFileCache(fake.getFileByPath("A.md")!)?.headings[0].heading).toBe("New");
    expect(api.readMetadataCache).toHaveBeenCalledOnce();
    expect(api.writeMetadataCache).not.toHaveBeenCalled();
  });

  it("does not serialize or write the full cache from an incremental renderer flush", async () => {
    const fake = new FakeVault({ "A.md": "old" });
    const api = installCacheApi(null);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    api.writeMetadataCache.mockClear();

    fake.setFile("A.md", "new");
    fake.trigger("modify", fake.getFileByPath("A.md"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.writeMetadataCache).not.toHaveBeenCalled();
  });

  it("round-trips metadata and performs zero content reads on an unchanged warm start", async () => {
    const fake = new FakeVault({ "A.md": "# A\n[[B]]", "B.md": "# B" });
    const firstApi = installCacheApi(null);
    const cold = new MetadataCache(fake.asVault());
    await cold.initialize();

    const persisted = firstApi.writeMetadataCache.mock.calls[0][0];
    const readSpy = vi.spyOn(fake, "cachedRead");
    const warmApi = installCacheApi(persisted);
    const warm = new MetadataCache(fake.asVault());
    await warm.initialize();

    expect(readSpy).not.toHaveBeenCalled();
    expect(warm.getFileCache(fake.getFileByPath("A.md")!)?.headings[0].heading).toBe("A");
    expect(warm.resolvedLinks["A.md"]?.["B.md"]).toBe(1);
    expect(warmApi.writeMetadataCache).toHaveBeenCalledOnce();
  });

  it("reads only new or stat-changed files and drops deleted entries", async () => {
    const fake = new FakeVault({ "same.md": "# Same", "changed.md": "old", "deleted.md": "gone" });
    const firstApi = installCacheApi(null);
    await new MetadataCache(fake.asVault()).initialize();
    const persisted = firstApi.writeMetadataCache.mock.calls[0][0];

    fake.setFile("changed.md", "new content", { mtime: Date.now() + 1000 });
    fake.removeFile("deleted.md");
    fake.setFile("new.md", "brand new");
    const readSpy = vi.spyOn(fake, "cachedRead");
    const api = installCacheApi(persisted);
    await new MetadataCache(fake.asVault()).initialize();

    expect(readSpy.mock.calls.map(([file]) => file.path).sort()).toEqual(["changed.md", "new.md"]);
    const rewritten = api.writeMetadataCache.mock.calls[0][0] as any;
    expect(Object.keys(rewritten.entries).sort()).toEqual(["changed.md", "new.md", "same.md"]);
  });

  it.each([
    ["corrupt structure", { schemaVersion: METADATA_CACHE_SCHEMA_VERSION, entries: { "A.md": {} } }],
    ["incompatible schema", { schemaVersion: METADATA_CACHE_SCHEMA_VERSION + 1, entries: {} }],
  ])("falls back to a full rebuild for %s", async (_label, stored) => {
    const fake = new FakeVault({ "A.md": "# A", "B.md": "# B" });
    const readSpy = vi.spyOn(fake, "cachedRead");
    installCacheApi(stored);
    await new MetadataCache(fake.asVault()).initialize();
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps initialization correct when cache reads or writes fail", async () => {
    const fake = new FakeVault({ "A.md": "# A" });
    vi.stubGlobal("window", {
      geode: {
        readMetadataCache: vi.fn(async () => { throw new Error("read failed"); }),
        writeMetadataCache: vi.fn(async () => { throw new Error("write failed"); }),
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = new MetadataCache(fake.asVault());
    await expect(cache.initialize()).resolves.toBeUndefined();
    expect(cache.getFileCache(fake.getFileByPath("A.md")!)).not.toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});

/**
 * Regression coverage for the renderer-fallback OOM: `applyRendererFallback()`
 * + `persistCache()` used to read/parse every markdown file into one
 * in-memory Map (unavoidable — that's the live index) and THEN build a
 * SECOND full-vault-sized `entries` object and hand it to a single
 * `writeMetadataCache` IPC call. For a vault with many files, or even a
 * handful of pathologically large ones, that single structured-clone payload
 * — duplicated again on arrival in the main process — was big enough to push
 * V8's heap past its limit. These tests simulate that shape (many files, and
 * separately, individually huge files) against a host that supports the new
 * chunked `upsertMetadataCacheEntries`/`pruneMetadataCache` API and assert
 * every individual IPC call's payload stays bounded — never the whole vault
 * in one shot — while the persisted end state is still complete and correct.
 */
describe("MetadataCache renderer-fallback chunked persistence (OOM regression)", () => {
  function headingHeavyContent(headingCount: number): string {
    return Array.from(
      { length: headingCount },
      (_, i) => `# Heading number ${i} with enough padding text to make this entry non-trivially sized`
    ).join("\n");
  }

  function installChunkedApi(startBackground: () => Promise<true | null> = async () => null) {
    const api = {
      readMetadataCache: vi.fn(async () => null),
      writeMetadataCache: vi.fn(async () => {}),
      upsertMetadataCacheEntries: vi.fn(async () => {}),
      pruneMetadataCache: vi.fn(async () => {}),
      reportMetadataFallback: vi.fn(async () => {}),
      startMetadataIndexer: vi.fn(startBackground),
      onMetadataIndexerMessage: vi.fn(),
    };
    vi.stubGlobal("window", { geode: api });
    return api;
  }

  it("splits a vault of many small files into multiple bounded upsert batches instead of one whole-vault write", async () => {
    // More files than fit in a single entry-count-limited batch.
    const fileCount = METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES * 3 + 7;
    const files: Record<string, string> = {};
    for (let i = 0; i < fileCount; i++) files[`Note-${i}.md`] = `# Note ${i}\n\nSome body text.`;
    const fake = new FakeVault(files);
    const api = installChunkedApi();
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(api.writeMetadataCache).not.toHaveBeenCalled();
    expect(api.upsertMetadataCacheEntries.mock.calls.length).toBeGreaterThan(1);

    const seenPaths = new Set<string>();
    for (const [payload] of api.upsertMetadataCacheEntries.mock.calls) {
      const entries = payload.entries as Record<string, PersistedMetadataIndexEntry>;
      const paths = Object.keys(entries);
      expect(paths.length).toBeLessThanOrEqual(METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES);
      expect(payload.schemaVersion).toBe(METADATA_CACHE_SCHEMA_VERSION);
      for (const path of paths) {
        expect(seenPaths.has(path)).toBe(false); // no path sent twice
        seenPaths.add(path);
      }
    }
    expect(seenPaths.size).toBe(fileCount);

    expect(api.pruneMetadataCache).toHaveBeenCalledOnce();
    const [prunedPaths] = api.pruneMetadataCache.mock.calls[0] as [string[]];
    expect(prunedPaths.sort()).toEqual([...seenPaths].sort());
  });

  it("splits a vault with a few pathologically large files by byte size, keeping every batch's serialized payload bounded", async () => {
    // Individually large files (thousands of headings each, matching the
    // reported repro of AI-transcript notes generating multi-MB of metadata
    // per file) — few enough files to never hit the entry-count limit, but
    // collectively far larger than one byte-size chunk.
    const fake = new FakeVault({
      "Big-1.md": headingHeavyContent(600),
      "Big-2.md": headingHeavyContent(600),
      "Big-3.md": headingHeavyContent(600),
      "Big-4.md": headingHeavyContent(600),
      "Big-5.md": headingHeavyContent(600),
    });
    const api = installChunkedApi();
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(api.writeMetadataCache).not.toHaveBeenCalled();
    expect(api.upsertMetadataCacheEntries.mock.calls.length).toBeGreaterThan(1);

    // The whole-vault size this regression test exists to bound: if this
    // assertion fails, the "many small entries" batching above could still
    // be passing for the wrong reason (count-based only) while a few large
    // files still slip through as one giant payload.
    let totalBytesAcrossAllCalls = 0;
    for (const [payload] of api.upsertMetadataCacheEntries.mock.calls) {
      const serializedBytes = JSON.stringify(payload).length;
      totalBytesAcrossAllCalls += serializedBytes;
      // Generous slack over the nominal chunk ceiling: the batching decision
      // is made on a conservative per-entry estimate, not the exact
      // serialized size of the accumulated batch, so this asserts "bounded",
      // not "byte-exact" — a single oversized entry may be sent alone rather
      // than dropped (see estimateEntryBytes's doc comment), but it is never
      // combined with siblings into an unbounded pile.
      expect(serializedBytes).toBeLessThan(METADATA_SNAPSHOT_CHUNK_MAX_BYTES * 2);
    }
    // Sanity check the fixture actually reproduces a large-vault shape: the
    // total metadata sent is a large multiple of any single chunk's ceiling
    // (otherwise this test would trivially pass with just one batch).
    expect(totalBytesAcrossAllCalls).toBeGreaterThan(METADATA_SNAPSHOT_CHUNK_MAX_BYTES * 3);

    expect(api.pruneMetadataCache).toHaveBeenCalledOnce();
    const [prunedPaths] = api.pruneMetadataCache.mock.calls[0] as [string[]];
    expect(prunedPaths.sort()).toEqual(["Big-1.md", "Big-2.md", "Big-3.md", "Big-4.md", "Big-5.md"]);
  });

  it("prunes rows for files no longer in the vault when the fallback path re-runs", async () => {
    const fake = new FakeVault({ "Keep.md": "# Keep", "Gone.md": "# Gone" });
    const api = installChunkedApi();
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    await cache.waitForBackgroundIdle();
    expect(api.pruneMetadataCache).toHaveBeenCalledWith(["Keep.md", "Gone.md"]);

    api.upsertMetadataCacheEntries.mockClear();
    api.pruneMetadataCache.mockClear();
    fake.removeFile("Gone.md");

    // A second renderer-fallback cycle (e.g. the utility process stays
    // unavailable across a vault reopen) must prune the now-deleted file
    // rather than leaving its row stale forever.
    (cache as unknown as { backgroundUnavailable: boolean }).backgroundUnavailable = true;
    await (cache as unknown as { applyRendererFallback: () => Promise<void> }).applyRendererFallback();

    expect(api.pruneMetadataCache).toHaveBeenCalledWith(["Keep.md"]);
  });

  it("reports a diagnostic when the renderer fallback is entered because the utility process resolved unavailable", async () => {
    const fake = new FakeVault({ "A.md": "# A", "B.md": "# B" });
    const api = installChunkedApi(async () => null);
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(api.reportMetadataFallback).toHaveBeenCalledOnce();
    const [info] = api.reportMetadataFallback.mock.calls[0] as [{ reason: string; fileCount: number }];
    expect(info.fileCount).toBe(2);
    expect(info.reason).toMatch(/non-true/i);
  });

  it("reports a diagnostic with the rejection reason when starting the utility process throws", async () => {
    const fake = new FakeVault({ "A.md": "# A" });
    const api = installChunkedApi(() => Promise.reject(new Error("spawn ENOENT")));
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(api.reportMetadataFallback).toHaveBeenCalledOnce();
    const [info] = api.reportMetadataFallback.mock.calls[0] as [{ reason: string; fileCount: number }];
    expect(info.reason).toMatch(/spawn ENOENT/);
  });

  it("does not report a fallback diagnostic when the background indexer is available", async () => {
    const fake = new FakeVault({ "A.md": "# A" });
    const api = installChunkedApi(async () => true);
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(api.reportMetadataFallback).not.toHaveBeenCalled();
    expect(api.upsertMetadataCacheEntries).not.toHaveBeenCalled();
  });

  it("falls back to the single-shot writeMetadataCache call on a host without chunked persistence support (e.g. mobile)", async () => {
    // No upsertMetadataCacheEntries/pruneMetadataCache on this host — mirrors
    // createLegacyGeodeFacade, which mobile/browser hosts use.
    const fake = new FakeVault({ "A.md": "# A", "B.md": "# B" });
    const api = {
      readMetadataCache: vi.fn(async () => null),
      writeMetadataCache: vi.fn(async () => {}),
      startMetadataIndexer: vi.fn(async () => null),
      onMetadataIndexerMessage: vi.fn(),
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(fake.asVault());

    await cache.initialize();
    await cache.waitForBackgroundIdle();

    expect(api.writeMetadataCache).toHaveBeenCalledOnce();
    const [payload] = api.writeMetadataCache.mock.calls[0] as [{ entries: Record<string, unknown> }];
    expect(Object.keys(payload.entries).sort()).toEqual(["A.md", "B.md"]);
  });
});
