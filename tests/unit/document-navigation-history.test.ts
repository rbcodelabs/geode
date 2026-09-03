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
  it("serializes two normal document opens in invocation order", async () => {
    const { leaf } = leafWithFiles(["A.md", "B.md"]);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = leaf.runDocumentNavigation(async () => {
      events.push("A:start");
      await firstGate;
      leaf.recordDocumentNavigation("A.md");
      events.push("A:end");
    });
    const second = leaf.runDocumentNavigation(async () => {
      events.push("B:start");
      leaf.recordDocumentNavigation("B.md");
      events.push("B:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["A:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
    expect(leaf.canNavigateBack()).toBe(true);
  });

  it("orders a back request after an in-flight normal navigation", async () => {
    const { leaf, opened } = leafWithFiles(["A.md", "B.md", "C.md"]);
    leaf.recordDocumentNavigation("A.md");
    leaf.recordDocumentNavigation("B.md");
    let releaseNormal!: () => void;
    const normalGate = new Promise<void>((resolve) => { releaseNormal = resolve; });

    const normal = leaf.runDocumentNavigation(async () => {
      await normalGate;
      leaf.recordDocumentNavigation("C.md");
    });
    const back = leaf.navigateBack();

    await Promise.resolve();
    expect(opened).toEqual([]);
    releaseNormal();
    await Promise.all([normal, back]);
    expect(opened).toEqual(["B.md"]);
    expect(leaf.canNavigateForward()).toBe(true);
  });

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

  it("keeps the cursor aligned when a history open rejects", async () => {
    const { leaf } = leafWithFiles(["A.md", "B.md"]);
    leaf.recordDocumentNavigation("A.md");
    leaf.recordDocumentNavigation("B.md");
    (leaf.app as any).openFileInLeaf = vi.fn(async () => { throw new Error("read failed"); });

    await expect(leaf.navigateBack()).rejects.toThrow("read failed");
    expect(leaf.canNavigateBack()).toBe(true);
    expect(leaf.canNavigateForward()).toBe(false);
  });

  it("handles deletion between history lookup and file open", async () => {
    const { leaf, files, opened } = leafWithFiles(["A.md", "B.md"]);
    leaf.recordDocumentNavigation("A.md");
    leaf.recordDocumentNavigation("B.md");
    let lookups = 0;
    (leaf.app as any).vault.getFileByPath = (path: string) => {
      lookups += 1;
      if (lookups === 2) files.delete(path);
      return files.get(path) ?? null;
    };

    await leaf.navigateBack();
    expect(opened).toEqual([]);
    expect(leaf.canNavigateBack()).toBe(false);
    expect(leaf.canNavigateForward()).toBe(false);
  });

  it("disables traversal while the leaf is docked and restores it after a main-group move", async () => {
    const { leaf, opened } = leafWithFiles(["A.md", "B.md"]);
    leaf.recordDocumentNavigation("A.md");
    leaf.recordDocumentNavigation("B.md");
    (leaf.group as any).isSidebar = true;
    expect(leaf.canNavigateBack()).toBe(false);
    await leaf.navigateBack();
    expect(opened).toEqual([]);

    (leaf.group as any).isSidebar = false;
    expect(leaf.canNavigateBack()).toBe(true);
    await leaf.navigateBack();
    expect(opened).toEqual(["A.md"]);
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
