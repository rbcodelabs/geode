import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import {
  METADATA_CACHE_SCHEMA_VERSION,
  MetadataCache,
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
    expect(warm.resolvedLinks.get("A.md")?.get("B.md")).toBe(1);
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
