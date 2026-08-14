import { describe, expect, it } from "vitest";
import { parseExpression } from "../../../src/renderer/bases/parser";
import { Expr } from "../../../src/renderer/bases/ast";

function expr(source: string): Expr {
  const result = parseExpression(source);
  if ("error" in result) throw new Error(`Expected "${source}" to parse, got error: ${result.error}`);
  return result.expr;
}

function err(source: string): string {
  const result = parseExpression(source);
  if ("expr" in result) throw new Error(`Expected "${source}" to fail, got ${JSON.stringify(result.expr)}`);
  return result.error;
}

describe("parseExpression: literals", () => {
  it("parses numbers, including a parenthesized number as a group", () => {
    expect(expr("1")).toEqual({ kind: "literal", value: 1 });
    expect(expr("(2.5)")).toEqual({ kind: "group", inner: { kind: "literal", value: 2.5 } });
  });

  it("parses single- and double-quoted strings", () => {
    expect(expr("'x'")).toEqual({ kind: "literal", value: "x" });
    expect(expr('"x"')).toEqual({ kind: "literal", value: "x" });
  });

  it("parses booleans", () => {
    expect(expr("true")).toEqual({ kind: "literal", value: true });
    expect(expr("false")).toEqual({ kind: "literal", value: false });
  });
});

describe("parseExpression: property paths", () => {
  it("parses a bare identifier as shorthand for note.<name>", () => {
    expect(expr("status")).toEqual({ kind: "propertyPath", root: "shorthand", segments: ["status"] });
  });

  it("parses note./file./formula./this roots", () => {
    expect(expr("note.author")).toEqual({ kind: "propertyPath", root: "note", segments: ["author"] });
    expect(expr("file.name")).toEqual({ kind: "propertyPath", root: "file", segments: ["name"] });
    expect(expr("formula.ppu")).toEqual({ kind: "propertyPath", root: "formula", segments: ["ppu"] });
    expect(expr("this.path")).toEqual({ kind: "propertyPath", root: "this", segments: ["path"] });
  });

  it("folds multiple dot segments into one propertyPath when none is followed by '('", () => {
    expect(expr("note.author.name")).toEqual({
      kind: "propertyPath",
      root: "note",
      segments: ["author", "name"],
    });
  });

  it("stops folding at a segment followed by '(', producing a methodCall wrapping the propertyPath so far", () => {
    expect(expr('file.mtime.format("X")')).toEqual({
      kind: "methodCall",
      target: { kind: "propertyPath", root: "file", segments: ["mtime"] },
      method: "format",
      args: [{ kind: "literal", value: "X" }],
    });
  });
});

describe("parseExpression: calls", () => {
  it("parses a bare identifier followed by '(' as a call node", () => {
    expect(expr("now()")).toEqual({ kind: "call", callee: "now", args: [] });
  });

  it("parses call args, unknown function names included (resolved at eval time)", () => {
    expect(expr('totallyMadeUp(1, "a")')).toEqual({
      kind: "call",
      callee: "totallyMadeUp",
      args: [
        { kind: "literal", value: 1 },
        { kind: "literal", value: "a" },
      ],
    });
  });
});

describe("parseExpression: postfix chaining", () => {
  it("parses field access (no parens) on an arbitrary expression", () => {
    expect(expr("(a + b).length")).toEqual({
      kind: "fieldAccess",
      target: {
        kind: "group",
        inner: {
          kind: "binary",
          op: "+",
          left: { kind: "propertyPath", root: "shorthand", segments: ["a"] },
          right: { kind: "propertyPath", root: "shorthand", segments: ["b"] },
        },
      },
      field: "length",
    });
  });

  it("parses method calls with args on an arbitrary expression", () => {
    expect(expr('title.lower().contains("x")')).toEqual({
      kind: "methodCall",
      target: {
        kind: "methodCall",
        target: { kind: "propertyPath", root: "shorthand", segments: ["title"] },
        method: "lower",
        args: [],
      },
      method: "contains",
      args: [{ kind: "literal", value: "x" }],
    });
  });

  it("parses index access", () => {
    expect(expr("list(1,2,3)[0]")).toEqual({
      kind: "index",
      target: {
        kind: "call",
        callee: "list",
        args: [
          { kind: "literal", value: 1 },
          { kind: "literal", value: 2 },
          { kind: "literal", value: 3 },
        ],
      },
      indexExpr: { kind: "literal", value: 0 },
    });
  });
});

describe("parseExpression: regex literals", () => {
  it("parses a bare regex literal in primary position", () => {
    expect(expr("/abc/gi")).toEqual({ kind: "regexLiteral", source: "abc", flags: "gi" });
  });

  it("parses .matches() on a regex literal", () => {
    expect(expr('/^a/.matches("abc")')).toEqual({
      kind: "methodCall",
      target: { kind: "regexLiteral", source: "^a", flags: "" },
      method: "matches",
      args: [{ kind: "literal", value: "abc" }],
    });
  });

  it("parses division as the slash operator when not in primary position", () => {
    expect(expr("a / b")).toEqual({
      kind: "binary",
      op: "/",
      left: { kind: "propertyPath", root: "shorthand", segments: ["a"] },
      right: { kind: "propertyPath", root: "shorthand", segments: ["b"] },
    });
  });
});

describe("parseExpression: operators and precedence", () => {
  it("multiplicative binds tighter than additive", () => {
    expect(expr("1 + 2 * 3")).toEqual({
      kind: "binary",
      op: "+",
      left: { kind: "literal", value: 1 },
      right: {
        kind: "binary",
        op: "*",
        left: { kind: "literal", value: 2 },
        right: { kind: "literal", value: 3 },
      },
    });
  });

  it("additive binds tighter than comparison", () => {
    expect(expr("1 + 2 > 2")).toEqual({
      kind: "binary",
      op: ">",
      left: {
        kind: "binary",
        op: "+",
        left: { kind: "literal", value: 1 },
        right: { kind: "literal", value: 2 },
      },
      right: { kind: "literal", value: 2 },
    });
  });

  it("comparison is non-chainable — a second comparison operator is a parse error", () => {
    expect(err("1 < 2 < 3")).toMatch(/trailing|Unexpected/i);
  });

  it("comparison binds tighter than 'not'", () => {
    expect(expr("not 1 > 2")).toEqual({
      kind: "unary",
      op: "not",
      operand: { kind: "binary", op: ">", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 2 } },
    });
  });

  it("'not' binds tighter than 'and', which binds tighter than 'or'", () => {
    expect(expr("a or b and not c")).toEqual({
      kind: "binary",
      op: "or",
      left: { kind: "propertyPath", root: "shorthand", segments: ["a"] },
      right: {
        kind: "binary",
        op: "and",
        left: { kind: "propertyPath", root: "shorthand", segments: ["b"] },
        right: { kind: "unary", op: "not", operand: { kind: "propertyPath", root: "shorthand", segments: ["c"] } },
      },
    });
  });

  it("unary minus/plus bind tighter than multiplicative", () => {
    expect(expr("-2 * 3")).toEqual({
      kind: "binary",
      op: "*",
      left: { kind: "unary", op: "-", operand: { kind: "literal", value: 2 } },
      right: { kind: "literal", value: 3 },
    });
  });

  it("parentheses override precedence via a group node", () => {
    expect(expr("(1 + 2) * 3")).toEqual({
      kind: "binary",
      op: "*",
      left: {
        kind: "group",
        inner: { kind: "binary", op: "+", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 2 } },
      },
      right: { kind: "literal", value: 3 },
    });
  });
});

describe("parseExpression: never throws, reports errors instead", () => {
  it("reports an error for a dangling operator", () => {
    expect(() => parseExpression("1 +")).not.toThrow();
    expect(err("1 +")).toBeTruthy();
  });

  it("reports an error for unmatched parens", () => {
    expect(err("(1 + 2")).toBeTruthy();
  });

  it("reports an error for trailing garbage after a valid expression", () => {
    expect(err("1 2")).toBeTruthy();
  });

  it("reports an error rather than looping forever on pure garbage", () => {
    expect(() => parseExpression(")))")).not.toThrow();
    expect(err(")))")).toBeTruthy();
  });
});
