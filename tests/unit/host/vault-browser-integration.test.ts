import { describe, expect, it } from "vitest";
import { createBrowserHost, createBrowserHostState, type BrowserHostStorage } from "../../../src/renderer/host/browser-host";
import type { HostServices, VaultEvent } from "../../../src/renderer/host/contracts";
import { Vault } from "../../../src/renderer/vault";

function withDelayedMutationEcho(base: HostServices, delayMs: number): HostServices {
  const listeners = new Set<(event: VaultEvent) => void>();
  const pending = new Map<string, Promise<void>[]>();
  base.vaultFiles.onChange((event) => {
    const delivery = new Promise<void>((resolve) => {
      setTimeout(() => {
        listeners.forEach((listener) => listener(event));
        resolve();
      }, delayMs);
    });
    if (event.mutationId) pending.set(event.mutationId, [...(pending.get(event.mutationId) ?? []), delivery]);
  });
  return {
    ...base,
    vaultFiles: {
      ...base.vaultFiles,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      settleMutation: async (mutationId) => {
        await Promise.all(pending.get(mutationId) ?? []);
        pending.delete(mutationId);
      },
    },
  };
}

describe("Vault with BrowserHost mutation correlation", () => {
  it("suppresses echoes delayed beyond one second until recursive mutations settle", async () => {
    const base = createBrowserHost(createBrowserHostState({ files: {
      "Folder/A.md": "cached-a",
      "Folder/Nested/B.md": "cached-b",
    } }));
    await base.vaultRegistry.openVault("managed://default");
    await base.vaultFiles.mkdir("Folder");
    await base.vaultFiles.mkdir("Folder/Nested");
    const vault = new Vault(withDelayedMutationEcho(base, 1_100));
    await vault.open("managed://default");
    const folder = vault.getFolderByPath("Folder")!;
    const nested = vault.getFolderByPath("Folder/Nested")!;
    const first = vault.getFileByPath("Folder/A.md")!;
    const second = vault.getFileByPath("Folder/Nested/B.md")!;
    await vault.cachedRead(first);
    await vault.cachedRead(second);
    const events: string[] = [];
    vault.on("rename", (item: { path: string }, oldPath: string) => events.push(`rename:${oldPath}->${item.path}`));
    vault.on("delete", (item: { path: string }) => events.push(`delete:${item.path}`));

    await vault.rename(folder, "Archive");
    expect(vault.getFolderByPath("Archive/Nested")).toBe(nested);
    expect(vault.getFileByPath("Archive/A.md")).toBe(first);
    expect(vault.getFileByPath("Archive/Nested/B.md")).toBe(second);
    await expect(vault.cachedRead(first)).resolves.toBe("cached-a");
    await expect(vault.cachedRead(second)).resolves.toBe("cached-b");
    await vault.trash(folder);
    await new Promise((resolve) => setTimeout(resolve, 1_150));

    expect(events).toEqual([
      "rename:Folder->Archive",
      "rename:Folder/A.md->Archive/A.md",
      "rename:Folder/Nested/B.md->Archive/Nested/B.md",
      "delete:Archive",
    ]);
    expect(vault.getFileByPath("Archive/A.md")).toBeNull();
    expect(vault.getFolderByPath("Archive/Nested")).toBeNull();
  });

  it("emits exactly one semantic event for each app-originated file mutation", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Seed.md": "seed" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    const events: string[] = [];
    vault.on("create", (file: { path: string }) => events.push(`create:${file.path}`));
    vault.on("modify", (file: { path: string }) => events.push(`modify:${file.path}`));
    vault.on("rename", (file: { path: string }, oldPath: string) => events.push(`rename:${oldPath}->${file.path}`));
    vault.on("delete", (file: { path: string }) => events.push(`delete:${file.path}`));

    const created = await vault.create("New.md", "one");
    await vault.modify(created, "two");
    await vault.rename(created, "Renamed.md");
    await vault.trash(created);

    expect(events).toEqual([
      "create:New.md",
      "modify:New.md",
      "rename:New.md->Renamed.md",
      "delete:Renamed.md",
    ]);
  });

  it("preserves held folder and descendant identities while emitting each rename once", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: {
      "Folder/A.md": "A",
      "Folder/Nested/B.md": "B",
    } }));
    await host.vaultRegistry.openVault("managed://default");
    await host.vaultFiles.mkdir("Folder");
    await host.vaultFiles.mkdir("Folder/Nested");
    const vault = new Vault(host);
    await vault.open("managed://default");
    const folder = vault.getFolderByPath("Folder")!;
    const nested = vault.getFolderByPath("Folder/Nested")!;
    const first = vault.getFileByPath("Folder/A.md")!;
    const second = vault.getFileByPath("Folder/Nested/B.md")!;
    const renames: string[] = [];
    vault.on("rename", (item: { path: string }, oldPath: string) => renames.push(`${oldPath}->${item.path}`));

    await vault.rename(folder, "Archive");

    expect(vault.getFolderByPath("Archive")).toBe(folder);
    expect(vault.getFolderByPath("Archive/Nested")).toBe(nested);
    expect(vault.getFileByPath("Archive/A.md")).toBe(first);
    expect(vault.getFileByPath("Archive/Nested/B.md")).toBe(second);
    expect(renames).toEqual([
      "Folder->Archive",
      "Folder/A.md->Archive/A.md",
      "Folder/Nested/B.md->Archive/Nested/B.md",
    ]);
  });

  it("still applies uncorrelated external host events", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "one" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    let modifications = 0;
    vault.on("modify", () => { modifications += 1; });

    await host.vaultFiles.write("Note.md", "external");

    expect(modifications).toBe(1);
    await expect(vault.cachedRead(vault.getFileByPath("Note.md")!)).resolves.toBe("external");
  });

  it("coalesces duplicate uncorrelated provider notifications into one semantic event", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "one" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    let modifications = 0;
    vault.on("modify", () => { modifications += 1; });

    await Promise.all([
      host.vaultFiles.write("Note.md", "external"),
      host.vaultFiles.write("Note.md", "external"),
    ]);
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(modifications).toBe(1);
    await expect(vault.cachedRead(vault.getFileByPath("Note.md")!)).resolves.toBe("external");
  });

  it("coalesces a provider create plus immediate modify into one create", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Seed.md": "seed" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    const events: string[] = [];
    vault.on("create", (file: { path: string }) => events.push(`create:${file.path}`));
    vault.on("modify", (file: { path: string }) => events.push(`modify:${file.path}`));

    await Promise.all([
      host.vaultFiles.write("External.md", "first"),
      host.vaultFiles.write("External.md", "final"),
    ]);
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(events).toEqual(["create:External.md"]);
    await expect(vault.cachedRead(vault.getFileByPath("External.md")!)).resolves.toBe("final");
  });

  it("does not rediscover an acknowledged own write as an external reconciliation change", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "one" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    await vault.modify(vault.getFileByPath("Note.md")!, "own-write");

    await expect(vault.reconcile()).resolves.toMatchObject({ status: "complete", changes: [] });
  });

  it("retains an existing cold-launch manifest until reconciliation commits", async () => {
    const values = new Map<string, string>();
    const storage: BrowserHostStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const state = createBrowserHostState({ files: { "Note.md": "one" }, storage });
    const first = createBrowserHost(state);
    const initial = new Vault(first);
    await initial.open("managed://default");
    await initial.close();

    await first.vaultRegistry.openVault("managed://default");
    await first.vaultFiles.write("Note.md", "externally changed");
    const restarted = new Vault(createBrowserHost(state));
    await restarted.open("managed://default");

    const staged = await restarted.reconcile();
    expect(staged.changes).toEqual([expect.objectContaining({ event: "modify", path: "Note.md" })]);
  });

  it("atomically applies opposite-kind replacements without retaining stale descendants", async () => {
    const state = createBrowserHostState({ files: {
      FileBecomesFolder: "old-file",
      "FolderBecomesFile/Child.md": "old-child",
    } });
    state.folders.set("FolderBecomesFile", { ctime: 1, mtime: 1 });
    const host = createBrowserHost(state);
    const vault = new Vault(host);
    await vault.open("managed://default");
    const events: string[] = [];
    vault.on("delete", (item: { kind: string; path: string }) => events.push(`delete:${item.kind}:${item.path}`));
    vault.on("create", (item: { kind: string; path: string }) => events.push(`create:${item.kind}:${item.path}`));

    state.files.delete("FileBecomesFolder");
    state.folders.set("FileBecomesFolder", { ctime: 2, mtime: 2 });
    state.files.set("FileBecomesFolder/Child.md", { data: "new-child", ctime: 2, mtime: 2 });
    state.folders.delete("FolderBecomesFile");
    state.files.delete("FolderBecomesFile/Child.md");
    state.files.set("FolderBecomesFile", { data: "new-file", ctime: 2, mtime: 2 });

    const staged = await vault.reconcile();
    expect(staged.status).toBe("complete");
    expect(staged.manifest).toBeDefined();
    for (const change of staged.changes) vault.applyReconcileChange(change);
    await vault.commitReconcileManifest(staged.manifest!);

    expect(vault.getAbstractFileByPath("FileBecomesFolder")?.kind).toBe("folder");
    expect(vault.getAbstractFileByPath("FileBecomesFolder/Child.md")?.kind).toBe("file");
    expect(vault.getAbstractFileByPath("FolderBecomesFile")?.kind).toBe("file");
    expect(vault.getAbstractFileByPath("FolderBecomesFile/Child.md")).toBeNull();
    expect(events).toEqual([
      "delete:file:FileBecomesFolder",
      "create:folder:FileBecomesFolder",
      "create:file:FileBecomesFolder/Child.md",
      "delete:folder:FolderBecomesFile",
      "create:file:FolderBecomesFile",
    ]);
  });
});

describe("BrowserHost atomic rename collisions", () => {
  it("rejects file-to-file collision without changing either file", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "A.md": "A", "B.md": "B" } }));
    await host.vaultRegistry.openVault("managed://default");

    await expect(host.vaultFiles.rename("A.md", "B.md")).rejects.toThrow("already exists");
    await expect(host.vaultFiles.read("A.md")).resolves.toBe("A");
    await expect(host.vaultFiles.read("B.md")).resolves.toBe("B");
  });

  it("rejects folder-to-folder collision without changing either subtree", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: {
      "Source/A.md": "A",
      "Target/B.md": "B",
    } }));
    await host.vaultRegistry.openVault("managed://default");
    await host.vaultFiles.mkdir("Source");
    await host.vaultFiles.mkdir("Target");

    await expect(host.vaultFiles.rename("Source", "Target")).rejects.toThrow("already exists");
    await expect(host.vaultFiles.read("Source/A.md")).resolves.toBe("A");
    await expect(host.vaultFiles.read("Target/B.md")).resolves.toBe("B");
  });

  it("rejects descendant destination collision atomically", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: {
      "Source/Nested/A.md": "source",
      "Archive/Nested/A.md": "existing",
    } }));
    await host.vaultRegistry.openVault("managed://default");
    await host.vaultFiles.mkdir("Source");
    await host.vaultFiles.mkdir("Source/Nested");

    await expect(host.vaultFiles.rename("Source", "Archive")).rejects.toThrow("already exists");
    await expect(host.vaultFiles.read("Source/Nested/A.md")).resolves.toBe("source");
    await expect(host.vaultFiles.read("Archive/Nested/A.md")).resolves.toBe("existing");
  });
});
