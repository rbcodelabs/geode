import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../../src/renderer/vault";
import { FileSystemAdapter } from "../../src/renderer/types";
import type { VaultFileEntry } from "../../src/main/preload";

/**
 * Regression coverage for the bug where a plugin's
 * `adapter instanceof FileSystemAdapter` guard (used by
 * obsidian-claude-threads to derive a chat's working directory) resolved
 * `false` in Geode — because `vault.adapter` returned a plain object literal
 * rather than a real `FileSystemAdapter` instance — so the plugin fell back
 * to the home directory instead of the vault root.
 *
 * Mirrors the `installFakeGeode` window-stubbing pattern used by
 * tests/unit/vault-rename-identity.test.ts (this repo's established way of
 * driving `Vault` in a unit test).
 */
const ROOT = "/fake/vault";
const VAULT_NAME = "TestVault";

function installFakeGeode(initialEntries: VaultFileEntry[] = []) {
  const files = new Map<string, string>();
  for (const e of initialEntries) if (!e.isFolder) files.set(e.path, "");

  const geode = {
    openVault: vi.fn(async (vaultPath: string) => ({
      root: vaultPath,
      name: VAULT_NAME,
      files: initialEntries,
    })),
    read: vi.fn(async () => ""),
    write: vi.fn(async () => ({ mtime: Date.now(), size: 0 })),
    mkdir: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => files.has(path)),
    onVaultEvent: vi.fn(() => {}),
  };
  (globalThis as any).window = { geode };
  return { geode, files };
}

async function openTestVault(entries: VaultFileEntry[] = []) {
  const fake = installFakeGeode(entries);
  const vault = new Vault();
  await vault.open(ROOT);
  return { vault, ...fake };
}

describe("Vault.adapter", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("returns a real FileSystemAdapter instance so plugin instanceof guards resolve", async () => {
    const { vault } = await openTestVault();
    expect(vault.adapter instanceof FileSystemAdapter).toBe(true);
  });

  it("getBasePath() and basePath return the vault root", async () => {
    const { vault } = await openTestVault();
    expect(vault.adapter.getBasePath()).toBe(ROOT);
    expect(vault.adapter.basePath).toBe(ROOT);
  });

  it("getResourcePath() space-encodes into a file:// URL under the root", async () => {
    const { vault } = await openTestVault();
    expect(vault.adapter.getResourcePath("a b.md")).toBe(`file://${ROOT}/a%20b.md`);
  });

  it("getName() returns the vault name", async () => {
    const { vault } = await openTestVault();
    expect(vault.adapter.getName()).toBe(VAULT_NAME);
  });

  it("exists() delegates to window.geode.exists", async () => {
    const { vault, geode } = await openTestVault([
      { path: "present.md", isFolder: false, mtime: 1, size: 0 },
    ]);
    await expect(vault.adapter.exists("present.md")).resolves.toBe(true);
    await expect(vault.adapter.exists("missing.md")).resolves.toBe(false);
    expect(geode.exists).toHaveBeenCalledWith("present.md");
  });

  it("memoizes the instance so two successive reads return the same reference", async () => {
    const { vault } = await openTestVault();
    expect(vault.adapter).toBe(vault.adapter);
  });
});

describe("FileSystemAdapter (class directly)", () => {
  it("uses safe defaults when no options are injected", () => {
    const adapter = new FileSystemAdapter("/root");
    expect(adapter instanceof FileSystemAdapter).toBe(true);
    expect(adapter.getBasePath()).toBe("/root");
    expect(adapter.getName()).toBe("");
    expect(adapter.exists("anything")).toBe(false);
    expect(adapter.getResourcePath("a b.md")).toBe("file:///root/a%20b.md");
  });
});
