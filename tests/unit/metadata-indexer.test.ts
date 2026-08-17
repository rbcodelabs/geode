import { describe, expect, it, vi } from "vitest";
import {
  DebouncedMetadataCacheWriter,
  reconcileMetadataIndex,
  type MetadataIndexSnapshot,
} from "../../src/indexer/metadata-indexer";

describe("metadata utility-process indexer", () => {
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

    const result = await reconcileMetadataIndex(
      [
        { path: "same.md", mtimeMs: 1, size: 4 },
        { path: "changed.md", mtimeMs: 2, size: 3 },
        { path: "new.md", mtimeMs: 3, size: 9 },
      ],
      persisted,
      read,
      parse,
    );

    expect(read.mock.calls.map(([path]) => path)).toEqual(["changed.md", "new.md"]);
    expect(Object.keys(result.entries).sort()).toEqual(["changed.md", "new.md", "same.md"]);
    expect(result.entries["same.md"]).toBe(persisted.entries["same.md"]);
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
