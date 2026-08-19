import { describe, expect, it, vi } from "vitest";
import {
  chunkMetadataSnapshot,
  DebouncedMetadataCacheWriter,
  reconcileMetadataIndex,
  type MetadataIndexSnapshot,
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
});
