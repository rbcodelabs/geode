import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import { Vault, type DataWriteOptions } from "../../src/renderer/vault";
import type { VaultFileEntry } from "../../src/main/preload";
import { createElectronHost } from "../../src/renderer/host/electron-host";

const ROOT = "/fake/vault";

function installFakeGeode(
  entries: VaultFileEntry[],
  initialContent: Record<string, string> = {},
  writeImpl?: (
    path: string,
    data: string,
    options?: DataWriteOptions,
  ) => Promise<{ mtime: number; ctime: number; size: number }>,
) {
  const contents = new Map(Object.entries(initialContent));
  const folders = new Set(entries.filter((entry) => entry.isFolder).map((entry) => entry.path));
  let eventCallback: ((event: { event: string; path: string }) => void) | undefined;
  const geode = {
    openVault: vi.fn(async () => ({ root: ROOT, name: "Knowledge", files: entries })),
    read: vi.fn(async (path: string) => {
      const value = contents.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    }),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    write: vi.fn(
      writeImpl ??
        (async (path: string, data: string, options?: DataWriteOptions) => {
          contents.set(path, data);
          return { mtime: options?.mtime ?? 20, ctime: 10, size: data.length };
        }),
    ),
    mkdir: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    trash: vi.fn(async () => {}),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (contents.has(oldPath)) {
        const value = contents.get(oldPath)!;
        contents.delete(oldPath);
        contents.set(newPath, value);
      }
    }),
    exists: vi.fn(async (path: string) => contents.has(path) || folders.has(path)),
    onVaultEvent: vi.fn((callback: typeof eventCallback) => {
      eventCallback = callback;
    }),
  };
  (globalThis as any).window = { geode, hostServices: createElectronHost(geode as any) };
  return { contents, folders, geode, emit: (event: { event: string; path: string }) => eventCallback?.(event) };
}

async function openVault() {
  const entries: VaultFileEntry[] = [
    { path: "Docs", isFolder: true, mtime: 1, ctime: 1, size: 0 },
    { path: "Docs/Note.md", isFolder: false, mtime: 2, ctime: 1, size: 5 },
    { path: "image.png", isFolder: false, mtime: 3, ctime: 1, size: 4 },
  ];
  const fake = installFakeGeode(entries, {
    "Docs/Note.md": "first",
    "image.png": "data",
  });
  const vault = new Vault(createElectronHost(fake.geode as any));
  await vault.open(ROOT);
  return { vault, ...fake };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe("Vault query and read contracts", () => {
  it("returns the vault name, root, files, Markdown files, and typed path lookups", async () => {
    const { vault } = await openVault();

    expect(vault.getName()).toBe("Knowledge");
    expect(vault.getRoot()).toBe(vault.getFolderByPath("/"));
    expect(vault.getFiles().map((file) => file.path).sort()).toEqual([
      "Docs/Note.md",
      "image.png",
    ]);
    expect(vault.getMarkdownFiles().map((file) => file.path)).toEqual([
      "Docs/Note.md",
    ]);
    expect(vault.getFileByPath("Docs/Note.md")?.kind).toBe("file");
    expect(vault.getFolderByPath("Docs")?.kind).toBe("folder");
    expect(vault.getAbstractFileByPath("Docs/Note.md")?.kind).toBe("file");
    expect(vault.getAbstractFileByPath("Docs")?.kind).toBe("folder");
    expect(vault.getFileByPath("Docs")).toBeNull();
    expect(vault.getFolderByPath("Docs/Note.md")).toBeNull();
    expect(vault.getAbstractFileByPath("docs/note.md")).toBeNull();
  });

  it("cachedRead reuses content while read goes directly to disk and refreshes the cache", async () => {
    const { vault, contents, geode } = await openVault();
    const file = vault.getFileByPath("Docs/Note.md")!;

    await expect(vault.cachedRead(file)).resolves.toBe("first");
    contents.set(file.path, "second");
    await expect(vault.cachedRead(file)).resolves.toBe("first");
    expect(geode.read).toHaveBeenCalledTimes(1);

    await expect(vault.read(file)).resolves.toBe("second");
    expect(geode.read).toHaveBeenCalledTimes(2);
    await expect(vault.cachedRead(file)).resolves.toBe("second");
    expect(geode.read).toHaveBeenCalledTimes(2);
  });
});

describe("Vault mutation and event contracts", () => {
  it("emits create for each existing file and folder while the vault loads", async () => {
    const entries: VaultFileEntry[] = [
      { path: "Folder", isFolder: true, mtime: 1, ctime: 1, size: 0 },
      { path: "Folder/Note.md", isFolder: false, mtime: 1, ctime: 1, size: 4 },
    ];
    installFakeGeode(entries, { "Folder/Note.md": "body" });
    const vault = new Vault();
    const created: string[] = [];
    vault.on("create", (file: any) => created.push(file.path));

    await vault.open(ROOT);
    expect(created).toEqual(["Folder", "Folder/Note.md"]);
  });

  it("creates a file, returns it, emits create, and rejects an existing path", async () => {
    const { vault, contents } = await openVault();
    const created: string[] = [];
    vault.on("create", (file: any) => created.push(file.path));

    const file = await vault.create("New.md", "hello");
    expect(file).toBe(vault.getFileByPath("New.md"));
    expect(contents.get("New.md")).toBe("hello");
    expect(created).toEqual(["New.md"]);
    await expect(vault.create("New.md", "again")).rejects.toThrow(/already exists/i);
  });

  it("creates and returns a folder, emits create, and rejects an existing folder", async () => {
    const { vault } = await openVault();
    const created: string[] = [];
    vault.on("create", (file: any) => created.push(file.path));

    const folder = await vault.createFolder("Projects");
    expect(folder).toBe(vault.getFolderByPath("Projects"));
    expect(created).toEqual(["Projects"]);
    await expect(vault.createFolder("Projects")).rejects.toThrow(/already exists/i);
  });

  it("modifies a file, updates its metadata/cache, and emits modify", async () => {
    const { vault } = await openVault();
    const file = vault.getFileByPath("Docs/Note.md")!;
    const modified: unknown[] = [];
    vault.on("modify", (changed) => modified.push(changed));

    await vault.modify(file, "updated");
    expect(file.mtime).toBe(20);
    expect(file.size).toBe(7);
    await expect(vault.cachedRead(file)).resolves.toBe("updated");
    expect(modified).toEqual([file]);
  });

  it("renames the held file object and emits its old path", async () => {
    const { vault } = await openVault();
    const file = vault.getFileByPath("Docs/Note.md")!;
    const renamed: Array<[unknown, string]> = [];
    vault.on("rename", (changed, oldPath) => renamed.push([changed, String(oldPath)]));

    await vault.rename(file, "Docs/Renamed.md");
    expect(file.path).toBe("Docs/Renamed.md");
    expect(renamed).toEqual([[file, "Docs/Note.md"]]);
  });

  it("forwards DataWriteOptions through create() and pins the returned TFile's mtime", async () => {
    const { vault, geode } = await openVault();
    const options: DataWriteOptions = { mtime: 1_600_000_000_000 };

    const file = await vault.create("Pinned.md", "hello", options);

    expect(geode.write).toHaveBeenCalledWith("Pinned.md", "hello", options);
    expect(file.mtime).toBe(1_600_000_000_000);
  });

  it("forwards DataWriteOptions through modify() and pins the file's mtime", async () => {
    const { vault, geode } = await openVault();
    const file = vault.getFileByPath("Docs/Note.md")!;
    const options: DataWriteOptions = { mtime: 1_700_000_000_000 };

    await vault.modify(file, "updated", options);

    expect(geode.write).toHaveBeenCalledWith("Docs/Note.md", "updated", options);
    expect(file.mtime).toBe(1_700_000_000_000);
  });

  it("propagates a create() rejection and never indexes the file into the vault", async () => {
    const entries: VaultFileEntry[] = [];
    const failingWrite = vi.fn(async () => {
      throw new Error("Invalid DataWriteOptions.mtime: NaN");
    });
    installFakeGeode(entries, {}, failingWrite);
    const vault = new Vault();
    await vault.open(ROOT);
    const created: string[] = [];
    vault.on("create", (file: any) => created.push(file.path));

    await expect(vault.create("Bad.md", "hello", { mtime: NaN })).rejects.toThrow(
      /Invalid DataWriteOptions/,
    );

    expect(vault.getAbstractFileByPath("Bad.md")).toBeNull();
    expect(vault.getFiles().map((f) => f.path)).not.toContain("Bad.md");
    expect(created).toEqual([]);
  });

  it("propagates a modify() rejection and leaves the file's cached content/metadata untouched", async () => {
    const failingWrite = vi.fn(async () => {
      throw new Error("Invalid DataWriteOptions.mtime: NaN");
    });
    const entries: VaultFileEntry[] = [
      { path: "Docs/Note.md", isFolder: false, mtime: 2, ctime: 1, size: 5 },
    ];
    installFakeGeode(entries, { "Docs/Note.md": "first" }, failingWrite);
    const vault = new Vault();
    await vault.open(ROOT);
    const file = vault.getFileByPath("Docs/Note.md")!;
    const modified: unknown[] = [];
    vault.on("modify", (changed) => modified.push(changed));

    await expect(vault.modify(file, "updated", { mtime: NaN })).rejects.toThrow(
      /Invalid DataWriteOptions/,
    );

    expect(file.mtime).toBe(2);
    await expect(vault.cachedRead(file)).resolves.toBe("first");
    expect(modified).toEqual([]);
  });
});

describe("Vault through plugin require('obsidian')", () => {
  it("exposes the selected query/read foundation to CommonJS plugins", async () => {
    installFakeGeode(
      [{ path: "Note.md", isFolder: false, mtime: 1, ctime: 1, size: 4 }],
      { "Note.md": "body" },
    );
    const PluginClass = instantiatePluginClass(
      `
        const { Vault } = require("obsidian");
        module.exports = class VaultProbe {
          static results = (async () => {
            const vault = new Vault();
            await vault.open("/fake/vault");
            const file = vault.getFileByPath("Note.md");
            return [vault.getName(), vault.getRoot().kind, vault.getFiles().length, await vault.cachedRead(file)];
          })();
        };
      `,
      "vault-probe",
    ) as unknown as { results: Promise<unknown[]> };

    await expect(PluginClass.results).resolves.toEqual([
      "Knowledge",
      "folder",
      1,
      "body",
    ]);
  });
});
