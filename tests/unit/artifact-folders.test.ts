import { describe, expect, it } from "vitest";
import { collectArtifactFolders, isArtifactFolder } from "../../src/renderer/artifacts/artifact-folders";
import type { TFolder } from "../../src/renderer/types";

const file = (path: string) => ({ kind: "file", path, name: path.split("/").pop()! });
function folder(path: string, children: unknown[] = []): TFolder {
  return { kind: "folder", path, name: path.split("/").pop() ?? "", children } as unknown as TFolder;
}

describe("artifact folders", () => {
  it("is an artifact only when artifact.json is a direct child file", () => {
    expect(isArtifactFolder(folder("Artifacts/Tasks", [file("Artifacts/Tasks/artifact.json")]))).toBe(true);
    expect(isArtifactFolder(folder("Notes", [file("Notes/a.md")]))).toBe(false);
    // a folder that happens to be named artifact.json is not a manifest
    expect(isArtifactFolder(folder("X", [folder("X/artifact.json")]))).toBe(false);
    expect(isArtifactFolder(folder("Empty"))).toBe(false);
  });

  it("collects artifact folders sorted by path and does not descend into an artifact", () => {
    const nested = folder("A/dash/inner", [file("A/dash/inner/artifact.json")]);
    const dash = folder("A/dash", [file("A/dash/artifact.json"), nested]);
    const board = folder("A/board", [file("A/board/artifact.json")]);
    const plain = folder("B", [file("B/x.md"), folder("B/deep", [file("B/deep/y.md")])]);
    const root = folder("", [folder("A", [dash, board]), plain]);
    expect(collectArtifactFolders(root).map((f) => f.path)).toEqual(["A/board", "A/dash"]);
  });

  it("returns nothing for a vault without artifacts", () => {
    expect(collectArtifactFolders(folder("", [folder("Notes", [file("Notes/a.md")])]))).toEqual([]);
  });
});
