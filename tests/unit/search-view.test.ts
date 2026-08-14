import { describe, expect, it } from "vitest";
import { matchFileAgainstTerms, parseQuery } from "../../src/renderer/views/search-view";
import type { TFile, TagCache } from "../../src/renderer/types";

describe("parseQuery", () => {
  it("parses plain text terms", () => {
    expect(parseQuery("hello world")).toEqual([
      { op: "text", value: "hello", negated: false, regex: null },
      { op: "text", value: "world", negated: false, regex: null },
    ]);
  });

  it("parses operator prefixes: tag:, path:, file:, content:, line:", () => {
    const terms = parseQuery("tag:project path:Projects file:Roadmap content:foo line:bar");
    expect(terms.map((t) => t.op)).toEqual(["tag", "path", "file", "content", "line"]);
    expect(terms.map((t) => t.value)).toEqual(["project", "projects", "roadmap", "foo", "bar"]);
  });

  it("parses quoted phrases as a single term, preserving internal spaces", () => {
    const terms = parseQuery('"hello world" foo');
    expect(terms[0]).toEqual({ op: "text", value: "hello world", negated: false, regex: null });
    expect(terms[1].value).toBe("foo");
  });

  it("parses -negation on plain terms and operator terms", () => {
    const terms = parseQuery("-foo -tag:done");
    expect(terms[0]).toMatchObject({ op: "text", value: "foo", negated: true });
    expect(terms[1]).toMatchObject({ op: "tag", value: "done", negated: true });
  });

  it("parses /regex/ terms into a case-insensitive global RegExp", () => {
    const terms = parseQuery("/f[o]+/");
    expect(terms[0].regex).toBeInstanceOf(RegExp);
    expect(terms[0].regex?.source).toBe("f[o]+");
    expect(terms[0].regex?.flags).toContain("i");
    expect(terms[0].regex?.flags).toContain("g");
  });

  it("falls back to a literal term when the regex is invalid", () => {
    const terms = parseQuery("/[/");
    expect(terms[0].regex).toBeNull();
    expect(terms[0].value).toBe("[");
  });

  it("ignores empty query strings", () => {
    expect(parseQuery("")).toEqual([]);
    expect(parseQuery("   ")).toEqual([]);
  });

  it("combines multiple operators and phrases in one query", () => {
    const terms = parseQuery('tag:geode "start here" -path:archive');
    expect(terms).toEqual([
      { op: "tag", value: "geode", negated: false, regex: null },
      { op: "text", value: "start here", negated: false, regex: null },
      { op: "path", value: "archive", negated: true, regex: null },
    ]);
  });
});

describe("matchFileAgainstTerms", () => {
  function file(path: string): TFile {
    const name = path.split("/").pop()!;
    const dot = name.lastIndexOf(".");
    return {
      kind: "file",
      path,
      name,
      basename: dot > 0 ? name.slice(0, dot) : name,
      extension: dot > 0 ? name.slice(dot + 1) : "",
      mtime: 0,
      ctime: 0,
      size: 0,
      parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    };
  }

  function tags(...names: string[]): TagCache[] {
    return names.map((tag) => ({
      tag,
      position: { start: { line: 0, ch: 0, offset: 0 }, end: { line: 0, ch: 0, offset: 0 } },
    }));
  }

  const noTags = () => [];

  it("matches file: against the file name", () => {
    const f = file("Projects/Roadmap.md");
    const terms = parseQuery("file:roadmap");
    expect(matchFileAgainstTerms(f, null, terms, noTags)).not.toBeNull();
    expect(matchFileAgainstTerms(file("Other.md"), null, terms, noTags)).toBeNull();
  });

  it("matches path: against the full vault path", () => {
    const terms = parseQuery("path:projects/");
    expect(matchFileAgainstTerms(file("Projects/Roadmap.md"), null, terms, noTags)).not.toBeNull();
    expect(matchFileAgainstTerms(file("Welcome.md"), null, terms, noTags)).toBeNull();
  });

  it("matches tag: exactly or as a nested tag prefix", () => {
    const terms = parseQuery("tag:project");
    const f = file("A.md");
    expect(matchFileAgainstTerms(f, null, terms, () => tags("project"))).not.toBeNull();
    expect(matchFileAgainstTerms(f, null, terms, () => tags("project/geode"))).not.toBeNull();
    expect(matchFileAgainstTerms(f, null, terms, () => tags("projectile"))).toBeNull();
    expect(matchFileAgainstTerms(f, null, terms, noTags)).toBeNull();
  });

  it("matches content by substring and returns a snippet", () => {
    const terms = parseQuery("waffles");
    const f = file("A.md");
    const result = matchFileAgainstTerms(f, "I like waffles for breakfast.", terms, noTags);
    expect(result).not.toBeNull();
    expect(result?.snippets[0].text).toContain("waffles");
  });

  it("matches content via /regex/ terms", () => {
    const terms = parseQuery("/wa[ff]+les/");
    const result = matchFileAgainstTerms(file("A.md"), "I like waffles.", terms, noTags);
    expect(result).not.toBeNull();
  });

  it("excludes files that match a negated term", () => {
    const terms = parseQuery("-waffles");
    expect(matchFileAgainstTerms(file("A.md"), "I like waffles.", terms, noTags)).toBeNull();
    expect(matchFileAgainstTerms(file("A.md"), "I like pancakes.", terms, noTags)).not.toBeNull();
  });

  it("requires every term to match (implicit AND)", () => {
    const terms = parseQuery("waffles tag:breakfast");
    const f = file("A.md");
    expect(matchFileAgainstTerms(f, "I like waffles.", terms, () => tags("breakfast"))).not.toBeNull();
    expect(matchFileAgainstTerms(f, "I like waffles.", terms, noTags)).toBeNull();
    expect(matchFileAgainstTerms(f, "I like pancakes.", terms, () => tags("breakfast"))).toBeNull();
  });
});
