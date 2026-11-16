import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import {
  METADATA_INDEX_SCHEMA_VERSION,
  METADATA_SNAPSHOT_CHUNK_MAX_BYTES,
  METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES,
  chunkMetadataSnapshot,
  createMetadataSnapshotStreamer,
  reconcileMetadataIndex,
  type MetadataReconcileStore,
  type MetadataSnapshotMessage,
  type PersistedMetadataIndexEntry,
  type PersistedMetadataIndexSnapshot,
} from "../../src/indexer/metadata-indexer";
import {
  deleteMetadataEntries,
  openMetadataDb,
  queryMentionCandidates,
  readMetadataStats,
  upsertMetadataEntries,
} from "../../src/main/metadata-cache-store";
import { MetadataCacheReaders } from "../../src/main/metadata-cache-reader";
import {
  METADATA_CACHE_SCHEMA_VERSION,
  MetadataCache,
  extractMentionIndexKeys,
  parseMetadata,
} from "../../src/renderer/metadata-cache";

const emptyMetadata = {
  frontmatterEndOffset: 0,
  links: [],
  embeds: [],
  tags: [],
  headings: [],
  aliases: [],
};

const tmpRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(tmpRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function makeTmpRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-cold-rebuild-"));
  tmpRoots.push(root);
  return root;
}

describe("cold SQLite metadata rebuild memory spike fixes (TASK-67)", () => {
  describe("createMetadataSnapshotStreamer", () => {
    it("emits snapshot-start(totalEntries: 0) and snapshot-complete(totalChunks: 0) when 0 entries are pushed", () => {
      const emitted: MetadataSnapshotMessage[] = [];
      const streamer = createMetadataSnapshotStreamer(METADATA_INDEX_SCHEMA_VERSION, (msg) => emitted.push(msg));
      expect(emitted).toEqual([]);
      streamer.finish();
      expect(emitted).toEqual([
        { type: "snapshot-start", schemaVersion: METADATA_INDEX_SCHEMA_VERSION, totalEntries: 0 },
        { type: "snapshot-complete", totalChunks: 0 },
      ]);
      expect(emitted).toEqual(chunkMetadataSnapshot({ schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries: {} }));
    });

    it("buffers a single partial chunk until finish() so totalEntries is exact", () => {
      const entries: Record<string, PersistedMetadataIndexEntry> = {
        "A.md": { mtimeMs: 1, size: 10, metadata: emptyMetadata },
        "B.md": { mtimeMs: 2, size: 20, metadata: emptyMetadata },
        "C.md": { mtimeMs: 3, size: 30, metadata: emptyMetadata },
      };
      const emitted: MetadataSnapshotMessage[] = [];
      const streamer = createMetadataSnapshotStreamer(METADATA_INDEX_SCHEMA_VERSION, (msg) => emitted.push(msg));

      streamer.pushBatch({ "A.md": entries["A.md"], "B.md": entries["B.md"] });
      streamer.pushBatch({ "C.md": entries["C.md"] });
      // Under maxEntries (50) and maxBytes (256 KiB): nothing emitted until finish().
      expect(emitted).toEqual([]);

      streamer.finish();
      expect(emitted).toEqual(chunkMetadataSnapshot({ schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries }));
    });

    it("streams full chunks incrementally during pushBatch BEFORE finish() and matches chunkMetadataSnapshot chunking", () => {
      const allEntries: Record<string, PersistedMetadataIndexEntry> = Object.fromEntries(
        Array.from({ length: 125 }, (_, i) => [
          `Note-${String(i).padStart(4, "0")}.md`,
          {
            mtimeMs: i + 1,
            size: 120,
            metadata: { ...emptyMetadata, aliases: [`alias-${i}-${"x".repeat(40)}`] },
          },
        ]),
      );

      const emitted: MetadataSnapshotMessage[] = [];
      const streamer = createMetadataSnapshotStreamer(METADATA_INDEX_SCHEMA_VERSION, (msg) => emitted.push(msg));

      const keys = Object.keys(allEntries);
      const batch1 = Object.fromEntries(keys.slice(0, 60).map((k) => [k, allEntries[k]]));
      const batch2 = Object.fromEntries(keys.slice(60).map((k) => [k, allEntries[k]]));

      streamer.pushBatch(batch1);
      // 60 entries > 50 maxEntries: snapshot-start + chunk 0 MUST already be emitted before batch2 or finish()!
      expect(emitted.length).toBe(2);
      expect(emitted[0].type).toBe("snapshot-start");
      expect(emitted[1]).toMatchObject({ type: "snapshot-chunk", sequence: 0 });
      expect(Object.keys((emitted[1] as Extract<MetadataSnapshotMessage, { type: "snapshot-chunk" }>).entries)).toHaveLength(
        METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES,
      );

      streamer.pushBatch(batch2);
      // 125 entries total -> chunk 0 (50) + chunk 1 (50) emitted, 25 buffered in chunk 2.
      expect(emitted.length).toBe(3);
      expect(emitted[2]).toMatchObject({ type: "snapshot-chunk", sequence: 1 });

      streamer.finish();
      expect(emitted.length).toBe(5);
      expect(emitted[3]).toMatchObject({ type: "snapshot-chunk", sequence: 2 });
      expect(emitted[4]).toEqual({ type: "snapshot-complete", totalChunks: 3 });

      const reference = chunkMetadataSnapshot({
        schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
        entries: allEntries,
      });
      // Chunk payloads and snapshot-complete must match chunkMetadataSnapshot 100%.
      expect(emitted.slice(1)).toEqual(reference.slice(1));
    });

    it("enforces maxBytes and omits oversized single entries identically to chunkMetadataSnapshot", () => {
      const snapshot: PersistedMetadataIndexSnapshot = {
        schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
        entries: {
          "small-1.md": { mtimeMs: 1, size: 10, metadata: emptyMetadata },
          "oversized.md": {
            mtimeMs: 2,
            size: 10,
            metadata: { ...emptyMetadata, aliases: Array(500).fill("z".repeat(60)) },
          },
          "small-2.md": { mtimeMs: 3, size: 10, metadata: { ...emptyMetadata, aliases: ["fits"] } },
          "small-3.md": { mtimeMs: 4, size: 10, metadata: { ...emptyMetadata, aliases: ["also-fits-next-chunk-" + "y".repeat(150)] } },
        },
      };

      const emitted: MetadataSnapshotMessage[] = [];
      const limits = { maxBytes: 450, maxEntries: 10 };
      const streamer = createMetadataSnapshotStreamer(METADATA_INDEX_SCHEMA_VERSION, (msg) => emitted.push(msg), limits);
      streamer.pushBatch(snapshot.entries);
      streamer.finish();

      const expected = chunkMetadataSnapshot(snapshot, limits);
      expect(emitted).toEqual(expected);
      for (const msg of emitted) {
        if (msg.type === "snapshot-chunk") {
          expect(Buffer.byteLength(JSON.stringify(msg))).toBeLessThanOrEqual(limits.maxBytes);
          expect(msg.entries).not.toHaveProperty("oversized.md");
        }
      }
    });
  });

  describe("MetadataCacheReaders.page() omittedPaths accounting", () => {
    it("returns omittedPaths: [] on empty and clean databases", async () => {
      const root = await makeTmpRoot();
      const db = openMetadataDb(root);
      const readers = new MetadataCacheReaders();
      try {
        // Empty DB
        const emptyBegin = readers.begin(1, root, 1);
        const emptyPage = readers.page(1, 1, emptyBegin.token, 0);
        expect(emptyPage).toEqual({
          schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
          sequence: 0,
          entries: {},
          examined: 0,
          omitted: { corrupt: 0, oversized: 0 },
          omittedPaths: [],
          done: true,
        });

        // Clean DB
        upsertMetadataEntries(db, {
          "Alpha.md": { mtimeMs: 10, size: 5, metadata: emptyMetadata },
          "Beta.md": { mtimeMs: 20, size: 8, metadata: emptyMetadata },
        });
        const cleanBegin = readers.begin(1, root, 2);
        const cleanPage = readers.page(1, 2, cleanBegin.token, 0);
        expect(Object.keys(cleanPage.entries)).toEqual(["Alpha.md", "Beta.md"]);
        expect(cleanPage.omitted).toEqual({ corrupt: 0, oversized: 0 });
        expect(cleanPage.omittedPaths).toEqual([]);
        expect(cleanPage.done).toBe(true);
      } finally {
        readers.closeAll();
        db.close();
      }
    });

    it("populates omittedPaths accurately for oversized and corrupt rows while keeping every page <= 256 KiB", async () => {
      const root = await makeTmpRoot();
      const db = openMetadataDb(root);
      const readers = new MetadataCacheReaders();
      try {
        const insert = db.prepare("INSERT INTO metadata_entries VALUES (?, 1, 1, ?, NULL)");
        // Near-limit valid entry first, followed by corrupt and oversized rows to exercise page-budget overflow on omittedPaths too.
        insert.run(
          "000-NearLimit.md",
          JSON.stringify({ ...emptyMetadata, frontmatter: { text: "x".repeat(261_700) } }),
        );
        insert.run(
          "001-OversizedPreflight.md",
          JSON.stringify({ ...emptyMetadata, frontmatter: { text: "y".repeat(300_000) } }),
        );
        insert.run(
          "002-OversizedEnvelope.md",
          JSON.stringify({ ...emptyMetadata, frontmatter: { text: "z".repeat(261_950) } }),
        );
        for (let i = 3; i <= 45; i++) {
          const p = `${String(i).padStart(3, "0")}-${"corrupt-path-segment-".repeat(3)}.md`;
          insert.run(p, "{not valid json");
        }
        upsertMetadataEntries(db, {
          "999-CleanTail.md": { mtimeMs: 5, size: 12, metadata: emptyMetadata },
        });

        const { token } = readers.begin(1, root, 1);
        const seenEntries: string[] = [];
        const seenOmitted: string[] = [];
        let totalExamined = 0;
        let sequence = 0;

        while (true) {
          const page = readers.page(1, 1, token, sequence++);
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(METADATA_SNAPSHOT_CHUNK_MAX_BYTES);
          expect(page.omittedPaths.length).toBe(page.omitted.corrupt + page.omitted.oversized);
          seenEntries.push(...Object.keys(page.entries));
          seenOmitted.push(...page.omittedPaths);
          totalExamined += page.examined;
          if (page.done) break;
        }

        expect(totalExamined).toBe(47);
        expect(seenEntries).toEqual(["000-NearLimit.md", "999-CleanTail.md"]);
        expect(seenOmitted).toContain("001-OversizedPreflight.md");
        expect(seenOmitted).toContain("002-OversizedEnvelope.md");
        expect(seenOmitted).toHaveLength(45);
      } finally {
        readers.closeAll();
        db.close();
      }
    });

    it("defers a near-limit valid entry to the next page rather than falsely omitting it when prior omittedPaths occupy space", async () => {
      const root = await makeTmpRoot();
      const db = openMetadataDb(root);
      const readers = new MetadataCacheReaders();
      try {
        const insert = db.prepare("INSERT INTO metadata_entries VALUES (?, 1, 1, ?, NULL)");
        for (let i = 0; i < 10; i++) {
          insert.run(`00${i}-${"corrupt-padding-".repeat(4)}.md`, "{corrupt");
        }
        // Valid entry that passes preflight and fits alone on a fresh page (~261,500 bytes < 261,888),
        // but does NOT fit alongside the 10 omittedPaths above (~750 bytes).
        upsertMetadataEntries(db, {
          "500-FitsOnOwnPage.md": {
            mtimeMs: 1,
            size: 1,
            metadata: { ...emptyMetadata, frontmatter: { text: "v".repeat(261_500) } },
          },
        });

        const { token } = readers.begin(1, root, 1);
        const page0 = readers.page(1, 1, token, 0);
        expect(page0.omitted).toEqual({ corrupt: 10, oversized: 0 });
        expect(page0.omittedPaths).toHaveLength(10);
        expect(Object.keys(page0.entries)).toEqual([]);
        expect(page0.done).toBe(false);

        const page1 = readers.page(1, 1, token, 1);
        expect(Object.keys(page1.entries)).toEqual(["500-FitsOnOwnPage.md"]);
        expect(page1.omitted).toEqual({ corrupt: 0, oversized: 0 });
        expect(page1.omittedPaths).toEqual([]);
        expect(page1.done).toBe(true);
      } finally {
        readers.closeAll();
        db.close();
      }
    });
  });

  describe("MetadataCache cold SQLite rebuild & selective omittedPaths recovery", () => {
    it("calls vault.cachedRead 0 times on cold SQLite rebuild while populating all files and links from streaming indexer chunks", async () => {
      const root = await makeTmpRoot();
      const db = openMetadataDb(root);
      const readers = new MetadataCacheReaders();
      try {
        const vaultFiles: Record<string, string> = {};
        for (let i = 0; i < 120; i++) {
          const next = `Note-${String((i + 1) % 120).padStart(3, "0")}`;
          vaultFiles[`Note-${String(i).padStart(3, "0")}.md`] = `# Heading ${i}\n\nLink to [[${next}]] and plain mention of Note-000.\n`;
        }
        const fake = new FakeVault(vaultFiles);
        const readSpy = vi.spyOn(fake, "cachedRead");

        let deliver: (msg: unknown) => void = () => {};
        const readerOwnerGen = 1;
        let indexerPromise!: Promise<true>;

        const api = {
          beginMetadataCacheRead: vi.fn(async () => readers.begin(1, root, readerOwnerGen)),
          readMetadataCachePage: vi.fn(async (token: string, sequence: number) =>
            readers.page(1, readerOwnerGen, token, sequence),
          ),
          cancelMetadataCacheRead: vi.fn(async (token: string) => {
            readers.cancel(1, readerOwnerGen, token);
          }),
          queryMetadataMentionCandidates: vi.fn(async (keys: string[]) => queryMentionCandidates(db, keys)),
          onMetadataIndexerMessage: vi.fn((cb: (msg: unknown) => void) => {
            deliver = cb;
            return () => {};
          }),
          startMetadataIndexer: vi.fn(() => {
            // Simulate utility process cold reconcile streaming chunks incrementally via createMetadataSnapshotStreamer.
            indexerPromise = (async () => {
              await Promise.resolve();
              const streamer = createMetadataSnapshotStreamer(METADATA_INDEX_SCHEMA_VERSION, (part) => deliver(part));
              const store: MetadataReconcileStore = {
                readStats: () => readMetadataStats(db),
                upsertBatch: (entries) => upsertMetadataEntries(db, entries),
                deletePaths: (paths) => deleteMetadataEntries(db, paths),
              };
              const stats = fake.getMarkdownFiles().map((f) => ({ path: f.path, mtimeMs: f.mtime, size: f.size }));
              await reconcileMetadataIndex(
                stats,
                store,
                async (p) => vaultFiles[p],
                (content) => parseMetadata(content),
                (batch) => {
                  const stripped: Record<string, PersistedMetadataIndexEntry> = {};
                  for (const [p, entry] of Object.entries(batch)) {
                    stripped[p] = { mtimeMs: entry.mtimeMs, size: entry.size, metadata: entry.metadata };
                  }
                  streamer.pushBatch(stripped);
                },
                undefined,
                (content) => extractMentionIndexKeys(content),
              );
              streamer.finish();
              return true as const;
            })();
            return indexerPromise;
          }),
        };
        vi.stubGlobal("window", { geode: api });

        const cache = new MetadataCache(fake.asVault());
        await cache.initialize();
        // Even before the background indexer completes, cold initialize did not queue deferredMisses.
        expect(readSpy).toHaveBeenCalledTimes(0);

        await indexerPromise;
        await cache.waitForBackgroundIdle();

        // Zero renderer double-reads/double-parses during cold SQLite rebuild!
        expect(readSpy).toHaveBeenCalledTimes(0);
        expect((cache as any).localMentionOverrides.size).toBe(0);
        expect((cache as any).backgroundSnapshot).toEqual({
          schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
          entries: {},
        });

        // All 120 files populated and links resolved accurately.
        expect(cache.getFileCache(fake.getFileByPath("Note-000.md")!)?.headings[0].heading).toBe("Heading 0");
        expect(cache.resolvedLinks["Note-000.md"]).toEqual({ "Note-001.md": 1 });
        expect(cache.resolvedLinks["Note-119.md"]).toEqual({ "Note-000.md": 1 });
        expect(cache.isUnlinkedMentionsReady()).toBe(true);

        cache.dispose();
      } finally {
        readers.closeAll();
        db.close();
      }
    });

    it("recovers ONLY omittedPaths via vault.cachedRead and leaves unindexed files for the background snapshot", async () => {
      const root = await makeTmpRoot();
      const db = openMetadataDb(root);
      const readers = new MetadataCacheReaders();
      try {
        const fake = new FakeVault({
          "CachedClean.md": "# CachedClean\n[[FreshUnindexed]]",
          "Oversized.md": "# Oversized Heading\n[[CachedClean]]",
          "FreshUnindexed.md": "# Fresh Heading",
        });
        const cleanFile = fake.getFileByPath("CachedClean.md")!;
        const oversizedFile = fake.getFileByPath("Oversized.md")!;
        const freshFile = fake.getFileByPath("FreshUnindexed.md")!;

        // Populate CachedClean.md normally and Oversized.md with a >256 KiB metadata_json row;
        // leave FreshUnindexed.md completely absent from SQLite.
        upsertMetadataEntries(db, {
          "CachedClean.md": {
            mtimeMs: cleanFile.mtime,
            size: cleanFile.size,
            metadata: parseMetadata("# CachedClean\n[[FreshUnindexed]]"),
          },
        });
        db.prepare("INSERT INTO metadata_entries VALUES (?, ?, ?, ?, NULL)").run(
          "Oversized.md",
          oversizedFile.mtime,
          oversizedFile.size,
          JSON.stringify({ ...parseMetadata("# Oversized Heading\n[[CachedClean]]"), frontmatter: { huge: "x".repeat(300_000) } }),
        );

        const readSpy = vi.spyOn(fake, "cachedRead");
        let deliver: (msg: unknown) => void = () => {};
        let releaseIndexer!: () => void;
        const indexerGate = new Promise<void>((resolve) => {
          releaseIndexer = resolve;
        });

        const api = {
          beginMetadataCacheRead: vi.fn(async () => readers.begin(1, root, 1)),
          readMetadataCachePage: vi.fn(async (token: string, sequence: number) => readers.page(1, 1, token, sequence)),
          cancelMetadataCacheRead: vi.fn(async (token: string) => readers.cancel(1, 1, token)),
          queryMetadataMentionCandidates: vi.fn(async (keys: string[]) => queryMentionCandidates(db, keys)),
          onMetadataIndexerMessage: vi.fn((cb: (msg: unknown) => void) => {
            deliver = cb;
            return () => {};
          }),
          startMetadataIndexer: vi.fn(async () => {
            await indexerGate;
            deliver({ type: "snapshot-start", schemaVersion: METADATA_CACHE_SCHEMA_VERSION, totalEntries: 1 });
            deliver({
              type: "snapshot-chunk",
              sequence: 0,
              entries: {
                "FreshUnindexed.md": {
                  mtimeMs: freshFile.mtime,
                  size: freshFile.size,
                  metadata: parseMetadata("# Fresh Heading"),
                },
              },
            });
            deliver({ type: "snapshot-complete", totalChunks: 1 });
            return true as const;
          }),
        };
        vi.stubGlobal("window", { geode: api });

        const cache = new MetadataCache(fake.asVault());
        await cache.initialize();
        // Wait for recoverPagedMisses to run BEFORE the background indexer finishes.
        await cache.waitForBackgroundIdle();

        // ONLY Oversized.md was in omittedPaths, so ONLY Oversized.md was read by the renderer!
        expect(readSpy.mock.calls.map(([f]) => f.path)).toEqual(["Oversized.md"]);
        expect(cache.getFileCache(oversizedFile)?.headings[0].heading).toBe("Oversized Heading");
        expect(cache.getFileCache(freshFile)).toBeNull();

        // Now let the background indexer deliver FreshUnindexed.md.
        releaseIndexer();
        await vi.waitFor(() => expect(cache.getFileCache(freshFile)?.headings[0].heading).toBe("Fresh Heading"));
        await cache.waitForBackgroundIdle();

        // Still only that 1 renderer read total, and all links are resolved!
        expect(readSpy.mock.calls.map(([f]) => f.path)).toEqual(["Oversized.md"]);
        expect(cache.resolvedLinks["CachedClean.md"]).toEqual({ "FreshUnindexed.md": 1 });
        expect(cache.resolvedLinks["Oversized.md"]).toEqual({ "CachedClean.md": 1 });

        cache.dispose();
      } finally {
        readers.closeAll();
        db.close();
      }
    });

    it.each([
      ["resolves false/null", async () => false as unknown as null],
      ["rejects", async () => { throw new Error("utility spawn failed"); }],
    ])("falls back safely via applyRendererFallback on a cold SQLite DB when startMetadataIndexer %s", async (_label, startImpl) => {
      const root = await makeTmpRoot();
      const db = openMetadataDb(root);
      const readers = new MetadataCacheReaders();
      try {
        const fake = new FakeVault({
          "One.md": "# One\n[[Two]]",
          "Two.md": "# Two",
        });
        const readSpy = vi.spyOn(fake, "cachedRead");
        const api = {
          beginMetadataCacheRead: vi.fn(async () => readers.begin(1, root, 1)),
          readMetadataCachePage: vi.fn(async (token: string, sequence: number) => readers.page(1, 1, token, sequence)),
          cancelMetadataCacheRead: vi.fn(async (token: string) => readers.cancel(1, 1, token)),
          queryMetadataMentionCandidates: vi.fn(async (keys: string[]) => queryMentionCandidates(db, keys)),
          reportMetadataFallback: vi.fn(async () => {}),
          onMetadataIndexerMessage: vi.fn(() => () => {}),
          startMetadataIndexer: vi.fn(startImpl),
        };
        vi.stubGlobal("window", { geode: api });

        const cache = new MetadataCache(fake.asVault());
        await cache.initialize();
        await vi.waitFor(() => {
          expect(cache.getFileCache(fake.getFileByPath("One.md")!)?.headings[0].heading).toBe("One");
          expect(cache.getFileCache(fake.getFileByPath("Two.md")!)?.headings[0].heading).toBe("Two");
        });
        await cache.waitForBackgroundIdle();

        expect(readSpy.mock.calls.map(([f]) => f.path).sort()).toEqual(["One.md", "Two.md"]);
        expect(cache.resolvedLinks["One.md"]).toEqual({ "Two.md": 1 });
        expect(api.reportMetadataFallback).toHaveBeenCalledOnce();

        cache.dispose();
      } finally {
        readers.closeAll();
        db.close();
      }
    });

    it("progressively deletes snapshot.entries keys across 50-item batches during applyBackgroundSnapshot", async () => {
      const vaultFiles: Record<string, string> = {};
      for (let i = 0; i < 120; i++) {
        vaultFiles[`File-${String(i).padStart(3, "0")}.md`] = `# Title ${i}`;
      }
      const fake = new FakeVault(vaultFiles);
      let deliver: (msg: unknown) => void = () => {};

      const observedRemainingCounts: number[] = [];
      const OriginalChannel = MessageChannel;

      const api = {
        beginMetadataCacheRead: vi.fn(async () => ({ token: "t", schemaVersion: METADATA_CACHE_SCHEMA_VERSION })),
        readMetadataCachePage: vi.fn(async () => ({
          schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
          sequence: 0,
          entries: {},
          examined: 0,
          omitted: { corrupt: 0, oversized: 0 },
          omittedPaths: [],
          done: true,
        })),
        cancelMetadataCacheRead: vi.fn(async () => {}),
        queryMetadataMentionCandidates: vi.fn(async () => []),
        onMetadataIndexerMessage: vi.fn((cb: (msg: unknown) => void) => {
          deliver = cb;
          return () => {};
        }),
        startMetadataIndexer: vi.fn(async () => true as const),
      };
      vi.stubGlobal("window", { geode: api });

      const cache = new MetadataCache(fake.asVault());
      await cache.initialize();

      vi.stubGlobal(
        "MessageChannel",
        class extends OriginalChannel {
          constructor() {
            super();
            const post = this.port2.postMessage.bind(this.port2);
            this.port2.postMessage = (...args: Parameters<MessagePort["postMessage"]>) => {
              const snap = (cache as any).backgroundSnapshot;
              if (snap?.entries) observedRemainingCounts.push(Object.keys(snap.entries).length);
              post(...args);
            };
          }
        },
      );

      const streamer = createMetadataSnapshotStreamer(METADATA_CACHE_SCHEMA_VERSION, (part) => deliver(part));
      const allEntries: Record<string, PersistedMetadataIndexEntry> = {};
      for (const f of fake.getMarkdownFiles()) {
        allEntries[f.path] = { mtimeMs: f.mtime, size: f.size, metadata: parseMetadata(vaultFiles[f.path]) };
      }
      streamer.pushBatch(allEntries);
      streamer.finish();

      await cache.waitForBackgroundIdle();
      // 120 entries in batches of 50 -> after batch 1 yields, 70 remain; after batch 2 yields, 20 remain; after batch 3, 0 remain.
      expect(observedRemainingCounts).toContain(70);
      expect(observedRemainingCounts).toContain(20);
      expect((cache as any).backgroundSnapshot).toEqual({
        schemaVersion: METADATA_CACHE_SCHEMA_VERSION,
        entries: {},
      });
      cache.dispose();
    });
  });
});
