import { describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import type { HostServices, VaultEvent } from "../../src/renderer/host/contracts";
import { Vault } from "../../src/renderer/vault";

async function open() {
  const base = createBrowserHost(createBrowserHostState({ files: { "Existing/zed.md": "z", "Existing/Alpha.md": "a" } }));
  await base.vaultRegistry.openVault("managed://default");
  let emit: (event: VaultEvent) => void = () => {};
  const host: HostServices = { ...base, vaultFiles: { ...base.vaultFiles, onChange: listener => { emit = listener; return () => {}; } } };
  const vault = new Vault(host);
  await vault.open("managed://default");
  const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
  return { vault, event: async (event: VaultEvent) => { emit(event); await flush(); } };
}
const names = (vault: Vault, folder: string) => vault.getFolderByPath(folder)!.children.map(child => child.name);

describe("host change events keep the child index incrementally", () => {
  it("creates ancestors, keeps folders-first case-insensitive order, and unlinks on delete", async () => {
    const { vault, event } = await open();
    await event({ event: "create", path: "Existing/beta.md" });
    await event({ event: "create", path: "Existing/Sub/deep/note.md" });
    await event({ event: "create-folder", path: "Existing/Aaa" });
    expect(names(vault, "Existing")).toEqual(["Aaa", "Sub", "Alpha.md", "beta.md", "zed.md"]);
    expect(names(vault, "Existing/Sub")).toEqual(["deep"]);
    expect(vault.getFolderByPath("Existing/Sub/deep")!.children.map(child => child.path)).toEqual(["Existing/Sub/deep/note.md"]);
    expect(vault.getFolderByPath("")!.children.map(child => child.name)).toEqual(["Existing"]);
    await event({ event: "delete", path: "Existing/beta.md" });
    expect(names(vault, "Existing")).toEqual(["Aaa", "Sub", "Alpha.md", "zed.md"]);
  });

  it("creating many files never re-sorts the whole vault (it did once per file)", async () => {
    const { vault, event } = await open();
    const sort = vi.spyOn(Array.prototype, "sort");
    try {
      for (let index = 0; index < 300; index++) await event({ event: "create", path: `Bulk/F${index % 10}/note ${index}.md` });
      // Each created file inserts into one sorted children array; no full-vault sort runs.
      expect(sort).toHaveBeenCalledTimes(0);
    } finally { sort.mockRestore(); }
    expect(vault.getFolderByPath("Bulk")!.children).toHaveLength(10);
    expect(vault.getFolderByPath("Bulk/F3")!.children).toHaveLength(30);
    const sorted = vault.getFolderByPath("Bulk/F3")!.children.map(child => child.name);
    expect(sorted).toEqual([...sorted].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });
});
