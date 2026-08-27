import { describe, expect, it, vi } from "vitest";
import {
  chunkMetadataSnapshot,
  DebouncedMetadataCacheWriter,
  isPersistedMetadataIndexSnapshot,
  reconcileMetadataIndex,
  toPersistedSnapshot,
  type MetadataIndexSnapshot,
  type PersistedMetadataIndexSnapshot,
} from "../../src/indexer/metadata-indexer";

describe("metadata utility-process indexer", () => {
  it("serializes initialization as ordered byte- and entry-bounded chunks", () => {
    const snapshot: MetadataIndexSnapshot = {
      schemaVersion: 1,
      entries: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
        `Note ${index}.md`,
        { mtimeMs: index, size: 80, content: "é".repeat(40), metadata: { links: [], embeds: [], tags: [], headings: [], aliases: [] } },
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
  it("reuses unchanged warm entries, parses only changed/new files, and drops deleted entries", async () => {
    const persisted: MetadataIndexSnapshot = {
      schemaVersion: 1,
      entries: {
        "same.md": { mtimeMs: 1, size: 4, content: "same", metadata: { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] } },
        "changed.md": { mtimeMs: 1, size: 3, content: "old", metadata: { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] } },
        "deleted.md": { mtimeMs: 1, size: 4, content: "gone", metadata: { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] } },
      },
    };
    const read = vi.fn(async (path: string) => ({ "changed.md": "new", "new.md": "brand new" })[path]!);
    const parse = vi.fn((content: string) => ({
      frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [content],
    }));

    const stats = vi.fn();
    const result = await reconcileMetadataIndex(
      [
        { path: "same.md", mtimeMs: 1, size: 4 },
        { path: "changed.md", mtimeMs: 2, size: 3 },
        { path: "new.md", mtimeMs: 3, size: 9 },
      ],
      persisted,
      read,
      parse,
      stats,
    );

    expect(read.mock.calls.map(([path]) => path)).toEqual(["changed.md", "new.md"]);
    expect(Object.keys(result.entries).sort()).toEqual(["changed.md", "new.md", "same.md"]);
    expect(result.entries["same.md"]).toBe(persisted.entries["same.md"]);
    expect(stats).toHaveBeenCalledWith({ totalFiles: 3, parsedFiles: 2, reusedFiles: 1, deletedFiles: 1 });
  });

  it("upgrades unchanged legacy entries with mention keys off the read/parse path", async () => {
    const persisted: MetadataIndexSnapshot = {
      schemaVersion: 1,
      entries: {
        "same.md": {
          mtimeMs: 1,
          size: 4,
          content: "same",
          metadata: { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] },
        },
      },
    };
    const read = vi.fn(async () => "unexpected");
    const extractMentionKeys = vi.fn(() => ["w:same"]);

    const result = await reconcileMetadataIndex(
      [{ path: "same.md", mtimeMs: 1, size: 4 }],
      persisted,
      read,
      vi.fn(),
      undefined,
      extractMentionKeys,
    );

    expect(read).not.toHaveBeenCalled();
    expect(extractMentionKeys).toHaveBeenCalledWith("same");
    expect(result.entries["same.md"].mentionKeys).toEqual(["w:same"]);
  });

  it("re-reads (without re-parsing) unchanged entries reconciled from a content-less persisted snapshot", async () => {
    const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: ["same"] };
    const persisted: PersistedMetadataIndexSnapshot = {
      schemaVersion: 1,
      entries: {
        "same.md": { mtimeMs: 1, size: 4, metadata },
      },
    };
    const read = vi.fn(async (path: string) => ({ "same.md": "same" })[path]!);
    const parse = vi.fn();

    const stats = vi.fn();
    const result = await reconcileMetadataIndex(
      [{ path: "same.md", mtimeMs: 1, size: 4 }],
      persisted,
      read,
      parse,
      stats,
    );

    expect(read.mock.calls.map(([path]) => path)).toEqual(["same.md"]);
    expect(parse).not.toHaveBeenCalled();
    expect(result.entries["same.md"]).toEqual({ mtimeMs: 1, size: 4, content: "same", metadata });
    expect(stats).toHaveBeenCalledWith({ totalFiles: 1, parsedFiles: 0, reusedFiles: 1, deletedFiles: 0 });
  });

  it("reuses mention keys that survived the disk round-trip instead of recomputing them", async () => {
    const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };
    const persisted: PersistedMetadataIndexSnapshot = {
      schemaVersion: 1,
      entries: {
        "same.md": { mtimeMs: 1, size: 4, metadata, mentionKeys: ["w:same"] },
      },
    };
    const extractMentionKeys = vi.fn(() => ["w:recomputed"]);

    const result = await reconcileMetadataIndex(
      [{ path: "same.md", mtimeMs: 1, size: 4 }],
      persisted,
      vi.fn(async () => "same"),
      vi.fn(),
      undefined,
      extractMentionKeys,
    );

    expect(extractMentionKeys).not.toHaveBeenCalled();
    expect(result.entries["same.md"].mentionKeys).toEqual(["w:same"]);
  });

  it("recomputes mention keys from the re-read content for pre-v0.7.15 content-less caches", async () => {
    const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };
    const persisted: PersistedMetadataIndexSnapshot = {
      schemaVersion: 1,
      entries: {
        "same.md": { mtimeMs: 1, size: 4, metadata },
      },
    };
    const extractMentionKeys = vi.fn(() => ["w:same"]);

    const result = await reconcileMetadataIndex(
      [{ path: "same.md", mtimeMs: 1, size: 4 }],
      persisted,
      vi.fn(async () => "same"),
      vi.fn(),
      undefined,
      extractMentionKeys,
    );

    expect(extractMentionKeys).toHaveBeenCalledWith("same");
    expect(result.entries["same.md"].mentionKeys).toEqual(["w:same"]);
  });

  describe("toPersistedSnapshot", () => {
    it("drops content, keeping only mtimeMs, size, and metadata", () => {
      const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };
      const snapshot: MetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: {
          "a.md": { mtimeMs: 1, size: 4, content: "abcd", metadata },
        },
      };

      const persisted = toPersistedSnapshot(snapshot);

      expect(persisted).toEqual({ schemaVersion: 1, entries: { "a.md": { mtimeMs: 1, size: 4, metadata } } });
      expect(persisted.entries["a.md"]).not.toHaveProperty("content");
    });

    it("preserves mentionKeys so the warm-start optimization survives persistence", () => {
      const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };
      const snapshot: MetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: {
          "a.md": { mtimeMs: 1, size: 4, content: "abcd", metadata, mentionKeys: ["w:abcd"] },
        },
      };

      const persisted = toPersistedSnapshot(snapshot);

      expect(persisted.entries["a.md"].mentionKeys).toEqual(["w:abcd"]);
      expect(persisted.entries["a.md"]).not.toHaveProperty("content");
    });
  });

  describe("isPersistedMetadataIndexSnapshot", () => {
    const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };

    it("accepts a well-formed content-less persisted snapshot", () => {
      const snapshot: PersistedMetadataIndexSnapshot = {
        schemaVersion: 1,
        entries: { "a.md": { mtimeMs: 1, size: 4, metadata } },
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
  });

  it("coalesces cache writes and flushes the latest snapshot on shutdown", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const writer = new DebouncedMetadataCacheWriter(write, 2_000);
    const first = { schemaVersion: 1, entries: {} } satisfies MetadataIndexSnapshot;
    const latest = { schemaVersion: 1, entries: { "A.md": {} as never } } satisfies MetadataIndexSnapshot;

    writer.schedule(first);
    writer.schedule(latest);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(write).not.toHaveBeenCalled();
    await writer.flush();
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(latest);
    vi.useRealTimers();
  });

  describe("DebouncedMetadataCacheWriter backoff", () => {
    it("grows the retry delay with capped exponential backoff on repeated failures", async () => {
      vi.useFakeTimers();
      try {
        const write = vi.fn(async () => { throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);
        const snapshot = { schemaVersion: 1, entries: {} } satisfies MetadataIndexSnapshot;

        writer.schedule(snapshot);
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
        const snapshot = { schemaVersion: 1, entries: {} } satisfies MetadataIndexSnapshot;

        writer.schedule(snapshot);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(onError).toHaveBeenNthCalledWith(1, error, 1);

        await vi.advanceTimersByTimeAsync(4_000);
        expect(onError).toHaveBeenNthCalledWith(2, error, 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets a fresh schedule() call fire at the base delay, not the backed-off delay", async () => {
      vi.useFakeTimers();
      try {
        const write = vi.fn(async () => { throw new Error("disk full"); });
        const writer = new DebouncedMetadataCacheWriter(write, 2_000);
        const first = { schemaVersion: 1, entries: {} } satisfies MetadataIndexSnapshot;

        writer.schedule(first);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(write).toHaveBeenCalledTimes(1); // now backed off to a 4_000ms retry

        const fresh = { schemaVersion: 1, entries: { "A.md": {} as never } } satisfies MetadataIndexSnapshot;
        writer.schedule(fresh);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(write).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith(fresh);
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
        const snapshot = { schemaVersion: 1, entries: {} } satisfies MetadataIndexSnapshot;

        writer.schedule(snapshot);
        await vi.advanceTimersByTimeAsync(2_000); // fails (1st failure)
        expect(write).toHaveBeenCalledTimes(1);

        shouldFail = false;
        await vi.advanceTimersByTimeAsync(4_000); // retries at 4_000ms backoff, succeeds
        expect(write).toHaveBeenCalledTimes(2);

        shouldFail = true;
        writer.schedule(snapshot);
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
        const snapshot = { schemaVersion: 1, entries: {} } satisfies MetadataIndexSnapshot;

        writer.schedule(snapshot);
        await expect(writer.flush()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
