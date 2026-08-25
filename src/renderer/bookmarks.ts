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
 * A single bookmarked target. Phase A covered `"file"` and `"folder"`; Phase B
 * adds the remaining Obsidian bookmarkable types — `"search" | "heading" |
 * "block" | "link" | "graph"` (spec docs/spec/02-core-plugins.md §Bookmarks).
 * The discriminated union stays open so future types slot in without a
 * breaking refactor of existing items. Only file/folder/heading/block carry a
 * `path`; search carries a `query`, link a `url`, graph nothing at all.
 */
export type Bookmark =
  | BookmarkFile
  | BookmarkFolder
  | BookmarkSearch
  | BookmarkHeading
  | BookmarkBlock
  | BookmarkLink
  | BookmarkGraph;

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

/** A saved Search query (spec: "Searches (queries)"). Opening it reveals the Search pane and re-runs `query`. */
export interface BookmarkSearch {
  type: "search";
  id: string;
  query: string;
  title?: string;
}

/** A heading inside a note. `level`/`heading` mirror `HeadingCache`; opening scrolls the file to the heading. */
export interface BookmarkHeading {
  type: "heading";
  id: string;
  path: string;
  heading: string;
  level: number;
  title?: string;
}

/** A block inside a note, keyed by its trailing `^blockId`. Opening scrolls the file to the line carrying `^blockId`. */
export interface BookmarkBlock {
  type: "block";
  id: string;
  path: string;
  blockId: string;
  title?: string;
}

/** A web URL (opened in the Web Viewer). */
export interface BookmarkLink {
  type: "link";
  id: string;
  url: string;
  title?: string;
}

/**
 * The global Graph view. Degenerate on purpose: Geode has no persistable graph
 * config yet (see views/graph-view.ts's header comment — graph.json is out of
 * scope), so this stores no settings and opening it just re-opens the global
 * Graph view. Graph-config fidelity is deferred until a graph config exists.
 */
export interface BookmarkGraph {
  type: "graph";
  id: string;
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
    } else if ((item.type === "file" || item.type === "folder") && item.path === path) {
      // Deliberately file/folder ONLY. Heading/block bookmarks also carry a
      // `path`, but isBookmarked/findBookmarkByPath model the File-Explorer
      // "is this file/folder bookmarked?" question — matching a heading/block
      // here would let un-bookmarking note.md delete a heading bookmark. Their
      // own dedup uses explicit type+path+heading/blockId predicates via
      // `findBookmark`, so this restriction doesn't regress them.
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
 * The first leaf bookmark (at any depth, groups excluded) matching
 * `predicate`, or null. Used by the App's typed add-helpers to dedupe
 * identity-equal bookmarks (same search query, same URL, same heading, …)
 * without re-implementing the tree walk each time.
 */
export function findBookmark(
  root: BookmarksRoot,
  predicate: (bm: Bookmark) => boolean
): Bookmark | null {
  const walk = (items: BookmarkItem[]): Bookmark | null => {
    for (const item of items) {
      if (item.type === "group") {
        const found = walk(item.items);
        if (found) return found;
      } else if (predicate(item)) {
        return item;
      }
    }
    return null;
  };
  return walk(root.items);
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

/** True if the group `item` contains `id` anywhere in its subtree. Used to reject moving a group into its own descendant. */
function groupContainsId(item: BookmarkItem, id: string): boolean {
  if (item.type !== "group") return false;
  return item.items.some((child) => child.id === id || groupContainsId(child, id));
}

/**
 * Cross-container move: relocate the item identified by `id` into
 * `targetGroupId`'s contents (or the root level when `targetGroupId` is
 * `null`) at `targetIndex`. This is the drag-between-groups primitive Phase A
 * deferred (see `reorderSibling`'s doc). Built on `removeFromItems` +
 * `updateContainer`, so it stays immutable and returns a new root.
 *
 * No-ops (returns the input root unchanged) when: `id` isn't found; the target
 * is a non-existent / non-group container; or the move would put a group
 * inside itself or one of its own descendants (which would orphan the subtree).
 * `targetIndex` is clamped to `[0, container.length]` (an out-of-range index
 * appends).
 */
export function moveItem(
  root: BookmarksRoot,
  id: string,
  targetGroupId: string | null,
  targetIndex: number
): BookmarksRoot {
  const item = findById(root.items, id);
  if (!item) return root;
  if (targetGroupId !== null) {
    const target = findById(root.items, targetGroupId);
    if (!target || target.type !== "group") return root;
    // Reject moving a group into itself or one of its descendants.
    if (targetGroupId === id || groupContainsId(item, targetGroupId)) return root;
  }
  const without = removeFromItems(root.items, id);
  return {
    items: updateContainer(without, targetGroupId ?? undefined, (arr) => {
      const clamped = Math.max(0, Math.min(targetIndex, arr.length));
      const copy = [...arr];
      copy.splice(clamped, 0, item);
      return copy;
    }),
  };
}

/**
 * The id of the group that directly contains `id`, or `null` when `id` is a
 * top-level item (or isn't found). Used by the Edit-bookmark modal to preselect
 * the item's current group in the group `<select>`.
 */
export function findParentGroupId(root: BookmarksRoot, id: string): string | null {
  const walk = (items: BookmarkItem[], parentId: string | null): string | null => {
    for (const item of items) {
      if (item.id === id) return parentId;
      if (item.type === "group") {
        const found = walk(item.items, item.id);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(root.items, null);
}

/**
 * Walk the tree and return every `type:"group"` node with its nesting `depth`
 * (0 for a top-level group, 1 for a group nested one level in, …). Used to
 * populate the Edit-bookmark modal's group `<select>` with indented labels.
 */
export function collectGroups(root: BookmarksRoot): { id: string; title: string; depth: number }[] {
  const out: { id: string; title: string; depth: number }[] = [];
  const walk = (items: BookmarkItem[], depth: number) => {
    for (const item of items) {
      if (item.type === "group") {
        out.push({ id: item.id, title: item.title, depth });
        walk(item.items, depth + 1);
      }
    }
  };
  walk(root.items, 0);
  return out;
}

/**
 * The ids of every group nested (at any depth) inside the group `groupId` —
 * its descendant subtree, NOT including `groupId` itself. Used by the Edit
 * modal to keep a group from being re-parented under one of its own
 * descendants (which `moveItem` rejects, leaving a confusing partial result).
 * Returns an empty set when `groupId` isn't a group.
 */
export function descendantGroupIds(root: BookmarksRoot, groupId: string): Set<string> {
  const out = new Set<string>();
  const group = findById(root.items, groupId);
  if (!group || group.type !== "group") return out;
  const walk = (items: BookmarkItem[]) => {
    for (const item of items) {
      if (item.type === "group") {
        out.add(item.id);
        walk(item.items);
      }
    }
  };
  walk(group.items);
  return out;
}

/**
 * Default display label for a bookmark, ignoring any custom `title` override.
 * The view still special-cases file/folder to resolve the live vault name;
 * this covers the non-path types (and gives a sane path-basename fallback for
 * file/folder/heading/block) for callers without vault access — e.g. the Edit
 * modal's title-input placeholder.
 */
export function bookmarkDefaultLabel(bm: Bookmark): string {
  switch (bm.type) {
    case "file":
    case "folder":
      return bm.path.split("/").pop() ?? bm.path;
    case "heading":
      return bm.heading;
    case "block":
      return `${bm.path.split("/").pop() ?? bm.path} ^${bm.blockId}`;
    case "search":
      return bm.query;
    case "link":
      return bm.url;
    case "graph":
      return "Graph";
  }
}
