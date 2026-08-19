import { describe, expect, it } from "vitest";
import { projectCanvasFileLinks } from "../../src/renderer/canvas/canvas-data";

describe("projectCanvasFileLinks", () => {
  it("projects only file cards with readable per-card context in node order", () => {
    const source = JSON.stringify({
      nodes: [
        { id: "file-1", type: "file", x: 0, y: 0, width: 200, height: 100, file: "Notes/Target.md", subpath: "#Section", vendor: "keep" },
        { id: "text", type: "text", x: 0, y: 120, width: 200, height: 100, text: "[[Notes/Target.md]]" },
        { id: "link", type: "link", x: 0, y: 240, width: 200, height: 100, url: "https://example.com/Notes/Target.md" },
        { id: "file-2", type: "file", x: 220, y: 0, width: 200, height: 100, file: "Notes/Target.md", subpath: "#Other" },
        { id: "media", type: "file", x: 440, y: 0, width: 200, height: 100, file: "image.png" },
      ],
      edges: [],
    });

    expect(projectCanvasFileLinks(source)).toEqual([
      { link: "Notes/Target.md#Section", context: "Note card: Notes/Target.md#Section" },
      { link: "Notes/Target.md#Other", context: "Note card: Notes/Target.md#Other" },
      { link: "image.png", context: "Note card: image.png" },
    ]);
  });

  it("fails safely for malformed or schema-invalid Canvas documents", () => {
    expect(projectCanvasFileLinks("{broken")).toBeNull();
    expect(projectCanvasFileLinks(JSON.stringify({
      nodes: [{ id: "bad", type: "file", x: 0, y: 0, width: 0, height: 100, file: "Target.md" }],
      edges: [],
    }))).toBeNull();
  });
});
