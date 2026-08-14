import { describe, expect, it } from "vitest";
import { scanRegexLiteral, tokenize } from "../../../src/renderer/bases/lexer";

function types(source: string): string[] {
  return tokenize(source).map((t) => t.type);
}

describe("tokenize", () => {
  it("tokenizes numbers, including decimals", () => {
    const tokens = tokenize("1 2.5 10");
    expect(tokens.map((t) => t.value)).toEqual([1, 2.5, 10, null]);
    expect(types("1 2.5 10")).toEqual(["number", "number", "number", "eof"]);
  });

  it("tokenizes single- and double-quoted strings to the same token type", () => {
    const single = tokenize("'hi'");
    const double = tokenize('"hi"');
    expect(single[0].type).toBe("string");
    expect(double[0].type).toBe("string");
    expect(single[0].value).toBe("hi");
    expect(double[0].value).toBe("hi");
  });

  it("unescapes common escape sequences inside strings", () => {
    expect(tokenize(String.raw`"a\nb\tc\\d\"e"`)[0].value).toBe('a\nb\tc\\d"e');
  });

  it("tolerates an unterminated string instead of throwing", () => {
    expect(() => tokenize('"unterminated')).not.toThrow();
    const tokens = tokenize('"unterminated');
    expect(tokens[0].type).toBe("string");
  });

  it("tokenizes identifiers and reserves and/or/not/true/false as keywords", () => {
    expect(types("foo and bar or not baz true false")).toEqual([
      "identifier",
      "and",
      "identifier",
      "or",
      "not",
      "identifier",
      "true",
      "false",
      "eof",
    ]);
  });

  it("tokenizes every punctuation/operator token type", () => {
    expect(types(". , ( ) [ ] + - * / %")).toEqual([
      "dot",
      "comma",
      "lparen",
      "rparen",
      "lbracket",
      "rbracket",
      "plus",
      "minus",
      "star",
      "slash",
      "percent",
      "eof",
    ]);
  });

  it("tokenizes two-character comparison operators, preferring the longer match", () => {
    expect(types("== != >= <=")).toEqual(["eq", "neq", "gte", "lte", "eof"]);
    expect(types("> <")).toEqual(["gt", "lt", "eof"]);
  });

  it("drops a lone '=' or '!' rather than throwing (not part of the grammar)", () => {
    expect(() => tokenize("= !")).not.toThrow();
    expect(types("= !")).toEqual(["eof"]);
  });

  it("skips unrecognized characters silently, never throwing", () => {
    expect(() => tokenize("foo ~ @ # bar")).not.toThrow();
    expect(types("foo ~ @ # bar")).toEqual(["identifier", "identifier", "eof"]);
  });

  it("always terminates with an eof token", () => {
    const tokens = tokenize("");
    expect(tokens).toEqual([{ type: "eof", text: "", value: null, start: 0, end: 0 }]);
  });
});

describe("scanRegexLiteral", () => {
  it("scans a simple pattern with no flags", () => {
    const result = scanRegexLiteral("/abc/", 0);
    expect(result).toEqual({ source: "abc", flags: "", end: 5 });
  });

  it("scans trailing flag letters", () => {
    const result = scanRegexLiteral("/abc/gi", 0);
    expect(result).toEqual({ source: "abc", flags: "gi", end: 7 });
  });

  it("keeps escaped slashes as part of the pattern", () => {
    const result = scanRegexLiteral(String.raw`/a\/b/`, 0);
    expect(result?.source).toBe(String.raw`a\/b`);
  });

  it("returns null for an unterminated regex (never throws)", () => {
    expect(() => scanRegexLiteral("/abc", 0)).not.toThrow();
    expect(scanRegexLiteral("/abc", 0)).toBeNull();
  });

  it("returns null if the source doesn't start with '/' at the given offset", () => {
    expect(scanRegexLiteral("abc/", 0)).toBeNull();
  });

  it("stops at a newline without consuming past it (unterminated on that line)", () => {
    expect(scanRegexLiteral("/abc\ndef/", 0)).toBeNull();
  });
});
