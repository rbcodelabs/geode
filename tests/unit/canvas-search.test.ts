import { describe, expect, it } from "vitest";
import { projectCanvasForSearch } from "../../src/renderer/canvas/canvas-data";
import { matchFileAgainstTerms, parseQuery } from "../../src/renderer/views/search-view";
import type { TFile } from "../../src/renderer/types";

function canvasFile(path = "Boards/Research.canvas"): TFile {
  const name = path.split("/").pop()!;
  return {
    kind: "file",
    path,
    name,
    basename: name.slice(0, -".canvas".length),
    extension: "canvas",
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: path.slice(0, path.lastIndexOf("/")),
  };
}

describe("projectCanvasForSearch", () => {
  it("strictly projects only documented semantic Canvas fields in source order", () => {
    const source = JSON.stringify({
      vendorDocument: "must not be searchable",
      nodes: [
        { id: "text-1", type: "text", x: 0, y: 0, width: 200, height: 100, text: "First thought\nSecond line", vendorNode: "hidden-node-value" },
        { id: "file-1", type: "file", x: 10, y: 20, width: 200, height: 100, file: "Notes/Plan.md", subpath: "#Milestone" },
        { id: "link-1", type: "link", x: 20, y: 40, width: 200, height: 100, url: "https://example.com/research" },
        { id: "group-1", type: "group", x: 0, y: 0, width: 500, height: 400, label: "Planning group", background: "Assets/board.png" },
      ],
      edges: [
        { id: "edge-1", fromNode: "text-1", toNode: "file-1", label: "supports milestone", vendorEdge: "hidden-edge-value" },
      ],
    });

    expect(projectCanvasForSearch(source)).toBe([
      "First thought",
      "Second line",
      "Notes/Plan.md#Milestone",
      "https://example.com/research",
      "Planning group",
      "Assets/board.png",
      "supports milestone",
    ].join("\n"));
  });

  it("fails safely for malformed or schema-invalid Canvas JSON", () => {
    expect(projectCanvasForSearch("{ truncated")).toBeNull();
    expect(projectCanvasForSearch(JSON.stringify({
      nodes: [{ id: "bad", type: "text", x: 0, y: 0, width: -1, height: 100, text: "must not match" }],
      edges: [],
    }))).toBeNull();
  });

  it("feeds ordinary, regex, line, negation, file/path, and tag-safe matching", () => {
    const file = canvasFile();
    const projection = projectCanvasForSearch(JSON.stringify({
      nodes: [{ id: "text", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Semantic needle" }],
      edges: [],
      vendorTag: "#fabricated",
    }));
    expect(projection).not.toBeNull();
    const noTags = () => [];
    for (const query of ["semantic", "content:needle", "line:needle", "/sem[a-z]+/", "file:research", "path:boards/"]) {
      expect(matchFileAgainstTerms(file, projection, parseQuery(query), noTags), query).not.toBeNull();
    }
    expect(matchFileAgainstTerms(file, projection, parseQuery("-missing"), noTags)).not.toBeNull();
    expect(matchFileAgainstTerms(file, projection, parseQuery("-needle"), noTags)).toBeNull();
    expect(matchFileAgainstTerms(file, projection, parseQuery("tag:fabricated"), noTags)).toBeNull();
  });
});
