import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../../src/renderer/vault";
import { createElectronHost } from "../../src/renderer/host/electron-host";

const ROOT = "/fake/vault";

async function openVault() {
  const writes: { path: string; bytes: number[] }[] = [];
  const geode = {
    openVault: vi.fn(async () => ({ root: ROOT, name: "Knowledge", files: [] })),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      writes.push({ path, bytes: [...new Uint8Array(data)] });
      return { mtime: 20, ctime: 10, size: data.byteLength };
    }),
    exists: vi.fn(async () => false),
    onVaultEvent: vi.fn(),
  };
  (globalThis as any).window = { geode, hostServices: createElectronHost(geode as any) };
  const vault = new Vault(createElectronHost(geode as any));
  await vault.open(ROOT);
  return { vault, geode, writes };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe("Vault.createBinary", () => {
  it("writes the bytes, indexes the file under its folder and fires create", async () => {
    const { vault, writes } = await openVault();
    const created: string[] = [];
    vault.on("create", (file: { path: string }) => created.push(file.path));

    const file = await vault.createBinary("assets/pic.png", new Uint8Array([1, 2, 3]).buffer);

    expect(writes).toEqual([{ path: "assets/pic.png", bytes: [1, 2, 3] }]);
    expect(file.path).toBe("assets/pic.png");
    expect(file.extension).toBe("png");
    expect(file.size).toBe(3);
    expect(vault.getFileByPath("assets/pic.png")).toBe(file);
    expect(vault.getFolderByPath("assets")?.children.map((child) => child.path)).toEqual(["assets/pic.png"]);
    expect(created).toEqual(["assets/pic.png"]);
  });

  it("refuses to overwrite an existing file", async () => {
    const { vault, geode } = await openVault();
    await vault.createBinary("pic.png", new ArrayBuffer(1));
    await expect(vault.createBinary("pic.png", new ArrayBuffer(1))).rejects.toThrow("File already exists: pic.png");
    expect(geode.writeBinary).toHaveBeenCalledTimes(1);
  });
});
