import { describe, expect, it } from "vitest";
import { renderMathHtml } from "../../src/renderer/markdown/math";
import { inlineHtml, preprocessInline } from "../../src/renderer/markdown/render";
import type { App } from "../../src/renderer/app";

function stubApp(): App {
  return {
    metadataCache: { getFirstLinkpathDest: () => null },
  } as unknown as App;
}
const render = (src: string) => inlineHtml(src, "Note.md", stubApp());

describe("renderMathHtml", () => {
  it("renders inline math with KaTeX markup", () => {
    const html = renderMathHtml("x^2", false);
    expect(html).toContain('class="math math-inline"');
    expect(html).toContain("katex");
    expect(html).not.toContain("katex-display");
  });

  it("renders display math with the block class and KaTeX display wrapper", () => {
    const html = renderMathHtml("\\frac{a}{b}", true);
    expect(html).toContain('class="math math-block"');
    expect(html).toContain("katex-display");
  });

  it("degrades invalid LaTeX to an error fallback instead of throwing", () => {
    const html = renderMathHtml("\\frac{", false);
    expect(html).toContain("math-error");
    // The source stays visible so the author can fix it.
    expect(html).toContain("\\frac{");
    expect(html).not.toContain("katex-html");
  });

  it("escapes HTML in the source of a failed formula", () => {
    const html = renderMathHtml("\\notacommand <img src=x onerror=alert(1)>", false);
    expect(html).toContain("math-error");
    expect(html).not.toContain("<img");
  });

  it("does not run trusted commands such as \\href javascript: urls", () => {
    const html = renderMathHtml("\\href{javascript:alert(1)}{x}", false);
    expect(html).not.toMatch(/href="javascript:/i);
  });
});

describe("markdown rendering of math", () => {
  it("renders inline math inside a paragraph", () => {
    const html = render("Area is $\\pi r^2$ today");
    expect(html).toContain("math-inline");
    expect(html).toContain("katex");
    expect(html.startsWith("Area is ")).toBe(true);
  });

  it("does not render currency as math", () => {
    expect(render("costs $5 and $10")).toBe("costs $5 and $10");
  });

  it("does not render an escaped \\$ as math", () => {
    const html = render("\\$a$ and \\$b$");
    expect(html).not.toContain("katex");
    expect(html).toContain("$a$");
  });

  it("does not render math inside a code span", () => {
    expect(render("use `$a$` here")).toBe("use <code>$a$</code> here");
  });

  it("keeps markdown emphasis characters inside math out of emphasis parsing", () => {
    const html = render("$a_1 + b_2$ and _real_");
    expect(html).toContain("katex");
    expect(html).toContain("<em>real</em>");
    expect(html.match(/<em>/g)).toHaveLength(1);
  });

  it("does not let wikilink/tag/highlight syntax rewrite math source", () => {
    const html = render("$a==b$ and $x \\# y$");
    expect(html).not.toContain("<mark>");
    expect(html.match(/math-inline/g)).toHaveLength(2);
  });

  it("renders inline $$ as display math within a paragraph", () => {
    const html = render("see $$x^2$$ here");
    expect(html).toContain("math-block");
    expect(html).toContain("katex-display");
  });

  it("shows an error fallback for invalid inline LaTeX and keeps rendering the rest", () => {
    const html = render("bad $\\frac{$ good $x$");
    expect(html).toContain("math-error");
    expect(html).toContain("math-inline");
  });
});

describe("preprocessInline math protection", () => {
  it("leaves math source byte-for-byte intact through the shared inline pass", () => {
    const out = preprocessInline("$a==b [[x]] #tag$", "Note.md", stubApp());
    expect(out).toBe("$a==b [[x]] #tag$");
  });
});
