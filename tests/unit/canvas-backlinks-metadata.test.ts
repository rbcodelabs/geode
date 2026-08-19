import { afterEach, describe, expect, it, vi } from "vitest";
import { METADATA_CACHE_SCHEMA_VERSION, MetadataCache, parseMetadata } from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.unstubAllGlobals());

function canvas(files: string[], text = "[[Notes/Target.md]] and plain Target mention"): string {
  return JSON.stringify({
    vendorDocument: "raw JSON must not become context",
    nodes: [
      ...files.map((file, index) => ({
        id: `file-${index}`,
        type: "file",
        x: index * 240,
        y: 0,
        width: 220,
        height: 120,
        file: file.split("#")[0],
        ...(file.includes("#") ? { subpath: `#${file.split("#").slice(1).join("#")}` } : {}),
      })),
      { id: "text", type: "text", x: 0, y: 180, width: 220, height: 120, text },
    ],
    edges: [],
  });
}

describe("MetadataCache Canvas note-card backlinks", () => {
  it("coexists with a Markdown-only background snapshot and reads Canvas only in the renderer", async () => {
    const targetText = "# Target";
    const fake = new FakeVault({
      "Target.md": targetText,
      "Board.canvas": canvas(["Target.md"]),
    });
    const targetFile = fake.getFileByPath("Target.md")!;
    let deliver: (message: unknown) => void = () => {};
    const api = {
      readMetadataCache: vi.fn(),
      writeMetadataCache: vi.fn(),
      onMetadataIndexerMessage: vi.fn((callback: (message: unknown) => void) => { deliver = callback; }),
      startMetadataIndexer: vi.fn(async () => {
        deliver({ type: "snapshot-start", schemaVersion: METADATA_CACHE_SCHEMA_VERSION, totalEntries: 1 });
        deliver({ type: "snapshot-chunk", sequence: 0, entries: {
          "Target.md": {
            mtimeMs: targetFile.mtime,
            size: targetFile.size,
            content: targetText,
            metadata: parseMetadata(targetText),
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

    expect(readSpy.mock.calls.map(([file]) => file.path)).toEqual(["Board.canvas"]);
    expect(api.readMetadataCache).toHaveBeenCalledOnce();
    expect(api.writeMetadataCache).not.toHaveBeenCalled();
    expect(cache.resolvedLinks["Board.canvas"]?.["Target.md"]).toBe(1);
  });

  it("cold-indexes duplicate resolved note cards with readable context and no Canvas prose metadata", async () => {
    const fake = new FakeVault({
      "Notes/Target.md": "# Target",
      "image.png": "binary fixture",
      "Boards/Board.canvas": canvas(["Notes/Target.md#First", "Notes/Target.md#Second", "image.png"]),
      "Boards/Malformed.canvas": '{"nodes":[',
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const target = fake.getFileByPath("Notes/Target.md")!;
    expect(cache.resolvedLinks["Boards/Board.canvas"]).toEqual({ "Notes/Target.md": 2 });
    expect(cache.resolvedLinks["Boards/Malformed.canvas"] ?? {}).toEqual({});
    expect(cache.getBacklinks(target).map(({ source, count }) => ({ path: source.path, count }))).toEqual([
      { path: "Boards/Board.canvas", count: 2 },
    ]);
    expect(cache.getBacklinksWithContext(target)[0]).toMatchObject({
      count: 2,
      snippets: [
        "Note card: Notes/Target.md#First",
        "Note card: Notes/Target.md#Second",
      ],
    });
    expect(cache.getFileCache(fake.getFileByPath("Boards/Board.canvas")!)).toMatchObject({
      tags: [],
      headings: [],
      aliases: [],
    });
    expect(cache.getUnlinkedMentions(target).map((entry) => entry.source.path)).not.toContain("Boards/Board.canvas");
  });

  it("omits missing non-Markdown file cards from unresolved Canvas backlinks", async () => {
    const fake = new FakeVault({
      "Board.canvas": canvas(["Future.md", "missing.png", "missing.pdf", "missing.bin"]),
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    expect(cache.unresolvedLinks["Board.canvas"]).toEqual({ "Future.md": 1 });
  });

  it("keeps Canvas links correct across unresolved resolution, modify, create, rename, and delete", async () => {
    const fake = new FakeVault({ "Board.canvas": canvas(["Future.md"], "[[Future]]") });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const canvasPerFileEvents: string[] = [];
    for (const event of ["changed", "deleted", "resolve"] as const) {
      cache.on(event, (file?: { path?: string }) => {
        if (file?.path?.endsWith(".canvas")) canvasPerFileEvents.push(`${event}:${file.path}`);
      });
    }
    expect(cache.unresolvedLinks["Board.canvas"]?.["Future.md"]).toBe(1);

    fake.setFile("Future.md", "# Future");
    fake.trigger("create", fake.getFileByPath("Future.md"));
    await settle();
    expect(cache.resolvedLinks["Board.canvas"]?.["Future.md"]).toBe(1);

    fake.setFile("Board.canvas", canvas(["Future.md#One", "Future.md#Two"], "[[Future]]"));
    fake.trigger("modify", fake.getFileByPath("Board.canvas"));
    await settle();
    expect(cache.resolvedLinks["Board.canvas"]?.["Future.md"]).toBe(2);

    const oldTarget = fake.getFileByPath("Future.md")!;
    const targetText = fake.getCachedContent("Future.md")!;
    fake.removeFile("Future.md");
    fake.setFile("Renamed.md", targetText);
    fake.trigger("rename", fake.getFileByPath("Renamed.md"), oldTarget.path);
    await settle();
    expect(cache.resolvedLinks["Board.canvas"]?.["Future.md"]).toBeUndefined();
    expect(cache.unresolvedLinks["Board.canvas"]?.["Future.md"]).toBe(2);

    fake.setFile("Board.canvas", canvas(["Renamed.md#One", "Renamed.md#Two"]));
    fake.trigger("modify", fake.getFileByPath("Board.canvas"));
    await settle();
    expect(cache.resolvedLinks["Board.canvas"]?.["Renamed.md"]).toBe(2);

    const oldCanvas = fake.getFileByPath("Board.canvas")!;
    const boardText = fake.getCachedContent("Board.canvas")!;
    fake.removeFile("Board.canvas");
    fake.setFile("Nested/Board.canvas", boardText);
    fake.trigger("rename", fake.getFileByPath("Nested/Board.canvas"), oldCanvas.path);
    await settle();
    expect(cache.resolvedLinks["Nested/Board.canvas"]?.["Renamed.md"]).toBe(2);
    expect(cache.resolvedLinks["Board.canvas"]).toBeUndefined();

    const renamedTarget = fake.getFileByPath("Renamed.md")!;
    fake.removeFile("Renamed.md");
    fake.trigger("delete", renamedTarget);
    await settle();
    expect(cache.resolvedLinks["Nested/Board.canvas"]?.["Renamed.md"]).toBeUndefined();
    expect(cache.unresolvedLinks["Nested/Board.canvas"]?.["Renamed.md"]).toBe(2);

    const nestedCanvas = fake.getFileByPath("Nested/Board.canvas")!;
    fake.removeFile("Nested/Board.canvas");
    fake.trigger("delete", nestedCanvas);
    await settle();
    expect(cache.resolvedLinks["Nested/Board.canvas"]).toBeUndefined();
    expect(cache.unresolvedLinks["Nested/Board.canvas"]).toBeUndefined();

    fake.setFile("Fresh.canvas", canvas(["Renamed.md"]));
    fake.trigger("create", fake.getFileByPath("Fresh.canvas"));
    await settle();
    expect(cache.unresolvedLinks["Fresh.canvas"]?.["Renamed.md"]).toBe(1);

    fake.setFile("Renamed.md", "# Recreated target");
    fake.trigger("create", fake.getFileByPath("Renamed.md"));
    await settle();
    expect(cache.resolvedLinks["Fresh.canvas"]?.["Renamed.md"]).toBe(1);
    expect(canvasPerFileEvents).toEqual([]);
  });
});
