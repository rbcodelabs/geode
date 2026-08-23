import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import { Vault } from "../../src/renderer/vault";
import type { VaultFileEntry } from "../../src/main/preload";

const ROOT = "/fake/vault";

function installFakeGeode(
  entries: VaultFileEntry[],
  initialContent: Record<string, string> = {},
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
    write: vi.fn(async (path: string, data: string, options?: { mtime?: number; ctime?: number }) => {
      contents.set(path, data);
      // Mirror the real IPC: when a caller pins mtime it is reflected back.
      return { mtime: options?.mtime ?? 20, ctime: options?.ctime ?? 10, size: data.length };
    }),
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
  (globalThis as any).window = { geode };
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
  const vault = new Vault();
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

  it("forwards DataWriteOptions to the IPC write and reflects the pinned mtime on create and modify", async () => {
    const { vault, geode } = await openVault();

    const created = await vault.create("Stamped.md", "body", { mtime: 12345 });
    expect(geode.write).toHaveBeenLastCalledWith("Stamped.md", "body", { mtime: 12345 });
    expect(created.mtime).toBe(12345);

    const existing = vault.getFileByPath("Docs/Note.md")!;
    await vault.modify(existing, "updated", { mtime: 67890 });
    expect(geode.write).toHaveBeenLastCalledWith("Docs/Note.md", "updated", { mtime: 67890 });
    expect(existing.mtime).toBe(67890);
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
