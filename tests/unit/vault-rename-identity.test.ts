import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../../src/renderer/vault";
import { withPathLock } from "../../src/main/path-lock";
import type { VaultFileEntry } from "../../src/main/preload";
import { createElectronHost } from "../../src/renderer/host/electron-host";

/**
 * Minimal in-memory `window.geode` stand-in, just enough surface for
 * `Vault` to drive: `openVault`, `write`, `rename`, `mkdir`, `read`, and
 * `onVaultEvent` (no-op — these tests only exercise renderer-side calls,
 * not the file-watcher event path). Mirrors the `installFakeGeode` pattern
 * in tests/unit/plugin-manager.test.ts, which is this repo's established
 * way of mocking `window.geode` in a unit test.
 */
function installFakeGeode(initialEntries: VaultFileEntry[] = []) {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  for (const e of initialEntries) {
    if (e.isFolder) folders.add(e.path);
    else files.set(e.path, "");
  }

  const geode = {
    openVault: vi.fn(async (vaultPath: string) => ({
      root: vaultPath,
      name: "TestVault",
      files: initialEntries,
    })),
    read: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      return content;
    }),
    write: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
      return { mtime: Date.now(), size: data.length };
    }),
    mkdir: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    trash: vi.fn(async () => {}),
    rename: vi.fn(async (from: string, to: string) => {
      if (files.has(from)) {
        const content = files.get(from)!;
        files.delete(from);
        files.set(to, content);
        return;
      }
      if (folders.has(from)) {
        // Real fs.rename on a directory moves the whole subtree in one
        // atomic op — mirror that by re-keying every descendant.
        folders.delete(from);
        folders.add(to);
        for (const p of [...files.keys()]) {
          if (p.startsWith(from + "/")) {
            const content = files.get(p)!;
            files.delete(p);
            files.set(to + p.slice(from.length), content);
          }
        }
        for (const p of [...folders.keys()]) {
          if (p.startsWith(from + "/")) {
            folders.delete(p);
            folders.add(to + p.slice(from.length));
          }
        }
        return;
      }
      // Mirror a real fs ENOENT if the caller renames something that's
      // already been moved — this is the exact failure mode the
      // in-place-mutation fix prevents.
      throw new Error(
        `Error invoking remote method 'vault-rename': Error: ENOENT: no such file or directory, rename '${from}' -> '${to}'`
      );
    }),
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    onVaultEvent: vi.fn(() => {}),
  };
  (globalThis as any).window = { geode, hostServices: createElectronHost(geode as any) };
  return { geode, files, folders };
}

async function openTestVault(entries: VaultFileEntry[] = []) {
  const fake = installFakeGeode(entries);
  const vault = new Vault(createElectronHost(fake.geode as any));
  await vault.open("/fake/vault");
  return { vault, ...fake };
}

describe("Vault.rename identity", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("mutates the SAME TFile object reference on rename rather than replacing it", async () => {
    const { vault } = await openTestVault([
      { path: "old.md", isFolder: false, mtime: 1, size: 0 },
    ]);
    const file = vault.getFileByPath("old.md")!;
    expect(file).toBeTruthy();

    await vault.rename(file, "new.md");

    // Same object reference, mutated in place.
    expect(file.path).toBe("new.md");
    expect(file.name).toBe("new.md");
    expect(file.basename).toBe("new");
    expect(file.extension).toBe("md");
    expect(file.parent).toBe("");

    expect(vault.getFileByPath("old.md")).toBeNull();
    expect(vault.getFileByPath("new.md")).toBe(file);
  });

  it("lets vault.modify() succeed against the new path using the ORIGINAL held reference (regression for the ENOENT bug)", async () => {
    const { vault, files } = await openTestVault([
      { path: "old.md", isFolder: false, mtime: 1, size: 0 },
    ]);
    // Simulate a plugin (e.g. obsidian-claude-threads' VaultPersistence)
    // holding a TFile reference across a rename and reusing it.
    const heldRef = vault.getFileByPath("old.md")!;

    await vault.rename(heldRef, "new.md");

    // Reusing the exact object passed into rename() — this must NOT throw
    // ENOENT, and must write to the new path, not the stale old one.
    await expect(vault.modify(heldRef, "updated content")).resolves.toBeUndefined();

    expect(files.get("new.md")).toBe("updated content");
    expect(files.has("old.md")).toBe(false);
    expect(heldRef.path).toBe("new.md");
  });

  it("mutates a folder object and every descendant file object in place on folder rename", async () => {
    const { vault } = await openTestVault([
      { path: "Notes", isFolder: true, mtime: 0, size: 0 },
      { path: "Notes/A.md", isFolder: false, mtime: 1, size: 0 },
      { path: "Notes/Sub", isFolder: true, mtime: 0, size: 0 },
      { path: "Notes/Sub/B.md", isFolder: false, mtime: 1, size: 0 },
    ]);

    const folder = vault.getFolderByPath("Notes")!;
    const fileA = vault.getFileByPath("Notes/A.md")!;
    const fileB = vault.getFileByPath("Notes/Sub/B.md")!;
    const subFolder = vault.getFolderByPath("Notes/Sub")!;

    await vault.rename(folder, "Archive");

    // Same object references, mutated in place.
    expect(folder.path).toBe("Archive");
    expect(subFolder.path).toBe("Archive/Sub");
    expect(fileA.path).toBe("Archive/A.md");
    expect(fileB.path).toBe("Archive/Sub/B.md");

    // Findable at their new paths via getAbstractFileByPath.
    expect(vault.getAbstractFileByPath("Archive")).toBe(folder);
    expect(vault.getAbstractFileByPath("Archive/Sub")).toBe(subFolder);
    expect(vault.getAbstractFileByPath("Archive/A.md")).toBe(fileA);
    expect(vault.getAbstractFileByPath("Archive/Sub/B.md")).toBe(fileB);

    // Old paths no longer resolve.
    expect(vault.getAbstractFileByPath("Notes")).toBeNull();
    expect(vault.getAbstractFileByPath("Notes/A.md")).toBeNull();
    expect(vault.getAbstractFileByPath("Notes/Sub/B.md")).toBeNull();
  });
});

describe("withPathLock", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("serializes two overlapping calls locked on the same path", async () => {
    const events: string[] = [];

    // A deferred promise for call A's body, so we control exactly when it
    // resolves and can prove call B doesn't start until then.
    let resolveA: () => void;
    const aGate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    const callA = withPathLock(["/vault/note.md"], async () => {
      events.push("A:start");
      await aGate;
      events.push("A:end");
    });

    // Give call A a chance to start before queuing call B.
    await Promise.resolve();
    await Promise.resolve();

    const callB = withPathLock(["/vault/note.md"], async () => {
      events.push("B:start");
    });

    // At this point B must NOT have started yet — it's queued behind A.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["A:start"]);

    resolveA!();
    await callA;
    await callB;

    expect(events).toEqual(["A:start", "A:end", "B:start"]);
  });

  it("does not serialize calls on unrelated paths", async () => {
    const events: string[] = [];
    let resolveA: () => void;
    const aGate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    const callA = withPathLock(["/vault/one.md"], async () => {
      events.push("A:start");
      await aGate;
      events.push("A:end");
    });

    await Promise.resolve();
    await Promise.resolve();

    const callB = withPathLock(["/vault/two.md"], async () => {
      events.push("B:start");
    });

    await callB;
    // B on an unrelated path runs without waiting for A.
    expect(events).toEqual(["A:start", "B:start"]);

    resolveA!();
    await callA;
  });
});
