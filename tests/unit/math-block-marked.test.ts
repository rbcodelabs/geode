import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { installMathExtensions } from "../../src/renderer/markdown/math-marked";

const md = () => {
  const m = new Marked({ gfm: true, breaks: true });
  installMathExtensions(m);
  return m;
};
const parse = (src: string) => md().parse(src, { async: false }) as string;

describe("block math in reading mode (marked)", () => {
  it("renders a multi-line $$ block as display math, not a paragraph of text", () => {
    const html = parse("intro\n\n$$\n\\frac{a}{b}\n$$\n\noutro");
    expect(html).toContain("katex-display");
    expect(html).toContain("<p>intro</p>");
    expect(html).toContain("<p>outro</p>");
    expect(html).not.toContain("$$");
  });

  it("does not apply emphasis parsing to underscores inside a block", () => {
    const html = parse("$$\na_1 + b_2\n$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("<em>");
  });

  it("renders a single-line $$x$$ paragraph as display math", () => {
    expect(parse("$$x^2$$")).toContain("katex-display");
  });

  it("interrupts a paragraph when $$ starts on the next line", () => {
    const html = parse("line one\n$$\nx\n$$");
    expect(html).toContain("katex-display");
    expect(html).toContain("line one");
  });

  it("leaves an unclosed $$ as plain text", () => {
    const html = parse("$$\nx = 1");
    expect(html).not.toContain("katex");
    expect(html).toContain("$$");
  });

  it("does not render $$ inside a fenced code block", () => {
    const html = parse("```\n$$\nx\n$$\n```");
    expect(html).not.toContain("katex");
    expect(html).toContain("<code>");
  });

  it("shows an error fallback for an invalid block and does not throw", () => {
    const html = parse("$$\n\\frac{\n$$");
    expect(html).toContain("math-error");
  });
});
