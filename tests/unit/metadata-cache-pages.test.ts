import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import { MetadataCache, parseMetadata } from "../../src/renderer/metadata-cache";
afterEach(() => vi.unstubAllGlobals());
describe("paged cache hydration", () => {
  it("does not gate cold layout on omitted-file reads and recovers them in background one file per yield", async () => {
    const vault = new FakeVault({ "A.md": "# A", "B.md": "# B", "C.md": "# C" });
    let release!: (text: string) => void;
    const read = vi.spyOn(vault, "cachedRead").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const yields: number[] = [];
    const OriginalChannel = MessageChannel;
    vi.stubGlobal("MessageChannel", class extends OriginalChannel {
      constructor() { super(); const post = this.port2.postMessage.bind(this.port2); this.port2.postMessage = (...args: Parameters<MessagePort["postMessage"]>) => { yields.push(read.mock.calls.length); post(...args); }; }
    });
    const api = { beginMetadataCacheRead: async () => ({ token: "t", schemaVersion: 1 }), readMetadataCachePage: async () => ({ schemaVersion: 1, sequence: 0, entries: {}, done: true }), cancelMetadataCacheRead: async () => {}, startMetadataIndexer: async () => true };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault()); let ready = false;
    const pending = cache.initialize().then(() => { ready = true; });
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      await vi.waitFor(() => expect(ready).toBe(true));
    } finally { release("# A"); await pending; await cache.waitForBackgroundIdle(); }
    expect(yields.slice(0, 2)).toEqual([1, 2]);
    expect(cache.getFileCache(vault.getFileByPath("C.md")!)?.headings[0].heading).toBe("C");
  });
  it("applies pages without the legacy bulk read or waiting for utility completion", async () => {
    const vault = new FakeVault({ "A.md": "# Live" });
    const file = vault.getFileByPath("A.md")!;
    const api = {
      beginMetadataCacheRead: vi.fn(async () => ({ token: "t", schemaVersion: 1 })),
      readMetadataCachePage: vi.fn(async () => ({ schemaVersion: 1, sequence: 0, entries: { "A.md": { mtimeMs: file.mtime, size: file.size, metadata: parseMetadata("# Stored") } }, done: true })),
      cancelMetadataCacheRead: vi.fn(async () => {}), readMetadataCache: vi.fn(),
      startMetadataIndexer: vi.fn(() => new Promise(() => {})),
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault());
    await cache.initialize();
    expect(cache.getFileCache(file)?.headings[0].heading).toBe("Stored");
    expect(api.readMetadataCache).not.toHaveBeenCalled();
    expect(api.cancelMetadataCacheRead).toHaveBeenCalledWith("t");
  });
  it("recovers omitted unchanged files even with a successful changed-only utility", async () => {
    const vault = new FakeVault({ "A.md": "# Recovered" });
    const api = {
      beginMetadataCacheRead: vi.fn(async () => ({ token: "t", schemaVersion: 1 })),
      readMetadataCachePage: vi.fn(async () => ({ schemaVersion: 1, sequence: 0, entries: {}, done: true })),
      cancelMetadataCacheRead: vi.fn(async () => {}), readMetadataCache: vi.fn(), startMetadataIndexer: vi.fn(async () => true),
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault());
    const resolved = vi.fn(); cache.on("resolve", resolved);
    await cache.initialize(); await cache.waitForBackgroundIdle();
    expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("Recovered");
    expect(api.readMetadataCache).not.toHaveBeenCalled();
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ path: "A.md" }));
  });
  it("does not replace an already-applied live entry when a fallback read finishes", async () => {
    const vault = new FakeVault({ "A.md": "# Old" });
    let release!: (text: string) => void;
    const read = vi.spyOn(vault, "cachedRead").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const api = { beginMetadataCacheRead: async () => ({ token: "t", schemaVersion: 1 }), readMetadataCachePage: async () => ({ schemaVersion: 1, sequence: 0, entries: {}, done: true }), cancelMetadataCacheRead: async () => {}, startMetadataIndexer: async () => true };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault()); await cache.initialize();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    // Simulate another authoritative applicator; no raw vault event/tombstone.
    (cache as any).cache.set("A.md", parseMetadata("# Live"));
    release("# Old"); await cache.waitForBackgroundIdle();
    expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("Live");
  });
  it("recovers a failed advertised stream without retrying the unbounded API", async () => {
    const vault = new FakeVault({ "A.md": "# Recovered" });
    const api = {
      beginMetadataCacheRead: vi.fn(async () => ({ token: "t", schemaVersion: 1 })),
      readMetadataCachePage: vi.fn(async () => { throw Error("expired"); }),
      cancelMetadataCacheRead: vi.fn(async () => {}), readMetadataCache: vi.fn(), startMetadataIndexer: vi.fn(async () => true),
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault()); await cache.initialize(); await cache.waitForBackgroundIdle();
    expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("Recovered");
    expect(api.readMetadataCache).not.toHaveBeenCalled(); expect(api.readMetadataCachePage).toHaveBeenCalledOnce();
  });
  it("never overwrites live edits or resurrects deleted and renamed paths across pages", async () => {
    const vault = new FakeVault({ "A.md": "# Old", "B.md": "# Deleted", "C.md": "# Renamed" });
    const originals = vault.getMarkdownFiles();
    const stored = Object.fromEntries(originals.map(f => [f.path, { mtimeMs: f.mtime, size: f.size, metadata: parseMetadata("# Stale") }]));
    let release!: (value: unknown) => void;
    const api = {
      beginMetadataCacheRead: async () => ({ token: "t", schemaVersion: 1 }),
      readMetadataCachePage: vi.fn(async (_token: string, sequence: number) => sequence === 0
        ? { schemaVersion: 1, sequence, entries: {}, done: false }
        : new Promise(resolve => { release = resolve; })),
      cancelMetadataCacheRead: async () => {},
    };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault()); const pending = cache.initialize();
    await vi.waitFor(() => expect(api.readMetadataCachePage).toHaveBeenCalledTimes(2));
    vault.setFile("A.md", "# New", { mtime: originals[0].mtime });
    vault.trigger("modify", vault.getFileByPath("A.md"));
    vault.removeFile("B.md"); vault.trigger("delete", originals[1]);
    vault.removeFile("C.md"); vault.setFile("D.md", "# Renamed"); vault.trigger("rename", vault.getFileByPath("D.md"), "C.md");
    await vi.waitFor(() => expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("New"));
    release({ schemaVersion: 1, sequence: 1, entries: stored, done: true }); await pending;
    expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("New");
    expect(cache.getFileCache(originals[1])).toBeNull(); expect(cache.getFileCache(originals[2])).toBeNull();
    expect(cache.getFileCache(vault.getFileByPath("D.md")!)?.headings[0].heading).toBe("Renamed");
  });
  it("rechecks membership and live mutation after an asynchronous fallback read", async () => {
    const vault = new FakeVault({ "A.md": "# Old" });
    let release!: (text: string) => void;
    const originalRead = vault.cachedRead.bind(vault);
    const read = vi.spyOn(vault, "cachedRead").mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockImplementation(originalRead);
    const api = { beginMetadataCacheRead: async () => ({ token: "t", schemaVersion: 1 }), readMetadataCachePage: async () => ({ schemaVersion: 1, sequence: 0, entries: {}, done: true }), cancelMetadataCacheRead: async () => {} };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault()); const pending = cache.initialize();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    vault.setFile("A.md", "# New"); vault.trigger("modify", vault.getFileByPath("A.md"));
    await vi.waitFor(() => expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("New"));
    release("# Old"); await pending;
    expect(cache.getFileCache(vault.getFileByPath("A.md")!)?.headings[0].heading).toBe("New");
  });
  it("cancels an in-flight stream on dispose without applying its late page", async () => {
    const vault = new FakeVault({ "A.md": "# Old" });
    const file = vault.getFileByPath("A.md")!;
    let release!: (value: unknown) => void;
    const api = { beginMetadataCacheRead: async () => ({ token: "t", schemaVersion: 1 }), readMetadataCachePage: vi.fn(() => new Promise(resolve => { release = resolve; })), cancelMetadataCacheRead: vi.fn(async () => {}) };
    vi.stubGlobal("window", { geode: api });
    const cache = new MetadataCache(vault.asVault()); const pending = cache.initialize();
    await vi.waitFor(() => expect(api.readMetadataCachePage).toHaveBeenCalledOnce());
    cache.dispose(); expect(api.cancelMetadataCacheRead).toHaveBeenCalledWith("t");
    release({ schemaVersion: 1, sequence: 0, entries: { "A.md": { mtimeMs: file.mtime, size: file.size, metadata: parseMetadata("# Late") } }, done: true });
    await pending; expect(cache.getFileCache(file)).toBeNull();
  });
});
