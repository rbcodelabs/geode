import { describe, expect, it } from "vitest";
import { SlidesState, splitSlides } from "../../src/renderer/internal-plugins/slides/slides";

describe("splitSlides", () => {
  it("splits on --- surrounded by blank lines", () => {
    expect(splitSlides("# One\n\n---\n\nTwo\n\n---\n\nThree")).toEqual(["# One", "Two", "Three"]);
  });

  it("returns a single slide when there is no separator", () => {
    expect(splitSlides("Just\n\nsome text\n")).toEqual(["Just\n\nsome text"]);
  });

  it("returns no slides for an empty note", () => {
    expect(splitSlides("")).toEqual([]);
    expect(splitSlides("\n\n")).toEqual([]);
  });

  it("does not split without a blank line before or after", () => {
    expect(splitSlides("a\n---\n\nb")).toEqual(["a\n---\n\nb"]);
    expect(splitSlides("a\n\n---\nb")).toEqual(["a\n\n---\nb"]);
  });

  it("drops frontmatter and never treats its delimiters as separators", () => {
    expect(splitSlides("---\ntitle: x\n---\n\nOne\n\n---\n\nTwo")).toEqual(["One", "Two"]);
    // Even a blank line inside the frontmatter next to the closing delimiter.
    expect(splitSlides("---\ntitle: x\n\n---\n\nOne")).toEqual(["One"]);
  });

  it("does not split inside fenced code", () => {
    const md = "A\n\n```\ncode\n\n---\n\nmore\n```\n\n---\n\nB";
    expect(splitSlides(md)).toEqual(["A\n\n```\ncode\n\n---\n\nmore\n```", "B"]);
    const tilde = "~~~\n\n---\n\n~~~\n\n---\n\nB";
    expect(splitSlides(tilde)).toEqual(["~~~\n\n---\n\n~~~", "B"]);
  });

  it("a longer fence is only closed by an equal-or-longer fence", () => {
    const md = "````\n```\n\n---\n\n````\n\n---\n\nB";
    expect(splitSlides(md)).toEqual(["````\n```\n\n---\n\n````", "B"]);
  });

  it("does not split on table rules or setext headings", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n|---|---|\n\nend";
    expect(splitSlides(table)).toEqual([table]);
    expect(splitSlides("Title\n---\n\nbody")).toEqual(["Title\n---\n\nbody"]);
  });

  it("does not split inside a math block", () => {
    const md = "$$\n\n---\n\nx\n$$\n\n---\n\nB";
    expect(splitSlides(md)).toEqual(["$$\n\n---\n\nx\n$$", "B"]);
  });

  it("tolerates trailing whitespace and CRLF", () => {
    expect(splitSlides("One\r\n\r\n---  \r\n\r\nTwo")).toEqual(["One", "Two"]);
  });

  it("does not split on other rule styles or longer dashes", () => {
    const md = "a\n\n***\n\nb\n\n----\n\nc";
    expect(splitSlides(md)).toEqual([md]);
  });

  it("drops empty slides from doubled separators", () => {
    expect(splitSlides("a\n\n---\n\n---\n\nb")).toEqual(["a", "b"]);
  });
});

describe("SlidesState", () => {
  it("starts at the first slide with previous disabled", () => {
    const s = new SlidesState(3);
    expect(s.index).toBe(0);
    expect(s.canPrevious).toBe(false);
    expect(s.canNext).toBe(true);
  });

  it("advances and clamps at both ends", () => {
    const s = new SlidesState(2);
    expect(s.previous()).toBe(false);
    expect(s.next()).toBe(true);
    expect(s.index).toBe(1);
    expect(s.canNext).toBe(false);
    expect(s.next()).toBe(false);
    expect(s.index).toBe(1);
    expect(s.previous()).toBe(true);
    expect(s.index).toBe(0);
  });

  it("a single slide has both directions disabled", () => {
    const s = new SlidesState(1);
    expect(s.canPrevious).toBe(false);
    expect(s.canNext).toBe(false);
  });
});
