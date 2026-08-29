import { describe, expect, it, vi } from "vitest";
import {
  chunkMetadataSnapshot,
  DebouncedMetadataCacheWriter,
  isPersistedMetadataIndexSnapshot,
  reconcileMetadataIndex,
  type MetadataDirtyOp,
  type MetadataFileStat,
  type MetadataReconcileStore,
  type PersistedMetadataIndexEntry,
  type PersistedMetadataIndexSnapshot,
} from "../../src/indexer/metadata-indexer";

const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };

/**
 * In-memory stand-in for the SQLite-backed `MetadataReconcileStore` (the real
 * implementation lives in `src/main/metadata-cache-store.ts` and is exercised
 * against a real database in `metadata-cache-store.test.ts`). Lets
 * `reconcileMetadataIndex` be tested purely against its documented storage
 * contract, independent of SQLite.
 */
function fakeStore(initial: Record<string, PersistedMetadataIndexEntry> = {}): MetadataReconcileStore & {
  rows: Map<string, PersistedMetadataIndexEntry>;
} {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    readStats: () => [...rows.entries()].map(([path, entry]) => ({ path, mtimeMs: entry.mtimeMs, size: entry.size })),
    upsertBatch: (entries) => { for (const [path, entry] of Object.entries(entries)) rows.set(path, entry); },
    deletePaths: (paths) => { for (const path of paths) rows.delete(path); },
  };
}

describe("metadata utility-process indexer", () => {
  describe("chunkMetadataSnapshot", () => {
    it("serializes a snapshot as ordered byte- and entry-bounded chunks", () => {
      const snapshot: PersistedMetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
          `Note ${index}.md`,
          { mtimeMs: index, size: 80, metadata, mentionKeys: [`w:note${index}`.repeat(4)] },
        ])),
      };

      const messages = chunkMetadataSnapshot(snapshot, { maxBytes: 600, maxEntries: 2 });
      expect(messages[0]).toEqual({ type: "snapshot-start", schemaVersion: 1, totalEntries: 7 });
      expect(messages.at(-1)).toEqual(expect.objectContaining({ type: "snapshot-complete" }));
      const chunks = messages.slice(1, -1);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((message, sequence) => {
        expect(message).toEqual(expect.objectContaining({ type: "snapshot-chunk", sequence }));
        expect(Object.keys((message as any).entries).length).toBeGreaterThan(0);
        expect(Object.keys((message as any).entries).length).toBeLessThanOrEqual(2);
        expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(600);
      });
      expect(Object.assign({}, ...chunks.map((message: any) => message.entries))).toEqual(snapshot.entries);
    });

    it("omits an individual entry too large to fit in any chunk, without dropping the rest", () => {
      const snapshot: PersistedMetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: {
          "small.md": { mtimeMs: 1, size: 4, metadata },
          "huge.md": { mtimeMs: 2, size: 4, metadata: { ...metadata, aliases: Array(500).fill("x".repeat(50)) } },
        },
      };
      const messages = chunkMetadataSnapshot(snapshot, { maxBytes: 400 });
      const allEntries = Object.assign({}, ...messages.filter((m) => m.type === "snapshot-chunk").map((m: any) => m.entries));
      expect(allEntries).toEqual({ "small.md": snapshot.entries["small.md"] });
      expect(messages.at(-1)).toEqual({ type: "snapshot-complete", totalChunks: 1 });
    });
  });

  describe("isPersistedMetadataIndexSnapshot", () => {
    it("accepts a well-formed content-less persisted snapshot", () => {
      const snapshot: PersistedMetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: { "a.md": { mtimeMs: 1, size: 4, metadata } },
      };
      expect(isPersistedMetadataIndexSnapshot(snapshot)).toBe(true);
    });

    it("accepts an entry that carries mentionKeys", () => {
      const snapshot: PersistedMetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: { "a.md": { mtimeMs: 1, size: 4, metadata, mentionKeys: ["w:a"] } },
      };
      expect(isPersistedMetadataIndexSnapshot(snapshot)).toBe(true);
    });

    it("rejects the wrong schemaVersion", () => {
      expect(isPersistedMetadataIndexSnapshot({ schemaVersion: 2, entries: {} })).toBe(false);
    });

    it("rejects an entry with missing/malformed metadata fields", () => {
      expect(isPersistedMetadataIndexSnapshot({
        schemaVersion: 1,
        entries: { "a.md": { mtimeMs: 1, size: 4, metadata: { links: [], embeds: [], tags: [], headings: [] } } },
      })).toBe(false);
    });

    it("rejects a non-array mentionKeys", () => {
      expect(isPersistedMetadataIndexSnapshot({
        schemaVersion: 1,
        entries: { "a.md": { mtimeMs: 1, size: 4, metadata, mentionKeys: "not-an-array" } },
      })).toBe(false);
    });
  });

  describe("reconcileMetadataIndex", () => {
    it("reuses unchanged entries with zero I/O, parses only changed/new files, and does not call the store for reused paths", async () => {
      const store = fakeStore({
        "same.md": { mtimeMs: 1, size: 4, metadata },
        "changed.md": { mtimeMs: 1, size: 3, metadata },
        "deleted.md": { mtimeMs: 1, size: 4, metadata },
      });
      const read = vi.fn(async (path: string) => ({ "changed.md": "new", "new.md": "brand new" })[path]!);
      const parse = vi.fn((content: string) => ({ ...metadata, aliases: [content] }));
      const batches: Record<string, PersistedMetadataIndexEntry>[] = [];
      const stats = vi.fn();

      await reconcileMetadataIndex(
        [
          { path: "same.md", mtimeMs: 1, size: 4 },
          { path: "changed.md", mtimeMs: 2, size: 3 },
          { path: "new.md", mtimeMs: 3, size: 9 },
        ],
        store,
        read,
        parse,
        (batch) => batches.push(batch),
        stats,
      );

      expect(read.mock.calls.map(([path]) => path)).toEqual(["changed.md", "new.md"]);
      // "same.md" was never touched: still exactly what it was seeded with.
      expect(store.rows.get("same.md")).toEqual({ mtimeMs: 1, size: 4, metadata });
      expect(store.rows.get("changed.md")).toEqual({ mtimeMs: 2, size: 3, metadata: { ...metadata, aliases: ["new"] } });
      expect(store.rows.get("new.md")).toEqual({ mtimeMs: 3, size: 9, metadata: { ...metadata, aliases: ["brand new"] } });
      expect(store.rows.has("deleted.md")).toBe(false);
      // Only the changed/new batch is handed to onBatch — reused entries
      // never round-trip through memory or an outgoing chunk.
      expect(Object.assign({}, ...batches)).toEqual({
        "changed.md": { mtimeMs: 2, size: 3, metadata: { ...metadata, aliases: ["new"] } },
        "new.md": { mtimeMs: 3, size: 9, metadata: { ...metadata, aliases: ["brand new"] } },
      });
      expect(stats).toHaveBeenCalledWith({ totalFiles: 3, parsedFiles: 2, reusedFiles: 1, deletedFiles: 1 });
    });

    it("computes mentionKeys for changed/new files via the injected extractor", async () => {
      const store = fakeStore();
      const extractMentionKeys = vi.fn(() => ["w:brand"]);

      const batches: Record<string, PersistedMetadataIndexEntry>[] = [];
      await reconcileMetadataIndex(
        [{ path: "new.md", mtimeMs: 1, size: 5 }],
        store,
        async () => "brand new",
        () => metadata,
        (batch) => batches.push(batch),
        undefined,
        extractMentionKeys,
      );

      expect(extractMentionKeys).toHaveBeenCalledWith("brand new");
      expect(store.rows.get("new.md")?.mentionKeys).toEqual(["w:brand"]);
      expect(batches[0]["new.md"].mentionKeys).toEqual(["w:brand"]);
    });

    it("omits mentionKeys entirely when no extractor is provided", async () => {
      const store = fakeStore();
      await reconcileMetadataIndex(
        [{ path: "new.md", mtimeMs: 1, size: 5 }],
        store,
        async () => "content",
        () => metadata,
      );
      expect(store.rows.get("new.md")).not.toHaveProperty("mentionKeys");
    });

    it("deletes rows for paths no longer present in the vault, in one deletePaths call", async () => {
      const store = fakeStore({
        "gone1.md": { mtimeMs: 1, size: 1, metadata },
        "gone2.md": { mtimeMs: 1, size: 1, metadata },
        "kept.md": { mtimeMs: 1, size: 1, metadata },
      });
      const deletePaths = vi.spyOn(store, "deletePaths");
      await reconcileMetadataIndex([{ path: "kept.md", mtimeMs: 1, size: 1 }], store, async () => "", () => metadata);
      expect(deletePaths).toHaveBeenCalledOnce();
      expect(deletePaths.mock.calls[0][0].sort()).toEqual(["gone1.md", "gone2.md"]);
      expect([...store.rows.keys()]).toEqual(["kept.md"]);
    });

    it("does not call the store's deletePaths at all when nothing was deleted", async () => {
      const store = fakeStore({ "kept.md": { mtimeMs: 1, size: 1, metadata } });
      const deletePaths = vi.spyOn(store, "deletePaths");
      await reconcileMetadataIndex([{ path: "kept.md", mtimeMs: 1, size: 1 }], store, async () => "", () => metadata);
      expect(deletePaths).not.toHaveBeenCalled();
    });

    it("does not call onBatch/upsertBatch for a batch with nothing changed", async () => {
      const store = fakeStore({ "same.md": { mtimeMs: 1, size: 4, metadata } });
      const upsertBatch = vi.spyOn(store, "upsertBatch");
      const onBatch = vi.fn();
      await reconcileMetadataIndex(
        [{ path: "same.md", mtimeMs: 1, size: 4 }],
        store,
        async () => { throw new Error("must not read an unchanged file"); },
        () => metadata,
        onBatch,
      );
      expect(upsertBatch).not.toHaveBeenCalled();
      expect(onBatch).not.toHaveBeenCalled();
    });

    it("streams across multiple internal batches for a large file list, calling onBatch more than once", async () => {
      const store = fakeStore();
      const files: MetadataFileStat[] = Array.from({ length: 1_200 }, (_, i) => ({
        path: `Note-${i}.md`, mtimeMs: 1, size: 1,
      }));
      const batchCalls: number[] = [];
      await reconcileMetadataIndex(
        files,
        store,
        async () => "x",
        () => metadata,
        (batch) => batchCalls.push(Object.keys(batch).length),
      );
      // 1200 files at the internal ~500-file batch size -> at least 3 batches.
      expect(batchCalls.length).toBeGreaterThanOrEqual(3);
      expect(batchCalls.reduce((a, b) => a + b, 0)).toBe(1_200);
      expect(store.rows.size).toBe(1_200);
    });
  });

  it("coalesces cache writes and flushes the latest per-path value on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async () => {});
      const writer = new DebouncedMetadataCacheWriter(write, 2_000);
      const entryA: MetadataDirtyOp = { mtimeMs: 1, size: 1, metadata };
      const entryA2: MetadataDirtyOp = { mtimeMs: 2, size: 2, metadata };

      writer.schedule("A.md", entryA);
      writer.schedule("A.md", entryA2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(write).not.toHaveBeenCalled();
      await writer.flush();
      expect(write).toHaveBeenCalledOnce();
      const dirty = write.mock.calls[0][0] as Map<string, MetadataDirtyOp>;
      expect([...dirty.entries()]).toEqual([["A.md", entryA2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges multiple different-path schedules within one debounce window into a single flush", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async () => {});
      const writer = new DebouncedMetadataCacheWriter(write, 2_000);
      const a: MetadataDirtyOp = { mtimeMs: 1, size: 1, metadata };
      const b: MetadataDirtyOp = { mtimeMs: 2, size: 2, metadata };

      writer.schedule("A.md", a);
      writer.schedule("B.md", b);
      writer.schedule("C.md", null); // a delete
      await vi.advanceTimersByTimeAsync(2_000);

      expect(write).toHaveBeenCalledOnce();
      const dirty = write.mock.calls[0][0] as Map<string, MetadataDirtyOp>;
      expect(new Map(dirty)).toEqual(new Map([["A.md", a], ["B.md", b], ["C.md", null]]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing on flush() when nothing is pending", async () => {
    const write = vi.fn(async () => {});
    const writer = new DebouncedMetadataCacheWriter(write, 2_000);
    await writer.flush();
    expect(write).not.toHaveBeenCalled();
  });

  describe("DebouncedMetadataCacheWriter backoff", () => {
    const entryA: MetadataDirtyOp = { mtimeMs: 1, size: 1, metadata };

    it("grows the retry delay with capped exponential backoff on repeated failures", async () => {
      vi.useFakeTimers();
      try {
        const write = vi.fn(async () => { throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);

        writer.schedule("A.md", entryA);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(write).toHaveBeenCalledTimes(1);

        // First failure -> backoff = 2_000 * 2^1 = 4_000ms
        await vi.advanceTimersByTimeAsync(3_999);
        expect(write).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(2);

        // Second failure -> backoff = 2_000 * 2^2 = 8_000ms
        await vi.advanceTimersByTimeAsync(7_999);
        expect(write).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(3);

        // Backoff keeps doubling (16s, 32s, 64s, 128s, 256s) until it would
        // exceed the 5-minute cap. Advance through calls 4-8 in one go
        // (16_000 + 32_000 + 64_000 + 128_000 + 256_000 = 496_000ms).
        await vi.advanceTimersByTimeAsync(496_000);
        expect(write).toHaveBeenCalledTimes(8);

        // From here on, backoff is capped at exactly 5 minutes per retry —
        // verify it holds steady across two more capped cycles.
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        expect(write).toHaveBeenCalledTimes(8);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(9);

        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        expect(write).toHaveBeenCalledTimes(9);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(10);
      } finally {
        vi.useRealTimers();
      }
    });

    it("calls onError with the error and consecutiveFailures count on each failure", async () => {
      vi.useFakeTimers();
      try {
        const error = new Error("disk full");
        const write = vi.fn(async () => { throw error; });
        const onError = vi.fn();
        const writer = new DebouncedMetadataCacheWriter(write, 2_000, onError);

        writer.schedule("A.md", entryA);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(onError).toHaveBeenNthCalledWith(1, error, 1);

        await vi.advanceTimersByTimeAsync(4_000);
        expect(onError).toHaveBeenNthCalledWith(2, error, 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets a fresh schedule() for a DIFFERENT path fire at the base delay, not the backed-off delay, and both paths are included", async () => {
      vi.useFakeTimers();
      try {
        const write = vi.fn(async () => { throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);

        writer.schedule("A.md", entryA);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(write).toHaveBeenCalledTimes(1); // now backed off to a 4_000ms retry

        const fresh: MetadataDirtyOp = { mtimeMs: 9, size: 9, metadata };
        writer.schedule("B.md", fresh);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(write).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(2);
        const dirty = write.mock.calls[1][0] as Map<string, MetadataDirtyOp>;
        // The still-pending failed A.md write is merged in alongside the fresh B.md.
        expect(new Map(dirty)).toEqual(new Map([["A.md", entryA], ["B.md", fresh]]));
      } finally {
        vi.useRealTimers();
      }
    });

    it("a fresh schedule() for the SAME path overrides the stale failed value, not vice versa", async () => {
      vi.useFakeTimers();
      try {
        const write = vi.fn(async () => { throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);

        writer.schedule("A.md", entryA);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(write).toHaveBeenCalledTimes(1);

        const updated: MetadataDirtyOp = { mtimeMs: 2, size: 2, metadata };
        writer.schedule("A.md", updated);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(write).toHaveBeenCalledTimes(2);
        const dirty = write.mock.calls[1][0] as Map<string, MetadataDirtyOp>;
        expect([...dirty.entries()]).toEqual([["A.md", updated]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the backoff counter after a successful write, restarting from the base delay on the next failure", async () => {
      vi.useFakeTimers();
      try {
        let shouldFail = true;
        const write = vi.fn(async () => { if (shouldFail) throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);

        writer.schedule("A.md", entryA);
        await vi.advanceTimersByTimeAsync(2_000); // fails (1st failure)
        expect(write).toHaveBeenCalledTimes(1);

        shouldFail = false;
        await vi.advanceTimersByTimeAsync(4_000); // retries at 4_000ms backoff, succeeds
        expect(write).toHaveBeenCalledTimes(2);

        shouldFail = true;
        writer.schedule("A.md", entryA);
        await vi.advanceTimersByTimeAsync(2_000); // fresh schedule fires and fails again (1st failure again)
        expect(write).toHaveBeenCalledTimes(3);

        // Backoff should restart from the base delay (4_000ms), not continue growing from before.
        await vi.advanceTimersByTimeAsync(3_999);
        expect(write).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves flush() even when write throws, instead of rejecting", async () => {
      vi.useFakeTimers();
      try {
        const write = vi.fn(async () => { throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);

        writer.schedule("A.md", entryA);
        await expect(writer.flush()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
