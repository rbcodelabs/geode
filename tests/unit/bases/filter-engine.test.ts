import { describe, expect, it } from "vitest";
import { evaluateFilterTree } from "../../../src/renderer/bases/filter-engine";
import { parseFilterTree } from "../../../src/renderer/bases/filter-parser";
import { FilterNode } from "../../../src/renderer/bases/ast";
import { buildContext } from "./helpers";

function tree(yamlNode: unknown): FilterNode {
  const parsed = parseFilterTree(yamlNode);
  if (!("tree" in parsed)) throw new Error(parsed.error);
  return parsed.tree;
}

describe("evaluateFilterTree", () => {
  it("a leaf is true iff its expression is truthy", async () => {
    const { ctx } = await buildContext({ "A.md": "---\nstatus: done\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree('status == "done"'), ctx)).toBe(true);
    expect(evaluateFilterTree(tree('status == "open"'), ctx)).toBe(false);
  });

  it("and: true iff every child is true", async () => {
    const { ctx } = await buildContext({ "A.md": "---\na: true\nb: true\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree({ and: ["a", "b"] }), ctx)).toBe(true);
    const { ctx: ctx2 } = await buildContext({ "A.md": "---\na: true\nb: false\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree({ and: ["a", "b"] }), ctx2)).toBe(false);
  });

  it("or: true iff any child is true", async () => {
    const { ctx } = await buildContext({ "A.md": "---\na: false\nb: true\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree({ or: ["a", "b"] }), ctx)).toBe(true);
    const { ctx: ctx2 } = await buildContext({ "A.md": "---\na: false\nb: false\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree({ or: ["a", "b"] }), ctx2)).toBe(false);
  });

  it("not: true iff none of its children are true", async () => {
    const { ctx } = await buildContext({ "A.md": "---\na: false\nb: false\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree({ not: ["a", "b"] }), ctx)).toBe(true);
    const { ctx: ctx2 } = await buildContext({ "A.md": "---\na: false\nb: true\n---\n" }, "A.md");
    expect(evaluateFilterTree(tree({ not: ["a", "b"] }), ctx2)).toBe(false);
  });

  it("evaluates the spec's worked example nested tree", async () => {
    const yamlNode = {
      or: [
        'file.hasTag("tag")',
        { and: ['file.hasTag("book")', 'file.hasLink("Textbook")'] },
        { not: ['file.hasTag("book")'] },
      ],
    };
    const { ctx } = await buildContext({ "A.md": "---\ntags: [tag]\n---\n" }, "A.md");
    // Matches the first branch (file.hasTag("tag")) directly.
    expect(evaluateFilterTree(tree(yamlNode), ctx)).toBe(true);

    const { ctx: ctx2 } = await buildContext({ "A.md": "---\ntags: [novel]\n---\n" }, "A.md");
    // Doesn't have "tag" or "book" -> first branch false, second false (no
    // "book" tag), third true (not tagged "book" -> not [false] -> true).
    expect(evaluateFilterTree(tree(yamlNode), ctx2)).toBe(true);

    const { ctx: ctx3 } = await buildContext({ "A.md": "---\ntags: [book]\n---\n" }, "A.md");
    // Tagged "book" but no link to "Textbook" -> branch 2 false, branch 3
    // (not tagged book) is also false -> overall false.
    expect(evaluateFilterTree(tree(yamlNode), ctx3)).toBe(false);
  });
});
