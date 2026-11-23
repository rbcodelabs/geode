import { describe, expect, it } from "vitest";
import { collectArtifactFolders, findArtifactBoard, isArtifactFolder, resolveArtifactBoardForFile } from "../../src/renderer/artifacts/artifact-folders";
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

  describe("board resolution", () => {
    const withBoard = () => folder("A/b", [file("A/b/artifact.json"), file("A/b/index.html"), file("A/b/board.canvas")]);
    const noBoard = () => folder("A/p", [file("A/p/artifact.json"), file("A/p/index.html")]);

    it("finds board.canvas only inside an artifact folder", () => {
      expect(findArtifactBoard(withBoard())?.path).toBe("A/b/board.canvas");
      expect(findArtifactBoard(noBoard())).toBeNull();
      // a board.canvas without a manifest is just a canvas, not an artifact board
      expect(findArtifactBoard(folder("C", [file("C/board.canvas")]))).toBeNull();
      // a folder named board.canvas is not a board
      expect(findArtifactBoard(folder("D", [file("D/artifact.json"), folder("D/board.canvas")]))).toBeNull();
    });

    it("artifact.json and index.html resolve to the board; other files do not", () => {
      const parent = withBoard();
      expect(resolveArtifactBoardForFile({ name: "artifact.json" }, parent)?.path).toBe("A/b/board.canvas");
      expect(resolveArtifactBoardForFile({ name: "index.html" }, parent)?.path).toBe("A/b/board.canvas");
      expect(resolveArtifactBoardForFile({ name: "styles.css" }, parent)).toBeNull();
      expect(resolveArtifactBoardForFile({ name: "board.canvas" }, parent)).toBeNull();
      expect(resolveArtifactBoardForFile({ name: "artifact.json" }, null)).toBeNull();
    });

    it("single-screen artifacts without a board resolve to nothing (behavior unchanged)", () => {
      expect(resolveArtifactBoardForFile({ name: "artifact.json" }, noBoard())).toBeNull();
      expect(resolveArtifactBoardForFile({ name: "index.html" }, noBoard())).toBeNull();
      // an index.html outside any artifact is a plain page
      expect(resolveArtifactBoardForFile({ name: "index.html" }, folder("Web", [file("Web/index.html"), file("Web/board.canvas")]))).toBeNull();
    });
  });
});
