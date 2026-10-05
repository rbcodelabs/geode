import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultFolderName,
  FolderSelection,
  inspectFolder,
  legacyFolderName,
  listRemoteFolders,
  resolveFolderName,
  sanitizeFolderName,
} from "../../packages/geode-icloud-sync/src/folders";
import { createIcloudProvider } from "../../packages/geode-icloud-sync/src/provider";

let drive: string;
const loc = () => ({ icloudDrive: drive });
const geodeDir = (name: string) => path.join(drive, "Geode", name);
const makeRemote = (name: string, { marker = true, files = [] as string[] } = {}) => {
  fs.mkdirSync(path.join(geodeDir(name), ".geode-sync"), { recursive: true });
  if (marker) fs.writeFileSync(path.join(geodeDir(name), ".geode-sync/marker.json"), "{}");
  for (const f of files) fs.writeFileSync(path.join(geodeDir(name), f), "x");
};

beforeEach(() => {
  drive = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-folders-"));
});
afterEach(() => fs.rmSync(drive, { recursive: true, force: true }));

describe("sanitizeFolderName", () => {
  it("NFC-normalises, strips separators, leading dots and control characters", () => {
    expect(sanitizeFolderName("café")).toBe("café");
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

describe("default and legacy names", () => {
  it("defaults to the vault folder's basename", () => {
    expect(defaultFolderName("/Users/me/Notes/My Vault")).toBe("My Vault");
    expect(defaultFolderName("/Users/me/Notes/My Vault/")).toBe("My Vault");
  });
  it("stays collision-safe when the basename needs sanitising", () => {
    const a = defaultFolderName("/x/Notes:1");
    const b = defaultFolderName("/x/Notes_1");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^Notes_1-[0-9a-f]{8}$/);
  });
  it("keeps the legacy path-derived name byte-for-byte", () => {
    expect(legacyFolderName("/tmp/geode-icloud-test-vault")).toMatch(/^_tmp_geode-icloud-test-vault-[0-9a-f]{8}$/);
  });
});

describe("resolveFolderName", () => {
  const vault = "/Users/me/Notes/My Vault";
  it("uses the chosen folder over everything else", async () => {
    makeRemote(legacyFolderName(vault));
    expect(await resolveFolderName(loc(), vault, "Shared Notes")).toBe("Shared Notes");
  });
  it("sanitises a chosen name defensively", async () => {
    expect(await resolveFolderName(loc(), vault, "../escape")).toBe("_escape");
  });
  it("falls back to the legacy folder only if it already exists", async () => {
    expect(await resolveFolderName(loc(), vault)).toBe("My Vault");
    makeRemote(legacyFolderName(vault));
    expect(await resolveFolderName(loc(), vault)).toBe(legacyFolderName(vault));
  });
});

describe("inspectFolder / listRemoteFolders", () => {
  it("classifies folders", async () => {
    makeRemote("marked");
    makeRemote("unmarked", { marker: false, files: ["note.md"] });
    fs.mkdirSync(geodeDir("empty"), { recursive: true });
    fs.writeFileSync(path.join(geodeDir("empty"), ".DS_Store"), "");
    expect(await inspectFolder(loc(), "marked")).toBe("marked");
    expect(await inspectFolder(loc(), "unmarked")).toBe("unmarked");
    expect(await inspectFolder(loc(), "empty")).toBe("empty");
    expect(await inspectFolder(loc(), "nope")).toBe("missing");
  });
  it("lists only folders carrying the marker", async () => {
    makeRemote("B Vault");
    makeRemote("A Vault");
    makeRemote("random", { marker: false, files: ["x.md"] });
    makeRemote(".hidden");
    expect(await listRemoteFolders(loc())).toEqual(["A Vault", "B Vault"]);
  });
  it("returns an empty list when iCloud Drive/Geode does not exist", async () => {
    expect(await listRemoteFolders(loc())).toEqual([]);
  });
});

describe("FolderSelection", () => {
  function selection(vaultId: string, store: { data: any }, active = false) {
    return new FolderSelection({
      ...loc(),
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
    makeRemote("Other Mac", {});
    fs.mkdirSync(geodeDir("Blank"), { recursive: true });
    expect(await selection("/a/One", store).apply("Docs")).toMatchObject({ ok: false, reason: "not-a-geode-folder" });
    expect(store.data).toBeNull();
    for (const name of ["Other Mac", "Blank", "Brand New"]) expect(await selection("/a/One", store).apply(name)).toMatchObject({ ok: true, name });
  });

  it("rejects empty or unusable names", async () => {
    expect(await selection("/a/One", { data: null }).apply("  ... ")).toMatchObject({ ok: false, reason: "invalid-name" });
  });

  it("preserves unrelated plugin data and other vaults' choices", async () => {
    const store = { data: { other: 1, folders: { "/z": "Z" } } as any };
    await selection("/a/One", store).apply("Shared");
    expect(store.data).toEqual({ other: 1, folders: { "/z": "Z", "/a/One": "Shared" } });
  });
});

describe("provider.open uses the resolved folder", () => {
  const signal = () => new AbortController().signal;
  const open = async (vaultId: string, chosen?: string) => {
    const provider = createIcloudProvider({ icloudDrive: drive, download: async () => {}, chosenFolder: () => chosen });
    return provider.open({ vaultId });
  };

  it("binds two vaults at different local paths to the same chosen remote folder", async () => {
    const mac1 = await open("/Users/one/Notes", "Shared Vault");
    await mac1.create({ path: "a.md", data: new TextEncoder().encode("hi").buffer as ArrayBuffer, operationKey: "k", signal: signal() });
    const mac2 = await open("/Volumes/Other/elsewhere/Vault", "Shared Vault");
    const scan = await mac2.scan(undefined, signal());
    expect(scan.status).toBe("complete");
    expect(scan.entries.map((e) => e.path)).toEqual(["a.md"]);
    expect(fs.readdirSync(path.join(drive, "Geode"))).toEqual(["Shared Vault"]);
  });

  it("uses the basename default for a fresh vault", async () => {
    const session = await open("/Users/one/Notes/My Vault");
    await session.scan(undefined, signal());
    expect(fs.readdirSync(path.join(drive, "Geode"))).toEqual(["My Vault"]);
  });

  it("keeps using an existing legacy path-derived folder when nothing was chosen", async () => {
    const vault = "/tmp/geode-icloud-test-vault";
    makeRemote(legacyFolderName(vault), { files: ["old.md"] });
    const session = await open(vault);
    const scan = await session.scan(undefined, signal());
    expect(scan.entries.map((e) => e.path)).toEqual(["old.md"]);
    expect(fs.readdirSync(path.join(drive, "Geode"))).toEqual([legacyFolderName(vault)]);
  });

  it("a chosen unmarked, non-empty folder is never adopted: the scan stays partial", async () => {
    makeRemote("Docs", { marker: false, files: ["real.md"] });
    const session = await open("/x/V", "Docs");
    expect(await session.scan(undefined, signal())).toMatchObject({ status: "partial", entries: [], errorCode: "icloud-marker-missing" });
    expect(fs.existsSync(path.join(geodeDir("Docs"), ".geode-sync/marker.json"))).toBe(false);
  });
});
