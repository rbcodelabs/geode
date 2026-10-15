import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../../src/renderer/vault";
import { createElectronHost } from "../../src/renderer/host/electron-host";
import type { TAbstractFile } from "../../src/renderer/types";

const ROOT = "/synthetic/vault";
async function openVault(bytes = new Uint8Array([0, 255, 254, 128, 192, 175])) {
  const contents = new Map<string, Uint8Array>([["attachment.bin", bytes]]);
  const geode = {
    openVault: vi.fn(async () => ({ root: ROOT, name: "Synthetic", files: [
      { path: "Docs", isFolder: true, mtime: 1, ctime: 1, size: 0 },
      { path: "Docs/Sub", isFolder: true, mtime: 1, ctime: 1, size: 0 },
      { path: "Docs/Sub/Note.md", isFolder: false, mtime: 1, ctime: 1, size: 0 },
      { path: "attachment.bin", isFolder: false, mtime: 2, ctime: 1, size: bytes.byteLength },
    ] })),
    read: vi.fn(async (path: string) => new TextDecoder().decode(contents.get(path))),
    readBinary: vi.fn(async (path: string) => new Uint8Array(contents.get(path)!).buffer),
    write: vi.fn(async (path: string, value: string) => { const data = new TextEncoder().encode(value); contents.set(path, data); return { mtime: 90, ctime: 80, size: data.byteLength }; }),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => { const data = new Uint8Array(value.slice(0)); contents.set(path, data); return { mtime: 90, ctime: 80, size: data.byteLength }; }),
    exists: vi.fn(async (path: string) => contents.has(path)),
    onVaultEvent: vi.fn(),
  };
  const host = createElectronHost(geode as any);
  (globalThis as any).window = { geode, hostServices: host };
  const vault = new Vault(host); await vault.open(ROOT);
  return { vault, contents, geode };
}
afterEach(() => { delete (globalThis as any).window; });

describe("Vault.copy bytes", () => {
  it("preserves nulls, invalid UTF-8 and high bytes and emits one indexed create", async () => {
    const bytes = new Uint8Array([0, 255, 254, 128, 192, 175]);
    const { vault, contents, geode } = await openVault(bytes);
    const events: TAbstractFile[] = []; vault.on("create", file => events.push(file));
    const copy = await vault.copy(vault.getFileByPath("attachment.bin")!, "Docs/copied.bin");
    expect([...contents.get(copy.path)!]).toEqual([...bytes]);
    expect(geode.read).not.toHaveBeenCalled(); expect(geode.write).not.toHaveBeenCalled();
    expect(copy).toBe(vault.getFileByPath("Docs/copied.bin"));
    expect(copy.stat).toEqual({ mtime: 90, ctime: 80, size: bytes.length });
    expect(vault.getFolderByPath("Docs")!.children).toContain(copy);
    expect(events).toEqual([copy]);
  });
  it.each([new Uint8Array(), new Uint8Array([239, 187, 191, ...new TextEncoder().encode("# Café\r\n\r\n[[Note]]\r\n")])])("preserves empty and BOM Markdown byte streams", async bytes => {
    const { vault, contents } = await openVault(bytes);
    const copy = await vault.copy(vault.getFileByPath("attachment.bin")!, "copy.md");
    expect([...contents.get(copy.path)!]).toEqual([...bytes]);
    expect(copy.size).toBe(bytes.byteLength);
  });
  it("rejects existing file/folder destinations before any read or write", async () => {
    const { vault, geode } = await openVault();
    const source = vault.getFileByPath("attachment.bin")!;
    for (const path of ["attachment.bin", "Docs"]) await expect(vault.copy(source, path)).rejects.toThrow("already exists");
    expect(geode.readBinary).not.toHaveBeenCalled(); expect(geode.writeBinary).not.toHaveBeenCalled();
  });
  it("propagates read failures without publishing or indexing a copy", async () => {
    const { vault, geode, contents } = await openVault();
    geode.readBinary.mockRejectedValue(new Error("source unavailable"));
    const created = vi.fn(); vault.on("create", created);
    await expect(vault.copy(vault.getFileByPath("attachment.bin")!, "copy.bin")).rejects.toThrow("source unavailable");
    expect(geode.writeBinary).not.toHaveBeenCalled(); expect(vault.getFileByPath("copy.bin")).toBeNull();
    expect(contents.has("copy.bin")).toBe(false); expect(created).not.toHaveBeenCalled();
  });
  it("propagates write failures without emitting create or indexing a copy", async () => {
    const { vault, geode } = await openVault(); geode.writeBinary.mockRejectedValue(new Error("disk full"));
    const created = vi.fn(); vault.on("create", created);
    await expect(vault.copy(vault.getFileByPath("attachment.bin")!, "copy.bin")).rejects.toThrow("disk full");
    expect(vault.getFileByPath("copy.bin")).toBeNull(); expect(created).not.toHaveBeenCalled();
  });
  it("retains the explicit folder-copy rejection", async () => {
    const { vault, geode } = await openVault();
    await expect(vault.copy(vault.getRoot() as any, "new-root")).rejects.toThrow("only supports files");
    expect(geode.readBinary).not.toHaveBeenCalled();
  });
});

describe("Vault.recurseChildren", () => {
  it("visits the root before descendants with each folder and file exactly once", async () => {
    const { vault } = await openVault();
    const visits: TAbstractFile[] = [];
    Vault.recurseChildren(vault.getRoot(), file => visits.push(file));
    expect(visits.map(file => file.path)).toEqual(["", "Docs", "Docs/Sub", "Docs/Sub/Note.md", "attachment.bin"]);
    expect(new Set(visits).size).toBe(visits.length);
  });
  it("visits an empty starting folder once", () => {
    const root = { kind: "folder", path: "Empty", name: "Empty", parent: "", children: [] } as const;
    const visit = vi.fn(); Vault.recurseChildren(root as any, visit);
    expect(visit).toHaveBeenCalledExactlyOnceWith(root);
  });
});
