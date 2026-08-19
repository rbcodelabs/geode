import { describe, expect, it } from "vitest";
import { buildGraph, graphTopologyKey } from "../../src/renderer/graph/graph-data";
import type { TFile } from "../../src/renderer/types";

function file(path: string): TFile {
  const name = path.split("/").pop()!;
  const basename = name.replace(/\.md$/, "");
  return {
    kind: "file",
    path,
    name,
    basename,
    extension: "md",
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: "",
  };
}

describe("buildGraph", () => {
  it("creates one node per file and one edge per resolved link", () => {
    const files = [file("A.md"), file("B.md")];
    const resolvedLinks = new Map([["A.md", new Map([["B.md", 1]])]]);
    const { nodes, edges } = buildGraph(files, resolvedLinks);
    expect(nodes.map((n) => n.id).sort()).toEqual(["A.md", "B.md"]);
    expect(edges).toEqual([{ source: "A.md", target: "B.md", weight: 1 }]);
  });

  it("excludes self-links from the edge list", () => {
    const files = [file("A.md")];
    const resolvedLinks = new Map([["A.md", new Map([["A.md", 3]])]]);
    const { edges } = buildGraph(files, resolvedLinks);
    expect(edges).toEqual([]);
  });

  it("excludes links whose target isn't in the file list (e.g. deleted mid-rebuild)", () => {
    const files = [file("A.md")];
    const resolvedLinks = new Map([["A.md", new Map([["Ghost.md", 1]])]]);
    const { edges } = buildGraph(files, resolvedLinks);
    expect(edges).toEqual([]);
  });

  it("excludes links whose source isn't in the file list", () => {
    const files = [file("B.md")];
    const resolvedLinks = new Map([["Ghost.md", new Map([["B.md", 1]])]]);
    const { edges } = buildGraph(files, resolvedLinks);
    expect(edges).toEqual([]);
  });

  it("computes node degree as the count of distinct edges touching it (in + out)", () => {
    const files = [file("A.md"), file("B.md"), file("C.md")];
    // A -> B, A -> C, B -> C: A has degree 2, B has degree 2, C has degree 2.
    const resolvedLinks = new Map([
      ["A.md", new Map([["B.md", 1], ["C.md", 1]])],
      ["B.md", new Map([["C.md", 1]])],
    ]);
    const { nodes } = buildGraph(files, resolvedLinks);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("A.md")?.degree).toBe(2);
    expect(byId.get("B.md")?.degree).toBe(2);
    expect(byId.get("C.md")?.degree).toBe(2);
  });

  it("gives an isolated file a node with zero degree", () => {
    const files = [file("Lonely.md")];
    const { nodes } = buildGraph(files, new Map());
    expect(nodes).toEqual([
      expect.objectContaining({ id: "Lonely.md", label: "Lonely", degree: 0 }),
    ]);
  });

  it("assigns every node a distinct, finite initial position", () => {
    const files = [file("A.md"), file("B.md"), file("C.md")];
    const { nodes } = buildGraph(files, new Map());
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    const positions = nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(nodes.length); // no two nodes start stacked
  });

  it("gives equivalent Map and null-prototype record inputs the same stable topology key", () => {
    const files = [file("A.md"), file("B.md")];
    const mapData = buildGraph(files, new Map([["A.md", new Map([["B.md", 1]])]]));
    const record = Object.create(null) as Record<string, Record<string, number>>;
    record["A.md"] = Object.assign(Object.create(null), { "B.md": 1 });
    const recordData = buildGraph([...files].reverse(), record);

    expect(graphTopologyKey(recordData)).toBe(graphTopologyKey(mapData));
  });
});
