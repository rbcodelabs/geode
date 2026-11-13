import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { FileManager } from "../../src/renderer/file-manager";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { pathName, pathParent, splitExt } from "../../src/renderer/types";

/** Minimal in-memory vault with the surface `App.moveVaultPath` uses. */
function fakeVault(initial: Record<string, string>, extraDiskOnly: string[] = []) {
  const files = new Map<string, any>();
  const folders = new Set<string>();
  const content = new Map<string, string>();
  const addFolder = (path: string) => { for (let p = path; p; p = pathParent(p)) folders.add(p); };
  const makeFile = (path: string) => {
    const { basename, extension } = splitExt(pathName(path));
    return { kind: "file", path, name: pathName(path), basename, extension, parent: pathParent(path) };
  };
  for (const [path, text] of Object.entries(initial)) { files.set(path, makeFile(path)); content.set(path, text); addFolder(pathParent(path)); }
  const writes: string[] = [];
  const vault: any = {
    files, folders, content, writes,
    getAbstractFileByPath: (p: string) => files.get(p) ?? (folders.has(p) ? { kind: "folder", path: p, name: pathName(p) } : null),
    getFileByPath: (p: string) => files.get(p) ?? null,
    getFiles: () => [...files.values()],
    getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === "md"),
    adapter: { exists: async (p: string) => files.has(p) || folders.has(p) || extraDiskOnly.includes(p) },
    createFolder: vi.fn(async (p: string) => { addFolder(p); writes.push(`mkdir ${p}`); }),
    read: async (f: any) => content.get(f.path)!,
    modify: vi.fn(async (f: any, text: string) => { content.set(f.path, text); writes.push(`modify ${f.path}`); }),
    rename: vi.fn(async (item: any, to: string) => {
      const from = item.path;
      writes.push(`rename ${from} -> ${to}`);
      const move = (old: string, next: string) => {
        const file = files.get(old); files.delete(old);
        Object.assign(file, makeFile(next)); files.set(next, file);
        content.set(next, content.get(old)!); content.delete(old);
      };
      if (item.kind === "file") move(from, to);
      else for (const p of [...files.keys()]) if (p.startsWith(from + "/")) move(p, to + p.slice(from.length));
    }),
  };
  return vault;
}

function fakeApp(vault: any, leaves: unknown[] = []) {
  return Object.assign(Object.create(App.prototype), {
    vault,
    notify: vi.fn(),
    metadataCache: { getCache: () => null },
    workspace: { iterateLeaves: (visit: (leaf: unknown) => void) => leaves.forEach(visit) },
  }) as App;
}

const VAULT = () => ({
  "Projects/Alpha/Note.md": "[[Other]] [o](Other.md) [b](../Beta/B.md)",
  "Projects/Alpha/Other.md": "back [[Projects/Alpha/Note]]",
  "Projects/Beta/B.md": "[[Projects/Alpha/Note|alias]] ![[Projects/Alpha/pic.png]]",
  "Projects/Alpha/pic.png": "bin",
  "Unrelated.md": "[[Other]] nothing to see",
});

describe("App.moveVaultPath", () => {
  it("moves a folder, rewrites exactly the affected notes and reports them", async () => {
    const vault = fakeVault(VAULT());
    const app = fakeApp(vault);
    const result = await app.moveVaultPath("Projects/Alpha", "Archive/Alpha");
    expect(result).toEqual({
      moved: [{ from: "Projects/Alpha", to: "Archive/Alpha" }],
      updatedNotes: ["Archive/Alpha/Note.md", "Archive/Alpha/Other.md", "Projects/Beta/B.md"],
    });
    expect(vault.content.get("Archive/Alpha/Note.md")).toBe("[[Other]] [o](Other.md) [b](../../Projects/Beta/B.md)");
    expect(vault.content.get("Archive/Alpha/Other.md")).toBe("back [[Archive/Alpha/Note]]");
    expect(vault.content.get("Projects/Beta/B.md")).toBe("[[Archive/Alpha/Note|alias]] ![[Archive/Alpha/pic.png]]");
    expect(vault.content.get("Unrelated.md")).toBe("[[Other]] nothing to see");
    // missing parent folder created before the rename; no other writes
    expect(vault.writes[0]).toBe("mkdir Archive");
    expect(vault.writes.filter((w: string) => w.startsWith("modify")).sort()).toEqual([
      "modify Archive/Alpha/Note.md", "modify Archive/Alpha/Other.md", "modify Projects/Beta/B.md",
    ]);
  });

  it("renames a single file and reports no updated notes when nothing needed rewriting", async () => {
    const vault = fakeVault(VAULT());
    const result = await fakeApp(vault).moveVaultPath("Unrelated.md", "Moved/Unrelated.md");
    expect(result).toEqual({ moved: [{ from: "Unrelated.md", to: "Moved/Unrelated.md" }], updatedNotes: [] });
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it.each([
    ["absolute", "Unrelated.md", "/etc/x.md", /vault-relative/],
    ["dotdot", "Unrelated.md", "../x.md", /\.\./],
    ["missing source", "Nope.md", "x.md", /does not exist/],
    ["folder into itself", "Projects/Alpha", "Projects/Alpha/Sub", /into itself/],
    ["existing target (index)", "Unrelated.md", "Projects/Beta/B.md", /already exists/],
    ["existing folder target", "Unrelated.md", "Projects", /already exists/],
    ["target parent is a file", "Unrelated.md", "Projects/Beta/B.md/x.md", /is a file/],
  ])("refuses %s without touching anything", async (_name, from, to, message) => {
    const vault = fakeVault(VAULT());
    await expect(fakeApp(vault).moveVaultPath(from, to)).rejects.toThrow(message);
    expect(vault.writes).toEqual([]);
  });

  it("refuses a target that exists only on disk (case-insensitive filesystem)", async () => {
    const vault = fakeVault(VAULT(), ["unrelated2.md"]);
    await expect(fakeApp(vault).moveVaultPath("Unrelated.md", "unrelated2.md")).rejects.toThrow(/already exists/);
    expect(vault.writes).toEqual([]);
  });

  it("refuses before any write when an affected open note is in conflict read-only state", async () => {
    const vault = fakeVault(VAULT());
    const view = Object.assign(Object.create(MarkdownView.prototype), { file: vault.files.get("Projects/Beta/B.md"), conflictReadOnly: true });
    const app = fakeApp(vault, [{ view, group: { renderTabs: vi.fn() } }]);
    await expect(app.moveVaultPath("Projects/Alpha", "Archive/Alpha")).rejects.toThrow(/recovery/);
    expect(vault.writes).toEqual([]);
  });

  it("refreshes open panes of moved notes", async () => {
    const vault = fakeVault(VAULT());
    const setFile = vi.fn(async () => {});
    const view = Object.assign(Object.create(MarkdownView.prototype), { file: vault.files.get("Projects/Alpha/Note.md"), conflictReadOnly: false, setFile });
    const renderTabs = vi.fn();
    await fakeApp(vault, [{ view, group: { renderTabs } }]).moveVaultPath("Projects/Alpha", "Archive/Alpha");
    expect(setFile).toHaveBeenCalledWith(vault.files.get("Archive/Alpha/Note.md"));
    expect(renderTabs).toHaveBeenCalled();
  });
});

describe("FileManager link-updating moves", () => {
  it("renameFile (file or folder) and moveWithLinkUpdate share App.moveVaultPath", async () => {
    const moveVaultPath = vi.fn(async (from: string, to: string) => ({ moved: [{ from, to }], updatedNotes: ["X.md"] }));
    const manager = new FileManager({ moveVaultPath } as any);
    await expect(manager.renameFile({ kind: "folder", path: "Docs" } as any, "Archive")).resolves.toBeUndefined();
    await expect(manager.moveWithLinkUpdate("A.md", "B.md")).resolves.toEqual({ moved: [{ from: "A.md", to: "B.md" }], updatedNotes: ["X.md"] });
    expect(moveVaultPath.mock.calls).toEqual([["Docs", "Archive"], ["A.md", "B.md"]]);
  });
});
