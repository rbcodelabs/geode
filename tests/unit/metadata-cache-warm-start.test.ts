import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import {
  METADATA_CACHE_SCHEMA_VERSION,
  METADATA_PARSER_VERSION,
  MetadataCache,
} from "../../src/renderer/metadata-cache";

/**
 * The mobile host exposes `startMetadataIndexer` but resolves it to `null`
 * (no background utility process), so the renderer fallback is the indexing
 * path. A warm relaunch must reuse persisted rows whose mtime and size match
 * and read/parse only new or changed files.
 */
const FIXTURE: Record<string, string> = {
  "Home.md": "---\ntitle: Home\ntags: [hub, '#top']\naliases: [Start, Landing]\n---\n# Home\nSee [[Alpha]] and [[Folder/Beta#Section]] and [[Missing Note]].\n![[Alpha]] ![[nothing.png]]\n#inline-tag ^home-block\n",
  "Alpha.md": "# Alpha\n## Section\nBack to [[Home|home]] and [[Start]]. [[Alpha#^blk]]\nA paragraph ^blk\n- [ ] task #todo\n",
  "Folder/Beta.md": "---\naliases: [Bee]\n---\n# Beta\n### Section\nLinks [[Alpha]] [[Bee]] [text](Alpha.md) [[Ghost]]\n",
  "Folder/Gamma.md": "Plain mention of Alpha and Beta without links.\n",
  "Other/Alpha.md": "# Other Alpha\n[[Home]]\n",
};

type Api = {
  readMetadataCache: ReturnType<typeof vi.fn>;
  writeMetadataCache: ReturnType<typeof vi.fn>;
  startMetadataIndexer: ReturnType<typeof vi.fn>;
  onMetadataIndexerMessage: ReturnType<typeof vi.fn>;
};

function installMobileApi(stored: unknown): Api {
  const api: Api = {
    readMetadataCache: vi.fn(async () => stored),
    writeMetadataCache: vi.fn(async () => {}),
    startMetadataIndexer: vi.fn(async () => null),
    onMetadataIndexerMessage: vi.fn(),
  };
  vi.stubGlobal("window", { geode: api });
  return api;
}

async function boot(fake: FakeVault, stored: unknown) {
  const api = installMobileApi(stored);
  const cache = new MetadataCache(fake.asVault());
  await cache.initialize();
  await cache.waitForBackgroundIdle();
  return { api, cache };
}

async function coldPersisted(fake: FakeVault) {
  const { api } = await boot(fake, null);
  expect(api.writeMetadataCache).toHaveBeenCalledOnce();
  return structuredClone(api.writeMetadataCache.mock.calls[0][0]) as any;
}

async function snapshotIndex(fake: FakeVault, cache: MetadataCache) {
  const perFile: Record<string, unknown> = {};
  const backlinks: Record<string, unknown> = {};
  const mentions: Record<string, unknown> = {};
  for (const file of fake.getMarkdownFiles()) {
    perFile[file.path] = cache.getFileCache(file);
    backlinks[file.path] = cache.getBacklinks(file).map((b) => [b.source.path, b.count]);
    mentions[file.path] = (await cache.getUnlinkedMentions(file)).map((m) => [m.source.path, m.mentions.length]);
  }
  return {
    perFile,
    backlinks,
    mentions,
    resolved: structuredClone(cache.resolvedLinks),
    unresolved: structuredClone(cache.unresolvedLinks),
    tags: [...cache.getAllTags()].sort(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("mobile warm start (renderer fallback with a persisted cache)", () => {
  it("does not read, parse or rewrite anything when every file is unchanged", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    const readSpy = vi.spyOn(fake, "cachedRead");
    const { api, cache } = await boot(fake, persisted);
    expect(readSpy).not.toHaveBeenCalled();
    expect(api.writeMetadataCache).not.toHaveBeenCalled();
    expect(cache.isUnlinkedMentionsReady()).toBe(true);
  });

  it("produces an index identical to a fresh parse (links, backlinks, tags, headings, blocks, aliases, mentions)", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    const fresh = await boot(fake, null);
    const readSpy = vi.spyOn(fake, "cachedRead");
    const warm = await boot(fake, persisted);
    expect(readSpy).not.toHaveBeenCalled();
    const expected = await snapshotIndex(fake, fresh.cache);
    expect(await snapshotIndex(fake, warm.cache)).toEqual(expected);
    // Sanity: the fixture really exercises the interesting shapes.
    expect(Object.keys(expected.unresolved["Home.md"])).toContain("Missing Note");
    expect(expected.resolved["Alpha.md"]).toHaveProperty("Home.md");
    expect(expected.tags.length).toBeGreaterThan(0);
  });

  it("reads only new and changed files, drops deleted ones, and stays identical to a fresh parse", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    fake.setFile("Alpha.md", "# Alpha edited\n[[Folder/Beta]] #newtag\n", { mtime: Date.now() + 5000 });
    fake.removeFile("Folder/Gamma.md");
    fake.setFile("Fresh.md", "# Fresh\n[[Alpha]]\n");
    const readSpy = vi.spyOn(fake, "cachedRead");
    const warm = await boot(fake, persisted);
    expect(readSpy.mock.calls.map(([f]) => f.path).sort()).toEqual(["Alpha.md", "Fresh.md"]);
    const written = warm.api.writeMetadataCache.mock.calls[0][0] as any;
    expect(Object.keys(written.entries).sort()).toEqual(
      ["Alpha.md", "Folder/Beta.md", "Fresh.md", "Home.md", "Other/Alpha.md"],
    );
    const fresh = await boot(fake, null);
    expect(await snapshotIndex(fake, warm.cache)).toEqual(await snapshotIndex(fake, fresh.cache));
  });

  it("requires strict mtime and size equality (older mtime, newer mtime and size-only changes all re-read)", async () => {
    const fake = new FakeVault({ "a.md": "# a", "b.md": "# b", "c.md": "# c", "d.md": "# d" });
    const persisted = await coldPersisted(fake);
    const mtime = (p: string) => fake.getFileByPath(p)!.mtime;
    fake.setFile("a.md", "# a", { mtime: mtime("a.md") - 1 });
    fake.setFile("b.md", "# b", { mtime: mtime("b.md") + 1 });
    fake.setFile("c.md", "# cc", { mtime: mtime("c.md") });
    const readSpy = vi.spyOn(fake, "cachedRead");
    await boot(fake, persisted);
    expect(readSpy.mock.calls.map(([f]) => f.path).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("re-parses rows persisted without mention keys", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    delete persisted.entries["Home.md"].mentionKeys;
    const readSpy = vi.spyOn(fake, "cachedRead");
    const { cache } = await boot(fake, persisted);
    expect(readSpy.mock.calls.map(([f]) => f.path)).toEqual(["Home.md"]);
    expect(cache.isUnlinkedMentionsReady()).toBe(true);
  });

  it("stamps the parser version and re-parses everything when it differs, and accepts an unstamped baseline", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    expect(persisted.schemaVersion).toBe(METADATA_CACHE_SCHEMA_VERSION);
    expect(persisted.parserVersion).toBe(METADATA_PARSER_VERSION);
    const stale = structuredClone(persisted);
    stale.parserVersion = METADATA_PARSER_VERSION + 1;
    const readSpy = vi.spyOn(fake, "cachedRead");
    const { api } = await boot(fake, stale);
    expect(readSpy).toHaveBeenCalledTimes(Object.keys(FIXTURE).length);
    expect((api.writeMetadataCache.mock.calls[0][0] as any).parserVersion).toBe(METADATA_PARSER_VERSION);
    readSpy.mockClear();
    const baseline = structuredClone(persisted);
    delete baseline.parserVersion;
    await boot(fake, baseline);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("does not trust a partially written cache (a corrupt row rejects the whole snapshot)", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    persisted.entries["Alpha.md"] = { mtimeMs: persisted.entries["Alpha.md"].mtimeMs };
    const readSpy = vi.spyOn(fake, "cachedRead");
    await boot(fake, persisted);
    expect(readSpy).toHaveBeenCalledTimes(Object.keys(FIXTURE).length);
  });

  it("ignores rows for paths that are not in the vault (cache for the wrong vault)", async () => {
    const fake = new FakeVault({ "x.md": "# x" });
    const other = new FakeVault({ "y.md": "# y\n[[z]]" });
    const persisted = await coldPersisted(other);
    const readSpy = vi.spyOn(fake, "cachedRead");
    const { api, cache } = await boot(fake, persisted);
    expect(readSpy.mock.calls.map(([f]) => f.path)).toEqual(["x.md"]);
    expect(Object.keys((api.writeMetadataCache.mock.calls[0][0] as any).entries)).toEqual(["x.md"]);
    expect(cache.resolvedLinks["y.md"]).toBeUndefined();
  });

  it("serves cached metadata before any file is read, and a live edit during the pass wins", async () => {
    const fake = new FakeVault(FIXTURE);
    const persisted = await coldPersisted(fake);
    fake.setFile("Home.md", "# Home changed\n", { mtime: Date.now() + 9000 });
    const api = installMobileApi(persisted);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    // Unchanged notes are usable immediately; the changed one is not yet trusted.
    expect(cache.getCache("Alpha.md")?.headings[0].heading).toBe("Alpha");
    expect(cache.getCache("Home.md")).toBeNull();
    await cache.waitForBackgroundIdle();
    expect(cache.getCache("Home.md")?.headings[0].heading).toBe("Home changed");
    expect(api.writeMetadataCache).toHaveBeenCalledOnce();
  });

  it("never persists a row for a path whose incremental update is still in flight", async () => {
    const fake = new FakeVault({ "A.md": "# A", "B.md": "# B" });
    const { api, cache } = await boot(fake, null);
    api.writeMetadataCache.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realRead = fake.cachedRead.bind(fake);
    vi.spyOn(fake, "cachedRead").mockImplementation(async (file) => { await gate; return realRead(file); });
    fake.setFile("B.md", "# B edited", { mtime: Date.now() + 7000 });
    fake.trigger("modify", fake.getFileByPath("B.md"));
    await Promise.resolve();
    await (cache as unknown as { persistCache(): Promise<void> }).persistCache();
    const mid = api.writeMetadataCache.mock.calls[0][0] as any;
    expect(Object.keys(mid.entries)).toEqual(["A.md"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (cache as unknown as { persistCache(): Promise<void> }).persistCache();
    const end = api.writeMetadataCache.mock.calls[1][0] as any;
    expect(Object.keys(end.entries).sort()).toEqual(["A.md", "B.md"]);
  });
});
