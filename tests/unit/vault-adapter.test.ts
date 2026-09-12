import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../../src/renderer/vault";
import { DataAdapter, FileSystemAdapter } from "../../src/renderer/types";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import type { VaultFileEntry } from "../../src/main/preload";
import { createElectronHost } from "../../src/renderer/host/electron-host";

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
    rmdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => files.has(path)),
    onVaultEvent: vi.fn(() => {}),
  };
  (globalThis as any).window = { geode, hostServices: createElectronHost(geode as any) };
  return { geode, files };
}

async function openTestVault(entries: VaultFileEntry[] = []) {
  const fake = installFakeGeode(entries);
  const vault = new Vault(createElectronHost(fake.geode as any));
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

  it("getResourcePath() percent-encodes characters that would truncate the URL", async () => {
    const { vault } = await openTestVault();
    // `#` starts a fragment and `?` a query string: unescaped, the browser
    // would request "…/photo" and the image would never load.
    expect(vault.adapter.getResourcePath("Board/photo#1.png")).toBe(
      `file://${ROOT}/Board/photo%231.png`
    );
    expect(vault.adapter.getResourcePath("Board/a?b.png")).toBe(`file://${ROOT}/Board/a%3Fb.png`);
    // Separators survive: only the segments are encoded.
    expect(vault.adapter.getResourcePath("a b/c d.png")).toBe(`file://${ROOT}/a%20b/c%20d.png`);
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

  it("uses a non-filesystem DataAdapter on mobile without exposing a POSIX base path", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "mobile" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");

    expect(vault.adapter).toBeInstanceOf(DataAdapter);
    expect(vault.adapter).not.toBeInstanceOf(FileSystemAdapter);
    expect("basePath" in vault.adapter).toBe(false);
    expect("getBasePath" in vault.adapter).toBe(false);
    await expect(vault.adapter.exists("Note.md")).resolves.toBe(true);
  });
});

/**
 * `Vault.getResourcePath(file)` — the `TFile` overload plugins actually call
 * (`kanban-bases-view` uses it for card cover images). Before this existed the
 * call landed on `vault.adapter.getResourcePath(path: string)` only if the
 * plugin reached through `.adapter`; calling it on the vault was a TypeError.
 */
describe("Vault.getResourcePath(file)", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("resolves a TFile to a loadable file:// URL", async () => {
    const { vault } = await openTestVault([
      { path: "Board/cover img.png", isFolder: false, mtime: 1, size: 0 },
    ]);
    const file = vault.getFileByPath("Board/cover img.png")!;
    expect(file).not.toBeNull();
    expect(vault.getResourcePath(file)).toBe(`file://${ROOT}/Board/cover%20img.png`);
  });

  it("throws rather than returning an unloadable URL when there is no filesystem", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "mobile" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    const file = vault.getFileByPath("Note.md")!;

    expect(() => vault.getResourcePath(file)).toThrow(/only available where the vault is backed by the filesystem/);
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

  it("rejects rather than throwing when no rmdir is injected", async () => {
    const adapter = new FileSystemAdapter("/root");
    await expect(adapter.rmdir("Attachments", true)).rejects.toThrow(/not supported on this platform/);
  });
});

/**
 * `adapter.rmdir` did not exist anywhere on Geode's adapter surface, so
 * `app.vault.adapter.rmdir(dir, true)` — what obsidian-claude-threads calls to
 * clean up a thread's attachment folder on hard delete — threw, was swallowed
 * by the plugin, and left the folder on disk forever.
 */
describe("Vault.adapter.rmdir", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("delegates to the host with the recursive flag intact", async () => {
    const { vault, geode } = await openTestVault();

    await vault.adapter.rmdir("Attachments/thread-1", true);

    expect(geode.rmdir).toHaveBeenCalledWith("Attachments/thread-1", true);
  });

  it("defaults to a non-recursive removal when the flag is omitted", async () => {
    const { vault, geode } = await openTestVault();

    await vault.adapter.rmdir("Attachments");

    expect(geode.rmdir).toHaveBeenCalledWith("Attachments", false);
  });

  it("removes a folder and its contents on a host that implements it", async () => {
    const host = createBrowserHost(createBrowserHostState({
      files: { "Attachments/thread-1/a.png": "bytes", "Keep.md": "keep" },
    }));
    const vault = new Vault(host);
    await vault.open("managed://default");

    await vault.adapter.rmdir("Attachments", true);

    await expect(vault.adapter.exists("Attachments/thread-1/a.png")).resolves.toBe(false);
    await expect(vault.adapter.exists("Keep.md")).resolves.toBe(true);
  });

  it("refuses to empty a folder that was not asked to be emptied", async () => {
    const host = createBrowserHost(createBrowserHostState({
      files: { "Attachments/a.png": "bytes" },
    }));
    const vault = new Vault(host);
    await vault.open("managed://default");

    await expect(vault.adapter.rmdir("Attachments", false)).rejects.toThrow(/not empty/);
    await expect(vault.adapter.exists("Attachments/a.png")).resolves.toBe(true);
  });

  it("rejects with a clear message on a host that cannot remove folders", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "x" } }));
    const vault = new Vault({ ...host, vaultFiles: { ...host.vaultFiles, rmdir: undefined } });
    await vault.open("managed://default");

    await expect(vault.adapter.rmdir("Anything", true)).rejects.toThrow(
      /not supported on this platform/,
    );
  });
});
