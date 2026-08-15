import { describe, expect, it } from "vitest";
import { parseFrontMatterTags, getAllTags } from "../../src/renderer/api/frontmatter";
import type { CachedMetadata } from "../../src/renderer/types";

/**
 * These module-level helpers are what obsidian-tasks calls per file while
 * building its task cache. `parseFrontMatterTags` being undefined threw an
 * uncaught error mid-scan, so no tasks were cached and ```tasks rendered
 * empty. Coverage: the null-vs-empty contract callers branch on, plus the
 * string/array normalization Obsidian documents.
 */

describe("parseFrontMatterTags", () => {
  it("returns null for null frontmatter or no tag keys", () => {
    expect(parseFrontMatterTags(null)).toBeNull();
    expect(parseFrontMatterTags({})).toBeNull();
    expect(parseFrontMatterTags({ title: "x" })).toBeNull();
  });

  it("reads an array of tags and #-prefixes them", () => {
    expect(parseFrontMatterTags({ tags: ["a", "b"] })).toEqual(["#a", "#b"]);
  });

  it("reads a comma/space separated string", () => {
    expect(parseFrontMatterTags({ tags: "a, b c" })).toEqual(["#a", "#b", "#c"]);
  });

  it("accepts the singular `tag` key", () => {
    expect(parseFrontMatterTags({ tag: "solo" })).toEqual(["#solo"]);
  });

  it("does not double-prefix values that already start with #", () => {
    expect(parseFrontMatterTags({ tags: ["#a", "b"] })).toEqual(["#a", "#b"]);
  });

  it("returns null when tags are present but all empty/whitespace", () => {
    expect(parseFrontMatterTags({ tags: ["", "  "] })).toBeNull();
    expect(parseFrontMatterTags({ tags: "" })).toBeNull();
  });
});

describe("getAllTags", () => {
  const meta = (tags: string[]): CachedMetadata =>
    ({
      frontmatter: null,
      frontmatterEndOffset: 0,
      links: [],
      embeds: [],
      tags: tags.map((tag) => ({
        tag,
        position: { start: { line: 0, ch: 0, offset: 0 }, end: { line: 0, ch: 0, offset: 0 } },
      })),
      headings: [],
      aliases: [],
    }) as CachedMetadata;

  it("returns null for missing cache or no tags", () => {
    expect(getAllTags(null)).toBeNull();
    expect(getAllTags(undefined)).toBeNull();
    expect(getAllTags(meta([]))).toBeNull();
  });

  it("#-prefixes every tag from the cache (which already merges FM + inline)", () => {
    expect(getAllTags(meta(["work", "home"]))).toEqual(["#work", "#home"]);
  });

  it("de-duplicates while preserving first-appearance order", () => {
    expect(getAllTags(meta(["a", "b", "a", "c", "b"]))).toEqual(["#a", "#b", "#c"]);
  });

  it("tolerates tags already carrying a leading #", () => {
    expect(getAllTags(meta(["#a", "a"]))).toEqual(["#a"]);
  });
});
