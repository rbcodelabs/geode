/**
 * Bookmarks core plugin — data model.
 *
 * Pure CRUD over the bookmark tree, with zero DOM/Electron dependencies so
 * it's unit-testable in isolation (mirrors `views/file-explorer.ts`'s
 * `sortChildren` being importable straight into a vitest file). Persistence
 * (`.geode/bookmarks.json` via `window.geode.readConfig`/`writeConfig`) and
 * rendering live in `views/bookmarks-view.ts`, not here.
 *
 * Convention: every mutating function below returns a NEW `BookmarksRoot`
 * (immutable-style) — the input root and its nested arrays/objects are never
 * mutated in place. Callers (the view layer, tests) always use the returned
 * value.
 *
 * Id generation: this module never calls `crypto.randomUUID()` itself for
 * `addBookmark` (the caller constructs the full `Bookmark`, id included, so
 * addBookmark stays a deterministic pure function of its inputs). The one
 * exception is `createGroup`, whose signature only takes a `title`; it
 * generates an id via `crypto.randomUUID()` unless the caller supplies one
 * via `opts.id` (so a caller — e.g. the view, right after creating a group —
 * can know the new group's id without a second lookup, while tests can pass
 * a fixed id for deterministic assertions).
 */

/**
 * A single bookmarked target. Phase A covers `"file"` and `"folder"`; the
 * discriminated union is intentionally left open so Phase B can add
 * `"search" | "heading" | "block" | "link" | "graph"` variants without a
 * breaking refactor of existing items.
 */
export type Bookmark = BookmarkFile | BookmarkFolder;

export interface BookmarkFile {
  type: "file";
  /** Stable id, independent of `path`, so rename/remove/reorder don't need path-uniqueness. */
  id: string;
  path: string;
  /** Optional custom title override set at creation time; falls back to the filename in the UI. */
  title?: string;
}

export interface BookmarkFolder {
  type: "folder";
  id: string;
  path: string;
  title?: string;
}

/** A (nestable) group of bookmarks and/or other groups. */
export interface BookmarkGroup {
  type: "group";
  id: string;
  title: string;
  expanded: boolean;
  items: BookmarkItem[];
}

export type BookmarkItem = Bookmark | BookmarkGroup;

/** Root persisted shape, written to `.geode/bookmarks.json`. */
export interface BookmarksRoot {
  items: BookmarkItem[];
}

export function createEmptyRoot(): BookmarksRoot {
  return { items: [] };
}

/**
 * Defensively coerce arbitrary loaded JSON (e.g. a missing/corrupt config
 * file) into a valid `BookmarksRoot`. Anything that doesn't look like
 * `{ items: [...] }` falls back to an empty root rather than throwing, same
 * spirit as `resolveDailyNoteSettings` merging saved settings over defaults.
 */
export function normalizeBookmarksRoot(data: unknown): BookmarksRoot {
  if (!data || typeof data !== "object" || !Array.isArray((data as { items?: unknown }).items)) {
    return createEmptyRoot();
  }
  return { items: (data as { items: BookmarkItem[] }).items };
}

// ---------------------------------------------------------------------------
// Internal tree-walk helpers
// ---------------------------------------------------------------------------

/**
 * Rebuild `items`, applying `updater` to the array identified by `groupId`
 * (or the root array itself when `groupId` is undefined), recursing into
 * nested groups along the way. Ancestors of the target array are shallow-
 * copied so the return value never aliases mutable state from `items`.
 */
function updateContainer(
  items: BookmarkItem[],
  groupId: string | undefined,
  updater: (arr: BookmarkItem[]) => BookmarkItem[]
): BookmarkItem[] {
  if (groupId === undefined) return updater(items);
  return items.map((item) => {
    if (item.type !== "group") return item;
    if (item.id === groupId) return { ...item, items: updater(item.items) };
    return { ...item, items: updateContainer(item.items, groupId, updater) };
  });
}

/** Rebuild `items`, applying `fn` to whichever item (at any depth) has the given `id`. */
function mapItemById(
  items: BookmarkItem[],
  id: string,
  fn: (item: BookmarkItem) => BookmarkItem
): BookmarkItem[] {
  return items.map((item) => {
    if (item.id === id) return fn(item);
    if (item.type === "group") return { ...item, items: mapItemById(item.items, id, fn) };
    return item;
  });
}

/** Remove whichever item (at any depth) has the given `id`. Removing a group cascades to its contents (they're part of the same subtree). */
function removeFromItems(items: BookmarkItem[], id: string): BookmarkItem[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) => (item.type === "group" ? { ...item, items: removeFromItems(item.items, id) } : item));
}

function findByPath(items: BookmarkItem[], path: string): Bookmark | null {
  for (const item of items) {
    if (item.type === "group") {
      const found = findByPath(item.items, path);
      if (found) return found;
    } else if (item.path === path) {
      return item;
    }
  }
  return null;
}

function findById(items: BookmarkItem[], id: string): BookmarkItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.type === "group") {
      const found = findById(item.items, id);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

/** Append `bookmark` to the root, or to the group named by `opts.groupId`. */
export function addBookmark(
  root: BookmarksRoot,
  bookmark: Bookmark,
  opts?: { groupId?: string }
): BookmarksRoot {
  return { items: updateContainer(root.items, opts?.groupId, (arr) => [...arr, bookmark]) };
}

/** Remove whichever item has `id`, at any depth. Removing a group removes everything nested inside it. No-op if `id` isn't found. */
export function removeBookmark(root: BookmarksRoot, id: string): BookmarksRoot {
  return { items: removeFromItems(root.items, id) };
}

/** Set a custom title on a bookmark, or rename a group, whichever item `id` refers to. No-op if `id` isn't found. */
export function renameBookmark(root: BookmarksRoot, id: string, title: string): BookmarksRoot {
  return { items: mapItemById(root.items, id, (item) => ({ ...item, title })) };
}

/**
 * Create a new (initially expanded) group, appended to the root or to
 * `opts.groupId`'s contents (nestable groups per spec). Returns the new
 * root; the created group's id is `opts.id` if supplied, else a fresh
 * `crypto.randomUUID()` — pass `opts.id` when the caller needs to know the
 * id without a follow-up lookup.
 */
export function createGroup(
  root: BookmarksRoot,
  title: string,
  opts?: { groupId?: string; id?: string }
): BookmarksRoot {
  const group: BookmarkGroup = {
    type: "group",
    id: opts?.id ?? crypto.randomUUID(),
    title,
    expanded: true,
    items: [],
  };
  return { items: updateContainer(root.items, opts?.groupId, (arr) => [...arr, group]) };
}

/** Flip a group's `expanded` state. No-op if `groupId` isn't found or isn't a group. */
export function toggleGroupExpanded(root: BookmarksRoot, groupId: string): BookmarksRoot {
  return {
    items: mapItemById(root.items, groupId, (item) =>
      item.type === "group" ? { ...item, expanded: !item.expanded } : item
    ),
  };
}

/** True if any file/folder bookmark (at any depth) has this vault path. */
export function isBookmarked(root: BookmarksRoot, path: string): boolean {
  return findByPath(root.items, path) !== null;
}

/** The file/folder bookmark (at any depth) with this vault path, or null. */
export function findBookmarkByPath(root: BookmarksRoot, path: string): Bookmark | null {
  return findByPath(root.items, path);
}

/** The bookmark or group (at any depth) with this id, or null. */
export function findItemById(root: BookmarksRoot, id: string): BookmarkItem | null {
  return findById(root.items, id);
}

/**
 * Move the sibling identified by `id` to `targetIndex` within its container
 * (the root, or `opts.groupId`'s items) — a same-container reorder only;
 * moving an item into a *different* container is Phase B (real drag/drop).
 * `targetIndex` is clamped to the container's bounds. No-op if `id` isn't a
 * direct child of the named container.
 */
export function reorderSibling(
  root: BookmarksRoot,
  id: string,
  targetIndex: number,
  opts?: { groupId?: string }
): BookmarksRoot {
  return {
    items: updateContainer(root.items, opts?.groupId, (arr) => {
      const index = arr.findIndex((item) => item.id === id);
      if (index === -1) return arr;
      const clamped = Math.max(0, Math.min(targetIndex, arr.length - 1));
      if (clamped === index) return arr;
      const copy = [...arr];
      const [moved] = copy.splice(index, 1);
      copy.splice(clamped, 0, moved);
      return copy;
    }),
  };
}
