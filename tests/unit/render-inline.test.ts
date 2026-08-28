import { describe, expect, it } from "vitest";
import { inlineHtml, preprocessInline } from "../../src/renderer/markdown/render";
import type { App } from "../../src/renderer/app";

/**
 * `inlineHtml` is the synchronous inline-markdown renderer behind Live
 * Preview's editable table cells (src/renderer/markdown/live-preview.ts). It
 * shares `applyInlineSyntax` with Reading view's `preprocess`, so these cases
 * double as a guard that the two paths cannot drift apart.
 *
 * The only `App` surface it touches is `metadataCache.getFirstLinkpathDest`
 * (used to decide resolved vs. unresolved wikilinks), so a stub suffices —
 * that keeps the module under test free of any DOM dependency.
 */
function stubApp(resolvable: string[] = []): App {
  return {
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) =>
        resolvable.includes(linkpath) ? ({ path: `${linkpath}.md` } as unknown) : null,
    },
  } as unknown as App;
}

const render = (src: string, resolvable: string[] = []) =>
  inlineHtml(src, "Note.md", stubApp(resolvable));

describe("inlineHtml", () => {
  it("renders bold and italic emphasis", () => {
    expect(render("**bold** and *em*")).toBe("<strong>bold</strong> and <em>em</em>");
  });

  it("renders inline code", () => {
    expect(render("use `cachedRead()`")).toBe("use <code>cachedRead()</code>");
  });

  it("renders a resolved wikilink as an internal-link anchor", () => {
    expect(render("see [[Daily Plan]]", ["Daily Plan"])).toBe(
      'see <a class="internal-link" data-href="Daily Plan" href="#">Daily Plan</a>'
    );
  });

  it("marks a wikilink with no destination as unresolved", () => {
    expect(render("see [[Nowhere]]")).toContain('class="internal-link is-unresolved"');
  });

  it("uses the alias side of a piped wikilink as the display text", () => {
    const html = render("[[Projects/Roadmap|the roadmap]]", ["Projects/Roadmap"]);
    expect(html).toContain('data-href="Projects/Roadmap"');
    expect(html).toContain(">the roadmap</a>");
  });

  it("renders a tag as a tag anchor", () => {
    expect(render("#getting-started")).toBe(
      '<a class="tag" data-tag="getting-started" href="#">#getting-started</a>'
    );
  });

  it("renders ==highlights== as <mark>", () => {
    expect(render("==important==")).toBe("<mark>important</mark>");
  });

  it("renders a plain markdown link, leaving click handling to the interceptor", () => {
    expect(render("[Geode](https://example.com)")).toBe(
      '<a href="https://example.com">Geode</a>'
    );
  });

  it("does not substitute inside inline code spans", () => {
    // The literal wikilink/tag text must survive verbatim inside backticks.
    const html = render("`[[Daily Plan]] #tag`", ["Daily Plan"]);
    expect(html).toBe("<code>[[Daily Plan]] #tag</code>");
  });

  it("degrades an ![[embed]] to an internal-link anchor rather than a mount", () => {
    const html = render("![[geode-logo.png]]", ["geode-logo.png"]);
    expect(html).toBe(
      '<a class="internal-link" data-href="geode-logo.png" href="#">geode-logo.png</a>'
    );
    expect(html).not.toContain("internal-embed");
    expect(html).not.toContain("bases-embed-mount");
  });

  it("escapes HTML-significant characters in plain text", () => {
    expect(render("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("returns an empty string for an empty cell", () => {
    expect(render("")).toBe("");
  });

  it("renders inline-only: a leading # or - is not promoted to a block", () => {
    // parseInline never produces block elements, which is what keeps a table
    // cell's height predictable.
    expect(render("- not a list")).toBe("- not a list");
    expect(render("1998 - 2000")).toBe("1998 - 2000");
  });

  it("strips %%comments%% exactly as the document path does", () => {
    expect(render("visible%%hidden%%")).toBe("visible");
  });
});

describe("preprocessInline", () => {
  it("leaves a lone pipe alone so serializeTable can re-escape it", () => {
    // Cell text reaches this function already unescaped by splitRow, and the
    // inline pass must not reintroduce any pipe handling of its own.
    expect(preprocessInline("a | b", "Note.md", stubApp())).toBe("a | b");
  });
});
