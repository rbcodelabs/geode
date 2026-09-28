import { describe, expect, it } from "vitest";
import { renderFootnoteSource, scanFootnotes } from "../../src/renderer/markdown/footnotes";

describe("scanFootnotes", () => {
  it("finds a reference and its single-line definition", () => {
    const text = "Claim.[^1]\n\n[^1]: The source.\n";
    const scan = scanFootnotes(text);
    expect(scan.references).toHaveLength(1);
    expect(scan.references[0]).toMatchObject({ kind: "ref", id: "1", number: 1, from: 6, to: 10 });
    expect(scan.definitions).toHaveLength(1);
    expect(scan.definitions[0]).toMatchObject({ id: "1", number: 1, text: "The source." });
    expect(text.slice(scan.definitions[0].from, scan.definitions[0].to)).toBe("[^1]: The source.");
  });

  it("numbers footnotes by first reference, not by id or definition order", () => {
    const text = "a[^b] c[^a] d[^b]\n\n[^a]: A\n[^b]: B\n";
    const scan = scanFootnotes(text);
    expect(scan.references.map((r) => [r.id, r.number])).toEqual([
      ["b", 1],
      ["a", 2],
      ["b", 1],
    ]);
    expect(scan.references.map((r) => r.occurrence)).toEqual([0, 0, 1]);
  });

  it("supports named ids", () => {
    const scan = scanFootnotes("x[^note-1]\n\n[^note-1]: Named.");
    expect(scan.references[0].number).toBe(1);
    expect(scan.definitions[0].text).toBe("Named.");
  });

  it("leaves a reference with no definition out of the result (stays literal)", () => {
    const scan = scanFootnotes("Dangling[^ghost] text.");
    expect(scan.references).toEqual([]);
    expect(scan.definitions).toEqual([]);
  });

  it("does not treat references or definitions inside code as footnotes", () => {
    const text = [
      "Real[^1] and `code[^1]` and ``x[^1]``.",
      "",
      "```",
      "fenced[^1]",
      "[^1]: not a definition",
      "```",
      "",
      "~~~",
      "tilde[^1]",
      "~~~",
      "",
      "[^1]: The real one.",
    ].join("\n");
    const scan = scanFootnotes(text);
    expect(scan.references).toHaveLength(1);
    expect(scan.definitions).toHaveLength(1);
    expect(scan.definitions[0].text).toBe("The real one.");
  });

  it("collects indented continuation lines into a multi-paragraph definition", () => {
    const text = "x[^1]\n\n[^1]: First line\n    second line\n\n    Second paragraph.\n\nNot part.";
    const scan = scanFootnotes(text);
    expect(scan.definitions[0].text).toBe("First line\nsecond line\n\nSecond paragraph.");
    expect(text.slice(scan.definitions[0].to)).toBe("\n\nNot part.");
  });

  it("does not let a definition swallow the next definition", () => {
    const scan = scanFootnotes("a[^1] b[^2]\n\n[^1]: One\n[^2]: Two\n");
    expect(scan.definitions.map((d) => d.text)).toEqual(["One", "Two"]);
  });

  it("keeps the first definition when an id is defined twice", () => {
    const scan = scanFootnotes("a[^1]\n\n[^1]: First\n[^1]: Second\n");
    expect(scan.definitions).toHaveLength(1);
    expect(scan.definitions[0].text).toBe("First");
  });

  it("recognises inline footnotes and numbers them in sequence with named ones", () => {
    const text = "One^[inline *note*] then two[^a] then three^[another].\n\n[^a]: Def A\n";
    const scan = scanFootnotes(text);
    expect(scan.references.map((r) => [r.kind, r.number])).toEqual([
      ["inline", 1],
      ["ref", 2],
      ["inline", 3],
    ]);
    const inline = scan.references[0];
    expect(inline.kind === "inline" && inline.text).toBe("inline *note*");
  });

  it("allows one level of nested brackets in an inline footnote", () => {
    const scan = scanFootnotes("x^[see [docs] here] y");
    expect(scan.references).toHaveLength(1);
    expect(scan.references[0].kind === "inline" && scan.references[0].text).toBe("see [docs] here");
  });

  it("ignores an escaped opener", () => {
    expect(scanFootnotes("x\\[^1] and \\^[not]\n\n[^1]: d").references).toEqual([]);
  });

  it("marks a definition nobody references as unnumbered", () => {
    const scan = scanFootnotes("No refs here.\n\n[^9]: Orphan\n");
    expect(scan.definitions[0]).toMatchObject({ id: "9", number: null });
  });

  it("ignores everything before the start offset (frontmatter)", () => {
    const text = "---\nnote: [^1]\n---\nbody[^1]\n\n[^1]: d";
    const scan = scanFootnotes(text, 15);
    expect(scan.references).toHaveLength(1);
  });
});

describe("renderFootnoteSource", () => {
  it("replaces references with superscript links and drops definitions", () => {
    const { src, items } = renderFootnoteSource("Claim.[^1]\n\n[^1]: The source.\n");
    expect(src).toContain(
      '<sup class="footnote-ref" id="fnref-1"><a class="footnote-link" href="#fn-1">[1]</a></sup>'
    );
    expect(src).not.toContain("[^1]");
    expect(src).not.toContain("The source.");
    expect(items).toEqual([{ number: 1, text: "The source.", refCount: 1 }]);
  });

  it("gives repeated references distinct ids and counts them", () => {
    const { src, items } = renderFootnoteSource("a[^x] b[^x]\n\n[^x]: X\n");
    expect(src).toContain('id="fnref-1"');
    expect(src).toContain('id="fnref-1-2"');
    expect(items[0].refCount).toBe(2);
  });

  it("turns inline footnotes into numbered items", () => {
    const { src, items } = renderFootnoteSource("Hi^[inline text].");
    expect(src).toContain('href="#fn-1"');
    expect(src).not.toContain("inline text");
    expect(items).toEqual([{ number: 1, text: "inline text", refCount: 1 }]);
  });

  it("leaves undefined references and code spans byte-identical", () => {
    const text = "Dangling[^ghost] and `code[^1]`.\n\n[^1]: not referenced outside code\n";
    const { src, items } = renderFootnoteSource(text);
    expect(src).toContain("Dangling[^ghost]");
    expect(src).toContain("`code[^1]`");
    expect(items).toEqual([]);
  });

  it("returns the input untouched when there is nothing to do", () => {
    const text = "Plain [[link]] text.";
    expect(renderFootnoteSource(text)).toEqual({ src: text, items: [] });
  });

  it("orders items by number", () => {
    const { items } = renderFootnoteSource("a[^b] c[^a]\n\n[^a]: A\n[^b]: B\n");
    expect(items.map((i) => [i.number, i.text])).toEqual([
      [1, "B"],
      [2, "A"],
    ]);
  });
});
