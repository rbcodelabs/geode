import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultFolderName, resolveFolderName, sanitizeFolderName } from "../../src/renderer/internal-plugins/icloud-sync/folders";
import { FolderSelection, inspectFolder, listRemoteFolders } from "../../src/renderer/internal-plugins/icloud-sync/folder-selection";
import { createIcloudProvider } from "../../src/renderer/internal-plugins/icloud-sync/provider";
import { createFakeHarness, createNodeHarness, type IcloudHarness } from "../helpers/icloud-harness";

describe("sanitizeFolderName", () => {
  it("NFC-normalises, strips separators, leading dots and control characters", () => {
    expect(sanitizeFolderName("café")).toBe("café");
    expect(sanitizeFolderName("a/b\\c:d")).toBe("a_b_c_d");
    expect(sanitizeFolderName("../../etc")).toBe("_.._etc");
    expect(sanitizeFolderName(".hidden")).toBe("hidden");
    expect(sanitizeFolderName("  ..  My Vault  ")).toBe("My Vault");
    expect(sanitizeFolderName("a\u0000b\nc")).toBe("a_b_c");
    expect(sanitizeFolderName("x".repeat(200))).toHaveLength(80);
  });
  it("yields an empty string when nothing usable remains", () => {
    expect(sanitizeFolderName("")).toBe("");
    expect(sanitizeFolderName("...")).toBe("");
    expect(sanitizeFolderName("   ")).toBe("");
  });
  it("never produces a name that can traverse or hide", () => {
    for (const raw of ["..", ".", "../x", "/abs", "a/../b", ".geode"]) {
      const name = sanitizeFolderName(raw);
      expect(name).not.toMatch(/[/\\]/);
      expect(name.startsWith(".")).toBe(false);
    }
  });
});

describe("default names", () => {
  it("defaults to the vault folder's basename", async () => {
    expect(await defaultFolderName("/Users/me/Notes/My Vault")).toBe("My Vault");
    expect(await defaultFolderName("/Users/me/Notes/My Vault/")).toBe("My Vault");
  });
  it("stays collision-safe when the basename needs sanitising", async () => {
    const a = await defaultFolderName("/x/Notes:1");
    const b = await defaultFolderName("/x/Notes_1");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^Notes_1-[0-9a-f]{8}$/);
  });
});

describe("resolveFolderName", () => {
  const vault = "/Users/me/Notes/My Vault";
  it("uses the chosen folder over the default", async () => {
    expect(await resolveFolderName(vault, "Shared Notes")).toBe("Shared Notes");
  });
  it("sanitises a chosen name defensively", async () => {
    expect(await resolveFolderName(vault, "../escape")).toBe("_escape");
  });
  it("falls back to the basename default when nothing usable was chosen", async () => {
    expect(await resolveFolderName(vault)).toBe("My Vault");
    expect(await resolveFolderName(vault, "...")).toBe("My Vault");
  });
});

describe.each([
  ["fake bridge", createFakeHarness],
  ["node fs bridge", createNodeHarness],
] as Array<[string, () => IcloudHarness]>)("folder selection over the %s", (_name, makeHarness) => {
  let h: IcloudHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  const makeRemote = (name: string, { marker = true, files = [] as string[] } = {}) => {
    if (marker) h.putRaw(".geode-sync/marker.json", "{}", name);
    else h.mkdirRaw("", name);
    for (const f of files) h.putRaw(f, "x", name);
  };

  describe("inspectFolder / listRemoteFolders", () => {
    it("classifies folders", async () => {
      makeRemote("marked");
      makeRemote("unmarked", { marker: false, files: ["note.md"] });
      h.mkdirRaw("", "empty");
      h.putRaw(".DS_Store", "", "empty");
      expect(await inspectFolder(h.bridge, "marked")).toBe("marked");
      expect(await inspectFolder(h.bridge, "unmarked")).toBe("unmarked");
      expect(await inspectFolder(h.bridge, "empty")).toBe("empty");
      expect(await inspectFolder(h.bridge, "nope")).toBe("missing");
    });
    it("lists only folders carrying the marker, sorted, skipping hidden folders", async () => {
      makeRemote("B Vault");
      makeRemote("A Vault");
      makeRemote("random", { marker: false, files: ["x.md"] });
      h.mkdirRaw("", ".hidden");
      expect(await listRemoteFolders(h.bridge)).toEqual(["A Vault", "B Vault"]);
    });
    it("returns an empty list when the container has no remotes yet", async () => {
      expect(await listRemoteFolders(h.bridge)).toEqual([]);
    });
    it("counts a marker that is still evicted as marked rather than as a foreign folder", async () => {
      h.mkdirRaw("", "evicted-marker");
      h.evict(".geode-sync/marker.json", "evicted-marker");
      expect(await inspectFolder(h.bridge, "evicted-marker")).toBe("marked");
    });
  });

  describe("FolderSelection", () => {
    function selection(vaultId: string, store: { data: any }, active = false) {
      return new FolderSelection({
        bridge: h.bridge,
        vaultId,
        load: async () => store.data,
        save: async (d) => void (store.data = d),
        isActive: () => active,
      });
    }

    it("persists the choice per vault id and defaults others to their basename", async () => {
      const store = { data: null as any };
      expect(await selection("/a/One", store).apply("Shared")).toEqual({ ok: true, name: "Shared", changed: false });
      expect(await selection("/a/One", store).effective()).toBe("Shared");
      expect(await selection("/b/Two", store).effective()).toBe("Two");
      expect(store.data).toEqual({ folders: { "/a/One": "Shared" } });
    });

    it("flags when the saved name differs from what was typed", async () => {
      const store = { data: null as any };
      expect(await selection("/a/One", store).apply(".a/b")).toEqual({ ok: true, name: "a_b", changed: true });
    });

    it("refuses changes while the provider is active and persists nothing", async () => {
      const store = { data: null as any };
      const result = await selection("/a/One", store, true).apply("Shared");
      expect(result).toMatchObject({ ok: false, reason: "active" });
      expect(store.data).toBeNull();
    });

    it("refuses a non-empty folder that lacks the marker, but accepts marked, empty and new ones", async () => {
      const store = { data: null as any };
      makeRemote("Docs", { marker: false, files: ["real.md"] });
      makeRemote("Other Mac");
      h.mkdirRaw("", "Blank");
      expect(await selection("/a/One", store).apply("Docs")).toMatchObject({ ok: false, reason: "not-a-geode-folder" });
      expect(store.data).toBeNull();
      for (const name of ["Other Mac", "Blank", "Brand New"]) expect(await selection("/a/One", store).apply(name)).toMatchObject({ ok: true, name });
    });

    it("rejects empty or unusable names", async () => {
      expect(await selection("/a/One", { data: null }).apply("  ... ")).toMatchObject({ ok: false, reason: "invalid-name" });
    });

    it("reports an unavailable container instead of throwing", async () => {
      h.makeUnavailable();
      expect(await selection("/a/One", { data: null }).apply("Shared")).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("preserves unrelated data and other vaults' choices", async () => {
      const store = { data: { other: 1, folders: { "/z": "Z" } } as any };
      await selection("/a/One", store).apply("Shared");
      expect(store.data).toEqual({ other: 1, folders: { "/z": "Z", "/a/One": "Shared" } });
    });
  });

  describe("provider.open uses the resolved folder", () => {
    const signal = () => new AbortController().signal;
    const open = async (vaultId: string, chosen?: string) => createIcloudProvider({ bridge: h.bridge, chosenFolder: () => chosen }).open({ vaultId });

    it("binds two vaults at different local paths to the same chosen remote folder", async () => {
      const dev1 = await open("/Users/one/Notes", "Shared Vault");
      await dev1.create({ path: "a.md", data: new TextEncoder().encode("hi").buffer as ArrayBuffer, operationKey: "k", signal: signal() });
      const dev2 = await open("/Volumes/Other/elsewhere/Vault", "Shared Vault");
      const scan = await dev2.scan(undefined, signal());
      expect(scan.status).toBe("complete");
      expect(scan.entries.map((e) => e.path)).toEqual(["a.md"]);
      expect(h.roots()).toEqual(["Shared Vault"]);
    });

    it("uses the basename default for a fresh vault", async () => {
      const session = await open("/Users/one/Notes/My Vault");
      await session.scan(undefined, signal());
      expect(h.roots()).toEqual(["My Vault"]);
    });

    it("a chosen unmarked, non-empty folder is never adopted: the scan stays partial", async () => {
      makeRemote("Docs", { marker: false, files: ["real.md"] });
      const session = await open("/x/V", "Docs");
      expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", entries: [], errorCode: "icloud-marker-missing" });
      expect(h.exists(".geode-sync/marker.json", "Docs")).toBe(false);
    });
  });
});
