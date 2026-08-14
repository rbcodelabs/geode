import { describe, expect, it } from "vitest";
import { parseFilterTree } from "../../../src/renderer/bases/filter-parser";

describe("parseFilterTree", () => {
  it("parses a leaf string into a { leaf } node", () => {
    const result = parseFilterTree('status != "done"');
    if (!("tree" in result)) throw new Error(result.error);
    expect(result.tree).toEqual({
      leaf: {
        kind: "binary",
        op: "!=",
        left: { kind: "propertyPath", root: "shorthand", segments: ["status"] },
        right: { kind: "literal", value: "done" },
      },
    });
  });

  it("parses the spec's worked example filter tree (nested and/or/not)", () => {
    const yamlNode = {
      or: [
        'file.hasTag("tag")',
        { and: ['file.hasTag("book")', 'file.hasLink("Textbook")'] },
        { not: ['file.hasTag("book")'] },
      ],
    };
    const result = parseFilterTree(yamlNode);
    if (!("tree" in result)) throw new Error(result.error);
    expect("or" in result.tree).toBe(true);
    if (!("or" in result.tree)) throw new Error("expected or");
    expect(result.tree.or).toHaveLength(3);
    expect("and" in result.tree.or[1]).toBe(true);
    expect("not" in result.tree.or[2]).toBe(true);
  });

  it("propagates a leaf expression parse error", () => {
    const result = parseFilterTree("1 +");
    expect("error" in result).toBe(true);
  });

  it("errors on a filter object with none of and/or/not", () => {
    const result = parseFilterTree({ nope: [] });
    expect("error" in result).toBe(true);
  });

  it("errors when and/or/not's value isn't a list", () => {
    const result = parseFilterTree({ and: "not a list" });
    expect("error" in result).toBe(true);
  });

  it("errors on a value of an unrecognized shape", () => {
    expect("error" in parseFilterTree(42)).toBe(true);
    expect("error" in parseFilterTree(null)).toBe(true);
  });

  it("propagates a nested child's parse error", () => {
    const result = parseFilterTree({ and: ["status == 'ok'", "1 +"] });
    expect("error" in result).toBe(true);
  });
});
