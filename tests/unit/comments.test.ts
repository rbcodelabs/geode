import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import {
  CommentFormatError,
  createCommentMarkers,
  parseCommentThreads,
  stripCommentMetadata,
  maskCommentMetadata,
  validateCommentRange,
} from "../../src/renderer/comments/model";
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
    ["table delimiter", "| a | b |", 2, 3],
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
    ["Obsidian comment", "Visible %%hidden%% text", 11, 17],
    ["multiline Obsidian comment after a blank line", "%%\nhidden\n\nstill hidden\n%%", 12, 17],
  ])("rejects semantic %s selections", (_name, source, from, to) => {
    expect(() => validateCommentRange(source, { from, to })).toThrow();
  });

  it("does not protect plain prose outside multiline math and comment blocks", () => {
    const source = "Before\n\n$$\nx\n\ny\n$$\n\nBetween\n\n%%\nhidden\n\nstill hidden\n%%\n\nAfter";
    for (const selected of ["Before", "Between", "After"]) {
      const from = source.indexOf(selected);
      expect(validateCommentRange(source, { from, to: from + selected.length })).toEqual({
        from,
        to: from + selected.length,
      });
    }
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
    const source = "Visible\n\n%%\nhidden\n\nstill hidden\n%%\n\nTail";
    const selected = "still hidden";
    const from = source.indexOf(selected);
    const markers = createCommentMarkers("render-multiline-comment", { messages: [] });
    const forced = source.slice(0, from) + markers.open + selected + markers.close + source.slice(from + selected.length);

    expect(await renderDocument(forced)).toBe(await renderDocument(source));
    expect(() => validateCommentRange(source, { from, to: from + selected.length })).toThrow(CommentFormatError);
  });
});
