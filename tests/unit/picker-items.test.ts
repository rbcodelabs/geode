import { describe, expect, it } from "vitest";
import { buildPickerItems, type PickerItem } from "../../src/renderer/app";
import type { BookmarkLink } from "../../src/renderer/bookmarks";
import type { TFile } from "../../src/renderer/types";

const searchEngine = "https://www.google.com/search?q=";

function file(path: string): TFile {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  return {
    kind: "file",
    path,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: "md",
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: slash === -1 ? "" : path.slice(0, slash),
  };
}

describe("buildPickerItems", () => {
  it("lists every file (trivially matched) and no fixed items for an empty query", () => {
    const files = [file("Daily Plan.md"), file("Roadmap.md")];
    const items = buildPickerItems("", files, [], searchEngine);
    expect(items).toEqual<PickerItem[]>([
      { kind: "file", file: files[0] },
      { kind: "file", file: files[1] },
    ]);
  });

  it("appends New note and Search the web, in that order, for non-matching non-URL text", () => {
    const files = [file("Daily Plan.md")];
    const items = buildPickerItems("zzz nomatch", files, [], searchEngine);
    expect(items).toEqual<PickerItem[]>([
      { kind: "new-note", title: "zzz nomatch" },
      { kind: "search-web", query: "zzz nomatch" },
    ]);
  });

  it("puts fuzzy-matched files before the trailing New note / Search the web items", () => {
    const plan = file("Daily Plan.md");
    const other = file("Roadmap.md");
    const items = buildPickerItems("plan", [plan, other], [], searchEngine);
    expect(items).toEqual<PickerItem[]>([
      { kind: "file", file: plan },
      { kind: "new-note", title: "plan" },
      { kind: "search-web", query: "plan" },
    ]);
  });

  it("pins an Open <url> item first for a bare domain, resolved via resolveWebInput", () => {
    const items = buildPickerItems("example.com", [], [], searchEngine);
    expect(items).toEqual<PickerItem[]>([
      { kind: "open-url", url: "https://example.com" },
      { kind: "new-note", title: "example.com" },
      { kind: "search-web", query: "example.com" },
    ]);
  });

  it("pins an Open <url> item first for a fully-qualified URL, unchanged", () => {
    const items = buildPickerItems("https://example.com/path", [], [], searchEngine);
    expect(items[0]).toEqual<PickerItem>({ kind: "open-url", url: "https://example.com/path" });
  });

  it("orders open-url, then file matches, then new-note/search-web when all four kinds apply", () => {
    const domainNote = file("example.com notes.md");
    const items = buildPickerItems("example.com", [domainNote], [], searchEngine);
    expect(items).toEqual<PickerItem[]>([
      { kind: "open-url", url: "https://example.com" },
      { kind: "file", file: domainNote },
      { kind: "new-note", title: "example.com" },
      { kind: "search-web", query: "example.com" },
    ]);
  });

  it("does not add open-url or new-note/search-web items for text matched only by files with an empty query", () => {
    const files = Array.from({ length: 5 }, (_, i) => file(`Note ${i}.md`));
    const items = buildPickerItems("", files, [], searchEngine);
    expect(items.every((i) => i.kind === "file")).toBe(true);
    expect(items).toHaveLength(5);
  });

  it("caps the combined list at 80 items, always keeping New note / Search the web at the end", () => {
    const files = Array.from({ length: 200 }, (_, i) => file(`Match ${i}.md`));
    const items = buildPickerItems("match", files, [], searchEngine);
    expect(items).toHaveLength(80);
    expect(items[78]).toEqual<PickerItem>({ kind: "new-note", title: "match" });
    expect(items[79]).toEqual<PickerItem>({ kind: "search-web", query: "match" });
    expect(items.slice(0, 78).every((i) => i.kind === "file")).toBe(true);
  });

  it("caps the combined list at 80 items even when an open-url item is also pinned", () => {
    const files = Array.from({ length: 200 }, (_, i) => file(`example.com match ${i}.md`));
    const items = buildPickerItems("example.com", files, [], searchEngine);
    expect(items).toHaveLength(80);
    expect(items[0]).toEqual<PickerItem>({ kind: "open-url", url: "https://example.com" });
    expect(items[78]).toEqual<PickerItem>({ kind: "new-note", title: "example.com" });
    expect(items[79]).toEqual<PickerItem>({ kind: "search-web", query: "example.com" });
  });

  it("matches website bookmarks by trimmed title and by URL", () => {
    const titled: BookmarkLink = {
      type: "link",
      id: "docs",
      title: "  Geode Documentation  ",
      url: "https://geode.rbcodelabs.com/docs",
    };

    expect(buildPickerItems("Geode Documentation", [], [titled], searchEngine)[0]).toEqual<PickerItem>({
      kind: "bookmark",
      bookmark: titled,
    });
    expect(buildPickerItems("rbcodelabs.com", [], [titled], searchEngine)[1]).toEqual<PickerItem>({
      kind: "bookmark",
      bookmark: titled,
    });
  });

  it("uses a bookmark URL as its searchable fallback when the title is blank", () => {
    const untitled: BookmarkLink = {
      type: "link",
      id: "reference",
      title: "   ",
      url: "https://reference.example/guide",
    };

    expect(buildPickerItems("reference", [], [untitled], searchEngine)[0]).toEqual<PickerItem>({
      kind: "bookmark",
      bookmark: untitled,
    });
  });

  it("ranks matching files and bookmarks together while preserving fixed action order and the cap", () => {
    const files = Array.from({ length: 100 }, (_, i) => file(`Match ${i}.md`));
    const bookmark: BookmarkLink = {
      type: "link",
      id: "best-match",
      title: "match",
      url: "https://example.com/match",
    };
    const items = buildPickerItems("match", files, [bookmark], searchEngine);

    expect(items).toHaveLength(80);
    expect(items[0]).toEqual<PickerItem>({ kind: "bookmark", bookmark });
    expect(items[78]).toEqual<PickerItem>({ kind: "new-note", title: "match" });
    expect(items[79]).toEqual<PickerItem>({ kind: "search-web", query: "match" });
  });
});
