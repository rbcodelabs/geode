import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../../src/renderer/workspace";
import type { TFile } from "../../src/renderer/types";

function file(path: string): TFile {
  const name = path.split("/").at(-1)!;
  const dot = name.lastIndexOf(".");
  return {
    kind: "file",
    path,
    name,
    basename: dot < 0 ? name : name.slice(0, dot),
    extension: dot < 0 ? "" : name.slice(dot + 1),
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  };
}

function leafWithFiles(paths: string[]) {
  const files = new Map(paths.map((path) => [path, file(path)]));
  const opened: string[] = [];
  const leaf = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
  Object.assign(leaf, {
    group: { isSidebar: false, renderTabs: vi.fn() },
    app: {
      vault: { getFileByPath: (path: string) => files.get(path) ?? null },
      openFileInLeaf: async (_leaf: WorkspaceLeaf, target: TFile) => void opened.push(target.path),
    },
    contentEl: { querySelectorAll: () => [] },
  });
  return { leaf, files, opened };
}

describe("per-leaf document navigation history", () => {
  it("traverses independently, suppresses duplicates, and truncates the forward branch", async () => {
    const first = leafWithFiles(["A.md", "Board.canvas", "Data.base", "D.md"]);
    const second = leafWithFiles(["Other.md", "Else.md"]);

    first.leaf.recordDocumentNavigation("A.md");
    first.leaf.recordDocumentNavigation("Board.canvas");
    first.leaf.recordDocumentNavigation("Data.base");
    first.leaf.recordDocumentNavigation("Data.base");
    second.leaf.recordDocumentNavigation("Other.md");
    second.leaf.recordDocumentNavigation("Else.md");

    expect(first.leaf.canNavigateBack()).toBe(true);
    expect(first.leaf.canNavigateForward()).toBe(false);
    await first.leaf.navigateBack();
    expect(first.opened).toEqual(["Board.canvas"]);
    expect(first.leaf.canNavigateForward()).toBe(true);
    expect(second.opened).toEqual([]);

    first.leaf.recordDocumentNavigation("D.md");
    expect(first.leaf.canNavigateForward()).toBe(false);
    await first.leaf.navigateBack();
    await first.leaf.navigateBack();
    expect(first.opened).toEqual(["Board.canvas", "Board.canvas", "A.md"]);
  });

  it("skips deleted entries in either direction without getting stranded", async () => {
    const { leaf, files, opened } = leafWithFiles(["A.md", "B.md", "C.md", "D.md"]);
    for (const path of ["A.md", "B.md", "C.md", "D.md"]) leaf.recordDocumentNavigation(path);

    files.delete("C.md");
    await leaf.navigateBack();
    expect(opened).toEqual(["B.md"]);
    expect(leaf.canNavigateBack()).toBe(true);

    files.delete("C.md");
    await leaf.navigateForward();
    expect(opened).toEqual(["B.md", "D.md"]);
    expect(leaf.canNavigateForward()).toBe(false);
  });

  it("bounds retained entries to the most recent 100 documents", async () => {
    const paths = Array.from({ length: 105 }, (_, index) => `${index}.md`);
    const { leaf, opened } = leafWithFiles(paths);
    for (const path of paths) leaf.recordDocumentNavigation(path);
    for (let index = 0; index < 100; index++) await leaf.navigateBack();

    expect(opened.at(-1)).toBe("5.md");
    expect(opened).toHaveLength(99);
    expect(leaf.canNavigateBack()).toBe(false);
  });
});
