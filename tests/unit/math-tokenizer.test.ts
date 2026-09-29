import { describe, expect, it } from "vitest";
import { findMathSpans, matchMathAt } from "../../src/renderer/markdown/math";

/** Sources of every span found, so cases read as "what got treated as math". */
const sources = (text: string) => findMathSpans(text).map((s) => s.source);

describe("findMathSpans: inline $...$", () => {
  it("finds a simple inline formula with exact offsets", () => {
    const text = "Euler: $e^{i\\pi}+1=0$ is famous";
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ source: "e^{i\\pi}+1=0", display: false });
    expect(text.slice(spans[0].from, spans[0].to)).toBe("$e^{i\\pi}+1=0$");
  });

  it("finds several formulas on one line", () => {
    expect(sources("$a$ and $b$ and $c_1$")).toEqual(["a", "b", "c_1"]);
  });

  it("does not treat a lone unbalanced $ as math", () => {
    expect(sources("this costs $5 today")).toEqual([]);
    expect(sources("a $ b")).toEqual([]);
  });

  it("does not treat currency amounts as math", () => {
    expect(sources("it was $5 and then $10")).toEqual([]);
    expect(sources("between $5-$10 per unit")).toEqual([]);
  });

  it("requires no whitespace just inside the delimiters", () => {
    expect(sources("$ a$")).toEqual([]);
    expect(sources("$a $")).toEqual([]);
  });

  it("does not let an inline formula span lines", () => {
    expect(sources("start $a +\nb$ end")).toEqual([]);
  });

  it("treats an escaped \\$ as a literal dollar, not a delimiter", () => {
    expect(sources("price \\$5 and \\$10")).toEqual([]);
    expect(sources("\\$a$ then $b$")).toEqual(["b"]);
  });

  it("keeps an escaped \\$ inside a formula from closing it", () => {
    expect(sources("$a \\$ b$")).toEqual(["a \\$ b"]);
  });

  it("recovers after a failed opener so a later formula still matches", () => {
    expect(sources("cost $5 and $x$ here")).toEqual(["x"]);
  });
});

describe("findMathSpans: block $$...$$", () => {
  it("finds a single-line display formula", () => {
    const spans = findMathSpans("$$x^2$$");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ source: "x^2", display: true, from: 0, to: 7 });
  });

  it("finds a multi-line display formula", () => {
    const text = "before\n\n$$\n\\frac{a}{b}\n= c\n$$\n\nafter";
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(true);
    expect(spans[0].source.trim()).toBe("\\frac{a}{b}\n= c");
    expect(text.slice(spans[0].from, spans[0].to)).toBe("$$\n\\frac{a}{b}\n= c\n$$");
  });

  it("does not treat an unclosed $$ as math", () => {
    expect(sources("$$\nx = 1\n\nnot math")).toEqual([]);
  });

  it("does not let an unclosed $$ swallow a later, separate block", () => {
    expect(sources("$$\nunclosed\n\ntext\n\n$$y$$")).toEqual(["y"]);
  });

  it("ignores an empty $$$$ pair", () => {
    expect(sources("$$$$")).toEqual([]);
  });

});

describe("findMathSpans: code exclusion", () => {
  it("skips math inside an inline code span", () => {
    expect(sources("use `$a$` here")).toEqual([]);
  });

  it("skips math inside a double-backtick code span", () => {
    expect(sources("use ``$a$ `x` $b$`` here")).toEqual([]);
  });

  it("does not let a code span's dollars pair with dollars outside it", () => {
    expect(sources("`$5` then $x$")).toEqual(["x"]);
  });

  it("skips math inside a fenced code block", () => {
    expect(sources("```\n$a$\n$$\nb\n$$\n```\n$c$")).toEqual(["c"]);
  });

  it("skips math inside a tilde fence and honors a longer closing fence", () => {
    expect(sources("~~~js\n$a$\n~~~~\n$b$")).toEqual(["b"]);
  });

  it("treats an unclosed fence as running to the end of the document", () => {
    expect(sources("```\n$a$\n$b$")).toEqual([]);
  });

  it("still finds math after an unmatched lone backtick", () => {
    expect(sources("a ` lone tick and $x$")).toEqual(["x"]);
  });
});

describe("matchMathAt", () => {
  it("returns the end offset relative to the input", () => {
    expect(matchMathAt("$a$ tail", 0)).toEqual({ end: 3, source: "a", display: false });
  });

  it("returns null when the character at pos is not a dollar", () => {
    expect(matchMathAt("abc", 0)).toBeNull();
  });

  it("returns null for an unbalanced opener", () => {
    expect(matchMathAt("$abc", 0)).toBeNull();
  });
});
