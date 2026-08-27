import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import {
  METADATA_CACHE_SCHEMA_VERSION,
  MetadataCache,
  extractMentionIndexKeys,
  parseMetadata,
} from "../../src/renderer/metadata-cache";

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
        "A.md": { mtimeMs: file.mtime, size: file.size, content: "# Warm", metadata: parseMetadata("# Warm") },
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
        "Source.md": { mtimeMs: source.mtime, size: source.size, content, metadata: parseMetadata(content) },
        "Target.md": { mtimeMs: target.mtime, size: target.size, content: "# Target", metadata: parseMetadata("# Target") },
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
    expect(cache.getUnlinkedMentions(target)).toEqual([]);
    resolveWorker(true);
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
          "A.md": { mtimeMs: initial.mtime, size: initial.size, content: "# Old", metadata: parseMetadata("# Old") },
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
      entry: { mtimeMs: 2, size: 5, content: "# New", metadata: parseMetadata("# New") },
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
          "A.md": { mtimeMs: 1, size: 5, content: "# Old", metadata: parseMetadata("# Old") },
        } });
        fake.setFile("A.md", "# New");
        fake.trigger("modify", fake.getFileByPath("A.md"));
        deliver({ type: "delta", path: "A.md", entry: {
          mtimeMs: 2, size: 5, content: "# New", metadata: parseMetadata("# New"),
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
