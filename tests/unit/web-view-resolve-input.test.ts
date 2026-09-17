import { describe, expect, it } from "vitest";
import { isUrlShaped, resolveWebInput } from "../../src/renderer/views/web-view";

const searchEngine = "https://www.google.com/search?q=";

describe("resolveWebInput", () => {
  it("passes a fully-qualified URL through unchanged", () => {
    expect(resolveWebInput("https://example.com/path", searchEngine)).toBe("https://example.com/path");
  });

  it("accepts non-http(s) schemes too, e.g. a custom protocol", () => {
    expect(resolveWebInput("obsidian://open?vault=x", searchEngine)).toBe("obsidian://open?vault=x");
  });

  it("prefixes a bare domain with https://", () => {
    expect(resolveWebInput("example.com", searchEngine)).toBe("https://example.com");
  });

  it("prefixes a domain with a path with https://", () => {
    expect(resolveWebInput("example.com/some/path", searchEngine)).toBe("https://example.com/some/path");
  });

  it("routes plain text with no dot through the search engine, URL-encoded", () => {
    expect(resolveWebInput("hello world", searchEngine)).toBe(`${searchEngine}${encodeURIComponent("hello world")}`);
  });

  it("routes text containing a slash but no domain-shaped host through search", () => {
    expect(resolveWebInput("a/b", searchEngine)).toBe(`${searchEngine}${encodeURIComponent("a/b")}`);
  });
});

describe("isUrlShaped", () => {
  it("is true for a fully-qualified URL", () => {
    expect(isUrlShaped("https://example.com")).toBe(true);
  });

  it("is true for a bare domain", () => {
    expect(isUrlShaped("example.com")).toBe(true);
  });

  it("is false for plain search-query-shaped text", () => {
    expect(isUrlShaped("hello world")).toBe(false);
    expect(isUrlShaped("release notes")).toBe(false);
  });

  it("is false for empty input", () => {
    expect(isUrlShaped("")).toBe(false);
  });
});
