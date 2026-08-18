import { describe, expect, it } from "vitest";
import { parseCanvas, serializeCanvas } from "../../src/renderer/canvas/canvas-data";

describe("JSON Canvas data", () => {
  it("parses every JSON Canvas 1.0 node type and an edge", () => {
    const canvas = parseCanvas(JSON.stringify({
      nodes: [
        { id: "text", type: "text", x: 0, y: 0, width: 240, height: 120, text: "Hello" },
        { id: "file", type: "file", x: 300, y: 0, width: 240, height: 160, file: "Note.md", subpath: "#Heading" },
        { id: "link", type: "link", x: 0, y: 220, width: 240, height: 120, url: "https://example.com" },
        { id: "group", type: "group", x: -20, y: -20, width: 580, height: 420, label: "Ideas", background: "#334455" },
      ],
      edges: [{ id: "edge", fromNode: "text", fromSide: "right", toNode: "file", toSide: "left", label: "related" }],
    }));

    expect(canvas.nodes.map((node) => node.type)).toEqual(["text", "file", "link", "group"]);
    expect(canvas.edges).toHaveLength(1);
    expect(canvas.edges[0]).toMatchObject({ fromNode: "text", toNode: "file", label: "related" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["malformed nodes", JSON.stringify({ nodes: {}, edges: [] })],
    ["invalid group background style", JSON.stringify({ nodes: [
      { id: "group", type: "group", x: 0, y: 0, width: 100, height: 100, backgroundStyle: "stretch" },
    ], edges: [] })],
    ["duplicate node ids", JSON.stringify({ nodes: [
      { id: "same", type: "text", x: 0, y: 0, width: 10, height: 10, text: "a" },
      { id: "same", type: "text", x: 20, y: 0, width: 10, height: 10, text: "b" },
    ], edges: [] })],
    ["dangling edge", JSON.stringify({ nodes: [], edges: [{ id: "e", fromNode: "missing", toNode: "other" }] })],
  ])("rejects %s", (_label, source) => {
    expect(() => parseCanvas(source)).toThrow();
  });

  it("defaults omitted node and edge arrays to empty", () => {
    expect(parseCanvas("{}")).toEqual({ nodes: [], edges: [] });
  });

  it("serializes a parseable, interoperable JSON Canvas document", () => {
    const source = {
      nodes: [{ id: "n", type: "text" as const, x: 1, y: 2, width: 200, height: 100, text: "Draft" }],
      edges: [],
    };
    const text = serializeCanvas(source);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(source);
    expect(parseCanvas(text)).toEqual(source);
  });

  it("preserves extension fields when parsing and saving", () => {
    const text = JSON.stringify({
      vendor: { version: 2 },
      nodes: [{ id: "n", type: "text", x: 0, y: 0, width: 100, height: 50, text: "Hi", vendorNode: true }],
      edges: [],
    });
    expect(JSON.parse(serializeCanvas(parseCanvas(text)))).toMatchObject({
      vendor: { version: 2 },
      nodes: [{ vendorNode: true }],
    });
  });
});
