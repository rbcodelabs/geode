import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { GFM, parser } from "@lezer/markdown";
import {
  CommentFormatError,
  createCommentMarkers,
  narrowCommentRange,
  parseCommentThreads,
  stripCommentMetadata,
  maskCommentMetadata,
  validateCommentRange,
} from "../../src/renderer/comments/model";
import { geodeCommentMarkerSyntax } from "../../src/renderer/comments/marker-syntax";
import { MarkdownRenderer } from "../../src/renderer/markdown/render";
import type { App } from "../../src/renderer/app";

async function renderDocument(source: string): Promise<string> {
  const element = {
    innerHTML: "",
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  } as unknown as HTMLElement;
  const app = {
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    markdownProcessors: { hasCodeBlocks: () => false, postProcessorsInOrder: () => [] },
    vault: { getFileByPath: () => null },
    openLink: () => undefined,
    openSearch: () => undefined,
    openExternalLink: () => undefined,
  } as unknown as App;
  await new MarkdownRenderer(app).render(source, element, "Note.md");
  return element.innerHTML;
}

const renderRawMarkdown = (source: string): string => new Marked({ gfm: true, breaks: true })
  .parseInline(source, { async: false })
  .replace(/<!-- geode-comment(?::v1 id="[^"]+" data="[^"]*"|-end:[^\s<>]+) -->/g, "");

describe("markdown comments format", () => {
  it("round-trips a Unicode threaded comment and strips metadata without changing prose", () => {
    const markers = createCommentMarkers("thread-1", {
      messages: [{
        id: "message-1",
        author: { type: "agent", name: "Claude" },
        body: "Try 💎 and <!-- unsafe -->",
        createdAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:00.000Z",
      }],
    });
    const source = `Before ${markers.open}selected 💎 text${markers.close} after`;

    const result = parseCommentThreads(source);

    expect(result.errors).toEqual([]);
    expect(result.threads).toMatchObject([{
      id: "thread-1",
      anchorText: "selected 💎 text",
      detached: false,
      messages: [{ body: "Try 💎 and <!-- unsafe -->" }],
    }]);
    expect(source.slice(result.threads[0].from, result.threads[0].to)).toBe("selected 💎 text");
    expect(stripCommentMetadata(source)).toBe("Before selected 💎 text after");
    const masked = maskCommentMetadata(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.slice(result.threads[0].from, result.threads[0].to)).toBe("selected 💎 text");
  });

  it("keeps malformed and unmatched markers byte-for-byte and reports repair errors", () => {
    const source = 'A <!-- geode-comment:v1 id="x" data="not-json" -->B';
    const result = parseCommentThreads(source);
    expect(result.threads).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(stripCommentMetadata(source)).toBe(source);
  });

  it.each([
    ['<!-- geode-comment:v1 id="x" data="!!!" -->text<!-- geode-comment-end:x -->', "malformed"],
    ['<!-- geode-comment:v1 id="x" data="abc', "truncated"],
    ['<!-- geode-comment-end:x -->', "stray"],
    [createCommentMarkers("x", { messages: [] }).open + createCommentMarkers("x", { messages: [] }).close + createCommentMarkers("x", { messages: [] }).open + createCommentMarkers("x", { messages: [] }).close, "duplicate"],
    [createCommentMarkers("x", { messages: [] }).open + createCommentMarkers("y", { messages: [] }).open + 'text' + createCommentMarkers("x", { messages: [] }).close + createCommentMarkers("y", { messages: [] }).close, "nested"],
    [createCommentMarkers("x", { messages: [] }).open + 'text' + createCommentMarkers("y", { messages: [] }).close, "crossed"],
  ])("preserves and reports %s marker corruption", (source) => {
    expect(parseCommentThreads(source).errors.length).toBeGreaterThan(0);
    expect(stripCommentMetadata(source)).toBe(source);
  });

  it("marks adjacent marker pairs as detached", () => {
    const markers = createCommentMarkers("thread-1", { messages: [] });
    expect(parseCommentThreads(markers.open + markers.close).threads[0].detached).toBe(true);
  });
});

describe("comment range validation", () => {
  it.each([
    ["frontmatter", "---\ntitle: x\n---\nBody", 4, 9],
    ["fenced code", "```ts\nconst x = 1\n```", 6, 11],
    ["inline code", "Use `code` here", 5, 9],
    ["HTML comment", "A <!-- hidden --> B", 7, 13],
    ["link destination", "[label](destination)", 9, 14],
    ["structural syntax", "# Heading", 0, 1],
  ])("rejects a selection inside %s", (_label, source, from, to) => {
    expect(() => validateCommentRange(source, { from, to })).toThrow(CommentFormatError);
  });

  it("rejects empty, overlapping, and existing-marker selections", () => {
    const markers = createCommentMarkers("thread-1", { messages: [] });
    const source = `A ${markers.open}selected${markers.close} Z`;
    expect(() => validateCommentRange(source, { from: 1, to: 1 })).toThrow("non-empty");
    const thread = parseCommentThreads(source).threads[0];
    expect(() => validateCommentRange(source, { from: thread.from + 1, to: thread.to })).toThrow("overlap");
    expect(() => validateCommentRange(source, { from: source.indexOf("geode-comment"), to: source.indexOf("selected") })).toThrow();
  });

  it("accepts ordinary prose and adjacent comment ranges", () => {
    expect(validateCommentRange("Hello world", { from: 0, to: 5 })).toEqual({ from: 0, to: 5 });
    const markers = createCommentMarkers("existing", { messages: [] });
    const source = `${markers.open}Hello${markers.close}.`;
    const from = source.lastIndexOf(".");
    expect(validateCommentRange(source, { from, to: from + 1 })).toEqual({ from, to: from + 1 });
  });

  it("rejects ranges spanning text blocks or containing Markdown delimiters", () => {
    expect(() => validateCommentRange("First\n\nSecond", { from: 0, to: 13 })).toThrow("text block");
    expect(() => validateCommentRange("A **bold** word", { from: 2, to: 10 })).toThrow();
  });

  it.each([
    ["reference link", "[label][ref]", 0, 12],
    ["setext", "Heading\n===", 0, 11],
    ["tilde fence", "~~~js\ncode\n~~~", 6, 10],
    ["indented code", "    code", 4, 8],
    ["multi-backtick", "Use ``code``", 6, 10],
    ["table pipe", "| a | b |", 0, 1],
    ["range spanning a table pipe", "| a | b |", 2, 7],
    ["table delimiter row", "| a | b |\n| --- | --- |\n| c | d |", 12, 15],
    ["range spanning a real table pipe", "| a | b |\n| --- | --- |\n| c | d |", 26, 31],
    ["wikilink text", "[[Target]]", 2, 8],
    ["tag text", "A #topic here", 3, 8],
    ["URL text", "See https://example.com now", 12, 19],
    ["emphasis content", "A *word* here", 3, 7],
    ["raw HTML", '<span title="value">content</span>', 13, 18],
    ["reference definition", "[ref]: https://example.com", 8, 15],
    ["image destination", "![alt](image.png)", 8, 13],
    ["footnote definition", "[^note]: explanation", 2, 6],
    ["WWW autolink", "See www.example.com now", 8, 15],
    ["email autolink", "Mail person@example.com now", 7, 13],
    ["angle email autolink", "Mail <person@example.com> now", 7, 13],
    ["character reference", "A &amp; B", 3, 6],
    ["escape", "A \\*literal asterisk", 2, 4],
    ["variable code span", "Use ``code ` within`` now", 7, 16],
    ["frontmatter property after blank line", "---\ntitle: one\n\nproperty: value\n---\nBody", 27, 30],
    ["block ID", "Plain paragraph ^block-id", 17, 22],
    ["standalone block ID", "^block-id", 2, 7],
    ["block ID on its own line after prose", "Paragraph text\n^block-id", 17, 22],
    ["inline LaTeX", "Math $x+y$ here", 6, 9],
    ["display LaTeX", "Before\n$$x+y$$\nAfter", 10, 13],
    ["multiline display LaTeX after a blank line", "$$\nx\n\ny\n$$", 6, 7],
    ["attached multiline display LaTeX", "Before $$\nx\n\ny\n$$", 13, 14],
    ["spaced multiline display LaTeX opener", "$$ x\n\ny\n$$", 6, 7],
    ["Obsidian comment", "Visible %%hidden%% text", 11, 17],
    ["multiline Obsidian comment after a blank line", "%%\nhidden\n\nstill hidden\n%%", 12, 17],
    ["attached multiline Obsidian comment", "Before %%hidden\n\nstill hidden%% After", 17, 22],
    ["spaced multiline Obsidian comment opener", "%% hidden\n\nstill hidden\n%%", 13, 18],
    ["unclosed attached Obsidian comment", "Before %%hidden to EOF", 10, 16],
    ["unclosed attached display LaTeX", "Before $$x\n\ny to EOF", 13, 14],
  ])("rejects semantic %s selections", (_name, source, from, to) => {
    expect(() => validateCommentRange(source, { from, to })).toThrow();
  });

  it("does not protect plain prose outside multiline math and comment blocks", () => {
    const source = "Before $$\nx\n\ny\n$$ After\n\nBetween\n\nLead %%hidden\n\nstill hidden%% Tail";
    for (const selected of ["Before", "After", "Between", "Lead", "Tail"]) {
      const from = source.indexOf(selected);
      expect(validateCommentRange(source, { from, to: from + selected.length })).toEqual({
        from,
        to: from + selected.length,
      });
    }
  });

  it("allows unpaired literal dollar and percent characters in ordinary prose", () => {
    const source = "Price is $5 and progress is 100% complete";
    for (const selected of ["Price", "progress", "complete"]) {
      const from = source.indexOf(selected);
      expect(validateCommentRange(source, { from, to: from + selected.length })).toEqual({
        from,
        to: from + selected.length,
      });
    }
  });

  it.each([
    ["display math delimiter in inline code", "Use `$$` then ordinary words"],
    ["Obsidian comment delimiter in inline code", "Use `%%` then ordinary words"],
    ["display math delimiter in fenced code", "```text\n$$\n```\n\nordinary words"],
    ["Obsidian comment delimiter in fenced code", "```text\n%%\n```\n\nordinary words"],
    ["escaped display math delimiter", "Use \\$$ then ordinary words"],
    ["escaped Obsidian comment delimiter", "Use \\%% then ordinary words"],
    ["display math delimiter in an Obsidian comment", "Visible %%hidden $$ literal%% then ordinary words"],
    ["Obsidian comment delimiter in display math", "Before $$ x %% literal $$ then ordinary words"],
    ["display math delimiter in a highlight", "Use ==$$== then ordinary words"],
    ["Obsidian comment delimiter in a highlight", "Use ==%%== then ordinary words"],
  ])("allows plain prose after %s", (_name, source) => {
    const selected = "ordinary";
    const from = source.indexOf(selected);
    expect(validateCommentRange(source, { from, to: from + selected.length })).toEqual({
      from,
      to: from + selected.length,
    });
  });

  it.each([
    ["autolink", "See www.example.com now", "example"],
    ["entity", "A &amp; B", "amp"],
    ["variable code span", "Use ``code ` within`` now", "within"],
  ])("proves forced marker insertion changes %s rendering and rejects it", (_name, source, selected) => {
    const from = source.indexOf(selected);
    const markers = createCommentMarkers("render-check", { messages: [] });
    const forced = source.slice(0, from) + markers.open + selected + markers.close + source.slice(from + selected.length);
    expect(renderRawMarkdown(forced)).not.toBe(renderRawMarkdown(source));
    expect(() => validateCommentRange(source, { from, to: from + selected.length })).toThrow(CommentFormatError);
  });

  it("renders allowed commented plain prose equivalently through Geode's document renderer", async () => {
    const source = "Ordinary prose remains readable";
    const from = source.indexOf("prose");
    const to = from + "prose".length;
    const markers = createCommentMarkers("render-plain", { messages: [] });
    const commented = source.slice(0, from) + markers.open + source.slice(from, to) + markers.close + source.slice(to);

    expect(validateCommentRange(source, { from, to })).toEqual({ from, to });
    expect(await renderDocument(commented)).toBe(await renderDocument(source));
  });

  it("keeps a forced marker inside a multiline Obsidian comment suppressed by Geode rendering", async () => {
    const source = "Visible %%hidden\n\nstill hidden%% Tail";
    const selected = "still hidden";
    const from = source.indexOf(selected);
    const markers = createCommentMarkers("render-multiline-comment", { messages: [] });
    const forced = source.slice(0, from) + markers.open + selected + markers.close + source.slice(from + selected.length);

    expect(await renderDocument(forced)).toBe(await renderDocument(source));
    expect(() => validateCommentRange(source, { from, to: from + selected.length })).toThrow(CommentFormatError);
  });
});

/**
 * Prose inside a heading, list item, or table cell is commentable: only the
 * structural marker itself (`#`, the bullet, the `|`) is off-limits. Each case
 * anchors a word and checks the three things that must hold — the range is
 * accepted, Geode renders the commented document identically, and the thread
 * round-trips back to the exact anchor text.
 */
describe("comments in structural blocks", () => {
  const CONTEXTS: Array<[string, string, string]> = [
    ["h1 first word", "# Alpha beta gamma", "Alpha"],
    ["h1 middle word", "# Alpha beta gamma", "beta"],
    ["h1 last word", "# Alpha beta gamma", "gamma"],
    ["h1 whole text", "# Alpha beta gamma", "Alpha beta gamma"],
    ["h3", "### Alpha beta gamma", "beta"],
    ["h6", "###### Alpha beta gamma", "beta"],
    ["setext heading", "Alpha beta gamma\n================", "beta"],
    ["setext heading first word", "Alpha beta gamma\n================", "Alpha"],
    ["bullet first word", "- alpha beta gamma", "alpha"],
    ["bullet middle word", "- alpha beta gamma", "beta"],
    ["star bullet", "* alpha beta gamma", "beta"],
    ["ordered list", "1. alpha beta gamma", "alpha"],
    ["ordered paren list", "1) alpha beta gamma", "beta"],
    ["task list", "- [ ] alpha beta gamma", "alpha"],
    ["checked task list", "- [x] alpha beta gamma", "beta"],
    ["second list item", "- first item\n- second item\n- third item", "second"],
    ["nested list item", "- outer item\n  - inner alpha beta", "inner"],
    ["nested ordered item", "1. outer item\n   1. inner alpha beta", "alpha"],
    ["table header cell", "| head a | head b |\n| --- | --- |\n| alpha | beta |", "head b"],
    ["table body cell", "| head a | head b |\n| --- | --- |\n| alpha | beta |", "alpha"],
    ["table body cell word", "| head a | head b |\n| --- | --- |\n| one two | beta |", "two"],
  ];

  it.each(CONTEXTS)("accepts and round-trips a comment on %s", async (_label, source, word) => {
    const from = source.indexOf(word);
    const to = from + word.length;
    const markers = createCommentMarkers("structural", { messages: [] });
    const commented = source.slice(0, from) + markers.open + source.slice(from, to) + markers.close + source.slice(to);

    expect(validateCommentRange(source, { from, to })).toEqual({ from, to });
    expect(await renderDocument(commented)).toBe(await renderDocument(source));
    expect(stripCommentMetadata(commented)).toBe(source);
    const parsed = parseCommentThreads(commented);
    expect(parsed.errors).toEqual([]);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].anchorText).toBe(word);
  });

  it.each([
    ["heading marker", "# Alpha beta", 0, 1],
    ["list bullet", "- alpha beta", 0, 1],
    ["ordered list marker", "1. alpha beta", 0, 2],
    ["task checkbox", "- [ ] alpha beta", 2, 5],
    ["setext underline", "Alpha beta\n==========", 11, 21],
    ["range spanning the heading marker", "# Alpha beta", 0, 7],
  ])("still rejects %s", (_label, source, from, to) => {
    expect(() => validateCommentRange(source, { from, to })).toThrow(CommentFormatError);
  });
});

describe("narrowCommentRange", () => {
  it.each([
    ["a heading line selected whole", "# Alpha beta", "Alpha beta"],
    ["a bullet line selected whole", "- alpha beta", "alpha beta"],
    ["an ordered item selected whole", "1. alpha beta", "alpha beta"],
    ["a task item selected whole", "- [ ] alpha beta", "alpha beta"],
    ["a table row selected whole", "| a | b |\n| --- | --- |\n| alpha | beta |", "alpha"],
  ])("trims %s to its prose", (_label, source, expected) => {
    const lineFrom = source.lastIndexOf("\n") + 1;
    const narrowed = narrowCommentRange(source, { from: lineFrom, to: source.length });
    expect(narrowed).not.toBeNull();
    expect(source.slice(narrowed!.from, narrowed!.to)).toBe(expected);
    // Whatever it returns must itself be a legal range.
    expect(validateCommentRange(source, narrowed!)).toEqual(narrowed);
  });

  it("returns an already-legal range unchanged", () => {
    const source = "# Alpha beta";
    const from = source.indexOf("beta");
    expect(narrowCommentRange(source, { from, to: from + 4 })).toEqual({ from, to: from + 4 });
  });

  it("prefers the longest commentable run when a selection straddles protected syntax", () => {
    const source = "one `code` three four";
    const narrowed = narrowCommentRange(source, { from: 0, to: source.length });
    expect(narrowed).not.toBeNull();
    expect(source.slice(narrowed!.from, narrowed!.to)).toBe("three four");
  });

  it.each([
    ["a fenced code block", "```ts\nconst x = 1\n```", 6, 16],
    ["an empty selection", "# Alpha beta", 4, 4],
    ["a selection of only the heading marker", "# Alpha beta", 0, 2],
  ])("returns null for %s", (_label, source, from, to) => {
    expect(narrowCommentRange(source, { from, to })).toBeNull();
  });

  it("anchors to a single item when a selection spans two list items", () => {
    // Deliberate: an anchor cannot straddle a list mark, so a multi-item drag
    // resolves to the longest single item rather than being refused. Earlier
    // candidates win ties, so the choice is stable rather than arbitrary.
    const source = "- first item\n- second item";
    const narrowed = narrowCommentRange(source, { from: 0, to: source.length });
    expect(narrowed).not.toBeNull();
    expect(source.slice(narrowed!.from, narrowed!.to)).toBe("second item");
  });

  it("returns null rather than throwing when the document has malformed markers", () => {
    const source = 'A <!-- geode-comment:v1 id="x" data="not-json" -->B';
    expect(narrowCommentRange(source, { from: 0, to: 1 })).toBeNull();
  });
});

/**
 * A marker's bytes begin with `<!--`, which is CommonMark's HTML-block start
 * condition. Sitting on a line's first content position that would swallow the
 * whole line — silently breaking Live Preview's list and heading decorations,
 * which read the raw editor document rather than the stripped one.
 * `geodeCommentMarkerSyntax` is what prevents it, so these assert block shape is
 * identical with and without the marker.
 */
describe("editor syntax tree with markers at a line's first content position", () => {
  const treeParser = parser.configure([GFM, geodeCommentMarkerSyntax]);

  // Nodes lying entirely inside a marker's own bytes are the marker's business
  // and are dropped. A marker that corrupted the line would produce a node
  // spanning *beyond* its span (e.g. a CommentBlock swallowing the whole list
  // item), which survives this filter and fails the comparison.
  const blockShape = (source: string): string[] => {
    const markerSpans = parseCommentThreads(source).threads.flatMap((thread) => [
      { from: thread.openFrom, to: thread.openTo },
      { from: thread.closeFrom, to: thread.closeTo },
    ]);
    const inMarker = (from: number, to: number) =>
      markerSpans.some((span) => from >= span.from && to <= span.to);
    const shape: string[] = [];
    treeParser.parse(source).iterate({
      enter(node) {
        if (node.name === "GeodeCommentMarker" || inMarker(node.from, node.to)) return;
        shape.push(node.name);
      },
    });
    return shape;
  };

  it.each([
    ["paragraph", "Alpha beta gamma", "Alpha"],
    ["bullet item", "- alpha beta gamma", "alpha"],
    ["ordered item", "1. alpha beta gamma", "alpha"],
    ["task item", "- [ ] alpha beta gamma", "alpha"],
    ["nested item", "- outer item\n  - inner alpha", "inner"],
    ["second list item", "- first item\n- second item", "second"],
    ["setext heading", "Alpha beta gamma\n================", "Alpha"],
    ["atx heading", "# Alpha beta gamma", "Alpha"],
    ["table cell", "| a | b |\n| --- | --- |\n| alpha | beta |", "alpha"],
  ])("leaves %s block structure unchanged", (_label, source, word) => {
    const from = source.indexOf(word);
    const to = from + word.length;
    const markers = createCommentMarkers("first-offset", { messages: [] });
    const commented = source.slice(0, from) + markers.open + source.slice(from, to) + markers.close + source.slice(to);

    expect(blockShape(commented)).toEqual(blockShape(source));
  });
});
