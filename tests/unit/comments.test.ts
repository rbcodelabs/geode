import { describe, expect, it } from "vitest";
import {
  CommentFormatError,
  createCommentMarkers,
  parseCommentThreads,
  stripCommentMetadata,
  maskCommentMetadata,
  validateCommentRange,
} from "../../src/renderer/comments/model";

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
  });

  it("rejects ranges spanning text blocks or containing Markdown delimiters", () => {
    expect(() => validateCommentRange("First\n\nSecond", { from: 0, to: 13 })).toThrow("text block");
    expect(() => validateCommentRange("A **bold** word", { from: 2, to: 10 })).toThrow("syntax");
  });
});
