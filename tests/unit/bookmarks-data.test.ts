import { describe, expect, it } from "vitest";
import {
  addBookmark,
  bookmarkDefaultLabel,
  collectGroups,
  createEmptyRoot,
  createGroup,
  descendantGroupIds,
  findBookmarkByPath,
  findItemById,
  isBookmarked,
  moveItem,
  normalizeBookmarksRoot,
  removeBookmark,
  renameBookmark,
  reorderSibling,
  toggleGroupExpanded,
  type Bookmark,
  type BookmarkGroup,
  type BookmarksRoot,
} from "../../src/renderer/bookmarks";

function file(id: string, path: string, title?: string): Bookmark {
  return { type: "file", id, path, ...(title !== undefined ? { title } : {}) };
}

function folder(id: string, path: string, title?: string): Bookmark {
  return { type: "folder", id, path, ...(title !== undefined ? { title } : {}) };
}

describe("addBookmark", () => {
  it("adds a file bookmark to the root", () => {
    const root = createEmptyRoot();
    const next = addBookmark(root, file("1", "Note.md"));
    expect(next.items).toEqual([file("1", "Note.md")]);
  });

  it("adds a folder bookmark to the root", () => {
    const root = createEmptyRoot();
    const next = addBookmark(root, folder("1", "Projects"));
    expect(next.items).toEqual([folder("1", "Projects")]);
  });

  it("does not mutate the input root", () => {
    const root = createEmptyRoot();
    addBookmark(root, file("1", "Note.md"));
    expect(root.items).toEqual([]);
  });

  it("adds a bookmark inside an existing group via opts.groupId", () => {
    let root = createGroup(createEmptyRoot(), "Reading list", { id: "g1" });
    root = addBookmark(root, file("1", "Note.md"), { groupId: "g1" });
    expect(root.items).toEqual([
      { type: "group", id: "g1", title: "Reading list", expanded: true, items: [file("1", "Note.md")] },
    ]);
  });

  it("adds a bookmark inside a nested group", () => {
    let root = createGroup(createEmptyRoot(), "Outer", { id: "outer" });
    root = createGroup(root, "Inner", { id: "inner", groupId: "outer" });
    root = addBookmark(root, file("1", "Note.md"), { groupId: "inner" });
    const outer = root.items[0] as BookmarkGroup;
    const inner = outer.items[0] as BookmarkGroup;
    expect(inner.items).toEqual([file("1", "Note.md")]);
  });

  it("preserves a custom title override", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "Note.md", "My custom title"));
    expect(root.items[0]).toEqual(file("1", "Note.md", "My custom title"));
  });
});

describe("createGroup", () => {
  it("creates an expanded top-level group with a generated id", () => {
    const root = createGroup(createEmptyRoot(), "Reading list");
    expect(root.items).toHaveLength(1);
    const group = root.items[0] as BookmarkGroup;
    expect(group.type).toBe("group");
    expect(group.title).toBe("Reading list");
    expect(group.expanded).toBe(true);
    expect(group.items).toEqual([]);
    expect(typeof group.id).toBe("string");
    expect(group.id.length).toBeGreaterThan(0);
  });

  it("uses a caller-supplied id when given", () => {
    const root = createGroup(createEmptyRoot(), "Reading list", { id: "fixed-id" });
    expect((root.items[0] as BookmarkGroup).id).toBe("fixed-id");
  });

  it("nests a group inside another group (nestable groups)", () => {
    let root = createGroup(createEmptyRoot(), "Outer", { id: "outer" });
    root = createGroup(root, "Inner", { id: "inner", groupId: "outer" });
    const outer = root.items[0] as BookmarkGroup;
    expect(outer.items).toEqual([{ type: "group", id: "inner", title: "Inner", expanded: true, items: [] }]);
  });

  it("does not mutate the input root", () => {
    const root = createEmptyRoot();
    createGroup(root, "Reading list");
    expect(root.items).toEqual([]);
  });
});

describe("removeBookmark", () => {
  it("removes a top-level file bookmark by id", () => {
    let root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    root = addBookmark(root, file("2", "B.md"));
    root = removeBookmark(root, "1");
    expect(root.items).toEqual([file("2", "B.md")]);
  });

  it("removes a bookmark nested inside a group", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = removeBookmark(root, "1");
    expect((root.items[0] as BookmarkGroup).items).toEqual([]);
  });

  it("cascade-removes everything inside a removed group", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = addBookmark(root, file("2", "B.md"), { groupId: "g1" });
    root = createGroup(root, "Nested", { id: "g2", groupId: "g1" });
    root = addBookmark(root, file("3", "C.md"), { groupId: "g2" });

    root = removeBookmark(root, "g1");

    expect(root.items).toEqual([]);
    expect(findItemById(root, "1")).toBeNull();
    expect(findItemById(root, "2")).toBeNull();
    expect(findItemById(root, "g2")).toBeNull();
    expect(findItemById(root, "3")).toBeNull();
  });

  it("is a no-op when the id is not found", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    const next = removeBookmark(root, "does-not-exist");
    expect(next.items).toEqual(root.items);
  });

  it("does not mutate the input root", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    const before = JSON.parse(JSON.stringify(root));
    removeBookmark(root, "1");
    expect(root).toEqual(before);
  });
});

describe("renameBookmark", () => {
  it("sets a custom title override on a file bookmark", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    const next = renameBookmark(root, "1", "Renamed");
    expect((next.items[0] as Bookmark).title).toBe("Renamed");
  });

  it("renames a group", () => {
    const root = createGroup(createEmptyRoot(), "Old name", { id: "g1" });
    const next = renameBookmark(root, "g1", "New name");
    expect((next.items[0] as BookmarkGroup).title).toBe("New name");
  });

  it("renames a bookmark nested inside a group", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = renameBookmark(root, "1", "Renamed");
    expect(((root.items[0] as BookmarkGroup).items[0] as Bookmark).title).toBe("Renamed");
  });

  it("is a no-op when the id is not found", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    const next = renameBookmark(root, "does-not-exist", "Renamed");
    expect(next.items).toEqual(root.items);
  });
});

describe("toggleGroupExpanded", () => {
  it("flips an expanded group to collapsed", () => {
    const root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    const next = toggleGroupExpanded(root, "g1");
    expect((next.items[0] as BookmarkGroup).expanded).toBe(false);
  });

  it("flips it back to expanded on a second toggle", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = toggleGroupExpanded(root, "g1");
    root = toggleGroupExpanded(root, "g1");
    expect((root.items[0] as BookmarkGroup).expanded).toBe(true);
  });

  it("toggles a nested group without affecting its parent", () => {
    let root = createGroup(createEmptyRoot(), "Outer", { id: "outer" });
    root = createGroup(root, "Inner", { id: "inner", groupId: "outer" });
    root = toggleGroupExpanded(root, "inner");
    const outer = root.items[0] as BookmarkGroup;
    expect(outer.expanded).toBe(true);
    expect((outer.items[0] as BookmarkGroup).expanded).toBe(false);
  });

  it("is a no-op when groupId is not found", () => {
    const root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    const next = toggleGroupExpanded(root, "does-not-exist");
    expect(next.items).toEqual(root.items);
  });
});

describe("isBookmarked / findBookmarkByPath", () => {
  it("finds a top-level file bookmark by path", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    expect(isBookmarked(root, "A.md")).toBe(true);
    expect(findBookmarkByPath(root, "A.md")).toEqual(file("1", "A.md"));
  });

  it("finds a bookmark nested inside a group", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    expect(isBookmarked(root, "A.md")).toBe(true);
    expect(findBookmarkByPath(root, "A.md")?.id).toBe("1");
  });

  it("returns false / null for a path that isn't bookmarked", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    expect(isBookmarked(root, "not-bookmarked.md")).toBe(false);
    expect(findBookmarkByPath(root, "not-bookmarked.md")).toBeNull();
  });

  it("returns false / null on an empty root", () => {
    const root = createEmptyRoot();
    expect(isBookmarked(root, "A.md")).toBe(false);
    expect(findBookmarkByPath(root, "A.md")).toBeNull();
  });
});

describe("reorderSibling", () => {
  it("moves a top-level item to a later index", () => {
    let root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    root = addBookmark(root, file("2", "B.md"));
    root = addBookmark(root, file("3", "C.md"));
    root = reorderSibling(root, "1", 2);
    expect(root.items.map((i) => i.id)).toEqual(["2", "3", "1"]);
  });

  it("moves a top-level item to an earlier index", () => {
    let root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    root = addBookmark(root, file("2", "B.md"));
    root = addBookmark(root, file("3", "C.md"));
    root = reorderSibling(root, "3", 0);
    expect(root.items.map((i) => i.id)).toEqual(["3", "1", "2"]);
  });

  it("reorders siblings within a group without touching the root", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = addBookmark(root, file("2", "B.md"), { groupId: "g1" });
    root = reorderSibling(root, "1", 1, { groupId: "g1" });
    expect((root.items[0] as BookmarkGroup).items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("clamps an out-of-range target index", () => {
    let root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    root = addBookmark(root, file("2", "B.md"));
    root = reorderSibling(root, "1", 999);
    expect(root.items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("is a no-op when the id is not a direct child of the named container", () => {
    let root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    root = addBookmark(root, file("2", "B.md"));
    const next = reorderSibling(root, "does-not-exist", 0);
    expect(next.items).toEqual(root.items);
  });
});

describe("addBookmark — Phase B variants", () => {
  it("adds a search bookmark", () => {
    const root = addBookmark(createEmptyRoot(), { type: "search", id: "s1", query: "tag:#todo" });
    expect(root.items).toEqual([{ type: "search", id: "s1", query: "tag:#todo" }]);
  });

  it("adds a heading bookmark", () => {
    const bm: Bookmark = { type: "heading", id: "h1", path: "A.md", heading: "Intro", level: 2 };
    const root = addBookmark(createEmptyRoot(), bm);
    expect(root.items).toEqual([bm]);
  });

  it("adds a block bookmark", () => {
    const bm: Bookmark = { type: "block", id: "b1", path: "A.md", blockId: "abc123" };
    const root = addBookmark(createEmptyRoot(), bm);
    expect(root.items).toEqual([bm]);
  });

  it("adds a link bookmark", () => {
    const bm: Bookmark = { type: "link", id: "l1", url: "https://example.com", title: "Example" };
    const root = addBookmark(createEmptyRoot(), bm);
    expect(root.items).toEqual([bm]);
  });

  it("adds a graph bookmark", () => {
    const root = addBookmark(createEmptyRoot(), { type: "graph", id: "gr1" });
    expect(root.items).toEqual([{ type: "graph", id: "gr1" }]);
  });

  it("adds a Phase B variant inside a group", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, { type: "link", id: "l1", url: "https://x.com" }, { groupId: "g1" });
    expect((root.items[0] as BookmarkGroup).items).toEqual([
      { type: "link", id: "l1", url: "https://x.com" },
    ]);
  });

  it("isBookmarked ignores non-path variants (search/link/graph have no path)", () => {
    let root = addBookmark(createEmptyRoot(), { type: "search", id: "s1", query: "foo" });
    root = addBookmark(root, { type: "link", id: "l1", url: "https://x.com" });
    root = addBookmark(root, { type: "graph", id: "gr1" });
    expect(isBookmarked(root, "foo")).toBe(false);
    expect(isBookmarked(root, "https://x.com")).toBe(false);
    // A heading bookmark carries a path but is NOT a file/folder bookmark, so
    // isBookmarked (the File-Explorer "is this file bookmarked?" query) ignores
    // it — see FIX 2 and the dedicated "findByPath restriction" block below.
    root = addBookmark(root, { type: "heading", id: "h1", path: "A.md", heading: "H", level: 1 });
    expect(isBookmarked(root, "A.md")).toBe(false);
    // A real file bookmark for the same path IS discoverable.
    root = addBookmark(root, { type: "file", id: "f1", path: "A.md" });
    expect(isBookmarked(root, "A.md")).toBe(true);
  });
});

describe("moveItem", () => {
  it("moves a top-level item into a group at the given index", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"));
    root = addBookmark(root, file("2", "B.md"), { groupId: "g1" });
    root = moveItem(root, "1", "g1", 0);
    expect(root.items.map((i) => i.id)).toEqual(["g1"]);
    expect((root.items[0] as BookmarkGroup).items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("moves a nested item out to the root level (targetGroupId null)", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = moveItem(root, "1", null, 0);
    expect(root.items.map((i) => i.id)).toEqual(["1", "g1"]);
    expect((root.items[1] as BookmarkGroup).items).toEqual([]);
  });

  it("reorders across containers (out of one group into another)", () => {
    let root = createGroup(createEmptyRoot(), "G1", { id: "g1" });
    root = createGroup(root, "G2", { id: "g2" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = addBookmark(root, file("2", "B.md"), { groupId: "g2" });
    root = moveItem(root, "1", "g2", 1);
    expect((root.items[0] as BookmarkGroup).items).toEqual([]);
    expect((root.items[1] as BookmarkGroup).items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("clamps an out-of-range target index (appends)", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"), { groupId: "g1" });
    root = addBookmark(root, file("2", "B.md"), { groupId: "g1" });
    root = moveItem(root, "1", "g1", 999);
    expect((root.items[0] as BookmarkGroup).items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("is a no-op when the id is missing", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    expect(moveItem(root, "nope", null, 0)).toEqual(root);
  });

  it("is a no-op when the target group does not exist (never orphans the item)", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    const next = moveItem(root, "1", "no-such-group", 0);
    expect(next.items.map((i) => i.id)).toEqual(["1"]);
  });

  it("refuses to move a group into itself", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    expect(moveItem(root, "g1", "g1", 0)).toEqual(root);
  });

  it("refuses to move a group into one of its own descendants", () => {
    let root = createGroup(createEmptyRoot(), "Outer", { id: "outer" });
    root = createGroup(root, "Inner", { id: "inner", groupId: "outer" });
    expect(moveItem(root, "outer", "inner", 0)).toEqual(root);
  });

  it("does not mutate the input root", () => {
    let root = createGroup(createEmptyRoot(), "Group", { id: "g1" });
    root = addBookmark(root, file("1", "A.md"));
    const before = JSON.parse(JSON.stringify(root));
    moveItem(root, "1", "g1", 0);
    expect(root).toEqual(before);
  });
});

describe("findByPath restriction — file/folder only (FIX 2)", () => {
  it("a heading bookmark does NOT make its note look file-bookmarked", () => {
    const root = addBookmark(createEmptyRoot(), {
      type: "heading",
      id: "h1",
      path: "note.md",
      heading: "Intro",
      level: 1,
    });
    expect(isBookmarked(root, "note.md")).toBe(false);
    expect(findBookmarkByPath(root, "note.md")).toBeNull();
  });

  it("a block bookmark does NOT make its note look file-bookmarked", () => {
    const root = addBookmark(createEmptyRoot(), { type: "block", id: "b1", path: "note.md", blockId: "abc123" });
    expect(isBookmarked(root, "note.md")).toBe(false);
    expect(findBookmarkByPath(root, "note.md")).toBeNull();
  });

  it("a file bookmark and a heading bookmark for the same path coexist; toggling the file one leaves the heading intact", () => {
    let root = addBookmark(createEmptyRoot(), {
      type: "heading",
      id: "h1",
      path: "note.md",
      heading: "Intro",
      level: 1,
    });
    root = addBookmark(root, { type: "file", id: "f1", path: "note.md" });
    // findBookmarkByPath resolves the FILE bookmark, never the heading.
    expect(findBookmarkByPath(root, "note.md")?.id).toBe("f1");
    // "Un-bookmarking" the file removes only the file bookmark.
    root = removeBookmark(root, "f1");
    expect(findItemById(root, "h1")).not.toBeNull();
    expect(findBookmarkByPath(root, "note.md")).toBeNull();
  });
});

describe("descendantGroupIds (FIX 5)", () => {
  it("returns the whole descendant subtree of a group (excluding itself)", () => {
    let root = createGroup(createEmptyRoot(), "A", { id: "A" });
    root = createGroup(root, "B", { id: "B", groupId: "A" });
    root = createGroup(root, "C", { id: "C", groupId: "B" });
    root = createGroup(root, "Sibling", { id: "S" });
    expect(descendantGroupIds(root, "A")).toEqual(new Set(["B", "C"]));
    expect(descendantGroupIds(root, "B")).toEqual(new Set(["C"]));
    expect(descendantGroupIds(root, "C")).toEqual(new Set());
  });

  it("returns an empty set for a leaf bookmark or a missing id", () => {
    let root = createGroup(createEmptyRoot(), "A", { id: "A" });
    root = addBookmark(root, file("f1", "N.md"), { groupId: "A" });
    expect(descendantGroupIds(root, "f1")).toEqual(new Set());
    expect(descendantGroupIds(root, "missing")).toEqual(new Set());
  });
});

describe("collectGroups", () => {
  it("returns an empty array when there are no groups", () => {
    const root = addBookmark(createEmptyRoot(), file("1", "A.md"));
    expect(collectGroups(root)).toEqual([]);
  });

  it("lists flat groups at depth 0", () => {
    let root = createGroup(createEmptyRoot(), "One", { id: "g1" });
    root = createGroup(root, "Two", { id: "g2" });
    expect(collectGroups(root)).toEqual([
      { id: "g1", title: "One", depth: 0 },
      { id: "g2", title: "Two", depth: 0 },
    ]);
  });

  it("reports nesting depth for nested groups (pre-order)", () => {
    let root = createGroup(createEmptyRoot(), "Outer", { id: "outer" });
    root = createGroup(root, "Inner", { id: "inner", groupId: "outer" });
    root = createGroup(root, "Deep", { id: "deep", groupId: "inner" });
    root = createGroup(root, "Sibling", { id: "sib" });
    expect(collectGroups(root)).toEqual([
      { id: "outer", title: "Outer", depth: 0 },
      { id: "inner", title: "Inner", depth: 1 },
      { id: "deep", title: "Deep", depth: 2 },
      { id: "sib", title: "Sibling", depth: 0 },
    ]);
  });
});

describe("bookmarkDefaultLabel", () => {
  it("uses the basename for file/folder/heading/block and the raw value for search/link", () => {
    expect(bookmarkDefaultLabel(file("1", "notes/A.md"))).toBe("A.md");
    expect(bookmarkDefaultLabel(folder("1", "notes/Projects"))).toBe("Projects");
    expect(bookmarkDefaultLabel({ type: "heading", id: "h", path: "A.md", heading: "Intro", level: 1 })).toBe("Intro");
    expect(bookmarkDefaultLabel({ type: "block", id: "b", path: "notes/A.md", blockId: "abc" })).toBe("A.md ^abc");
    expect(bookmarkDefaultLabel({ type: "search", id: "s", query: "tag:#todo" })).toBe("tag:#todo");
    expect(bookmarkDefaultLabel({ type: "link", id: "l", url: "https://x.com" })).toBe("https://x.com");
    expect(bookmarkDefaultLabel({ type: "graph", id: "g" })).toBe("Graph");
  });
});

describe("normalizeBookmarksRoot", () => {
  it("passes through a well-formed root", () => {
    const input: BookmarksRoot = { items: [file("1", "A.md")] };
    expect(normalizeBookmarksRoot(input)).toEqual(input);
  });

  it("falls back to an empty root for null", () => {
    expect(normalizeBookmarksRoot(null)).toEqual(createEmptyRoot());
  });

  it("falls back to an empty root for malformed data", () => {
    expect(normalizeBookmarksRoot({ notItems: [] })).toEqual(createEmptyRoot());
    expect(normalizeBookmarksRoot("garbage")).toEqual(createEmptyRoot());
    expect(normalizeBookmarksRoot(42)).toEqual(createEmptyRoot());
  });
});
