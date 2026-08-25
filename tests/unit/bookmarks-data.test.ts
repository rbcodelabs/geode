import { describe, expect, it } from "vitest";
import {
  addBookmark,
  createEmptyRoot,
  createGroup,
  findBookmarkByPath,
  findItemById,
  isBookmarked,
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
