import { ItemView } from "../api/obsidian";
import type { WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import { PromptModal } from "../modals/modals";
import { EditBookmarkModal } from "../modals/edit-bookmark-modal";
import {
  bookmarkDefaultLabel,
  createGroup,
  moveItem,
  removeBookmark,
  renameBookmark,
  reorderSibling,
  toggleGroupExpanded,
  findParentGroupId,
  type Bookmark,
  type BookmarkGroup,
  type BookmarkItem,
} from "../bookmarks";

type SortMode = "manual" | "alpha";

/**
 * The id of the bookmark/group currently being dragged, shared across rows for
 * the duration of a drag. Module-scoped like `workspace.ts`'s `draggingLeaf` —
 * HTML5 DnD's `dataTransfer` can't be read during `dragover` (only on `drop`),
 * so the affordance logic needs the id out-of-band.
 */
let draggingBookmarkId: string | null = null;

/**
 * Bookmarks core plugin's sidebar pane. Built on the plugin-facing `ItemView`
 * (api/obsidian.ts) so it exercises the real `.view-header` + `addAction()`
 * path (see the class's Phase A doc / styles/app.css `mod-show-generic-header`).
 *
 * Phase B: opens every bookmark type (not just files), adds sort/collapse
 * header controls, renders a per-type icon, offers an Edit dialog, and supports
 * drag-to-reorder and drag-between-groups via the `moveItem`/`reorderSibling`
 * data-model primitives.
 */
export class BookmarksView extends ItemView {
  private treeEl: HTMLElement;
  /** File-Explorer-style expand state (views/file-explorer.ts), keyed by group id. */
  private expanded = new Set<string>();
  private sortMode: SortMode = "manual";
  private sortActionEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.containerEl.classList.add("mod-show-generic-header");

    this.treeEl = document.createElement("div");
    this.treeEl.className = "nav-files-container bookmarks-container";
    this.contentEl.appendChild(this.treeEl);

    this.app.workspace.on("bookmarks-changed", () => this.render());

    // A drop onto the empty area below the last row moves the item to the
    // root level (out of whatever group it was in).
    this.treeEl.addEventListener("dragover", (e) => {
      if (draggingBookmarkId && e.target === this.treeEl) e.preventDefault();
    });
    this.treeEl.addEventListener("drop", (e) => {
      if (draggingBookmarkId && e.target === this.treeEl) {
        e.preventDefault();
        this.applyDrop(draggingBookmarkId, null, Number.MAX_SAFE_INTEGER);
      }
    });
  }

  getViewType(): string {
    return "bookmarks";
  }

  getDisplayText(): string {
    return "Bookmarks";
  }

  getIcon(): string {
    return "bookmark";
  }

  async onOpen(): Promise<void> {
    // Spec icon alignment: `lucide-bookmark-plus` for "Bookmark the active tab",
    // `lucide-folder-plus` for "New bookmark group".
    this.addAction("bookmark-plus", "Bookmark the active tab", () => void this.bookmarkActiveTab());
    this.addAction("folder-plus", "New bookmark group", () => this.promptNewGroup());
    this.sortActionEl = this.addAction(this.sortIcon(), this.sortTooltip(), () => this.toggleSort());
    this.addAction("chevrons-down-up", "Collapse all", () => this.collapseAll());
    this.render();
  }

  async onClose(): Promise<void> {}

  private sortIcon(): string {
    return this.sortMode === "manual" ? "arrow-up-narrow-wide" : "arrow-down-a-z";
  }

  private sortTooltip(): string {
    return this.sortMode === "manual" ? "Sort: manual order" : "Sort: A to Z";
  }

  private toggleSort(): void {
    this.sortMode = this.sortMode === "manual" ? "alpha" : "manual";
    if (this.sortActionEl) {
      setIcon(this.sortActionEl, this.sortIcon());
      this.sortActionEl.setAttribute("aria-label", this.sortTooltip());
      this.sortActionEl.title = this.sortTooltip();
    }
    this.render();
  }

  private collapseAll(): void {
    this.expanded.clear();
    this.render();
  }

  private async bookmarkActiveTab(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.app.notify("No active file to bookmark");
      return;
    }
    await this.app.toggleBookmarkFile(file);
  }

  private promptNewGroup(): void {
    new PromptModal(this.app, {
      placeholder: "Group name",
      onSubmit: (value) => {
        void this.app.mutateBookmarks((root) => createGroup(root, value));
      },
    }).open();
  }

  /** Human-readable label for a leaf bookmark: custom title, else the live vault name (file/folder), else the type-specific default. */
  private displayLabel(bm: Bookmark): string {
    if (bm.title && bm.title.trim()) return bm.title;
    if (bm.type === "file" || bm.type === "folder") {
      const abstractFile = this.app.vault.getAbstractFileByPath(bm.path);
      return abstractFile?.name ?? bm.path.split("/").pop() ?? bm.path;
    }
    return bookmarkDefaultLabel(bm);
  }

  private iconFor(bm: Bookmark): string {
    switch (bm.type) {
      case "folder":
        return "folder";
      case "search":
        return "search";
      case "heading":
        return "heading";
      case "block":
        return "file-text";
      case "link":
        return "globe";
      case "graph":
        return "git-fork";
      case "file":
      default:
        return "file";
    }
  }

  /** Order a container's items for rendering: tree order in "manual", by label (case-insensitive) in "alpha". */
  private ordered(items: BookmarkItem[]): BookmarkItem[] {
    if (this.sortMode === "manual") return items;
    const label = (item: BookmarkItem) =>
      item.type === "group" ? item.title : this.displayLabel(item);
    return [...items].sort((a, b) =>
      label(a).localeCompare(label(b), undefined, { sensitivity: "base" })
    );
  }

  private render(): void {
    this.treeEl.innerHTML = "";
    const items = this.app.bookmarksRoot.items;
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pane-empty";
      empty.textContent = "No bookmarks yet";
      this.treeEl.appendChild(empty);
      return;
    }
    for (const item of this.ordered(items)) {
      this.treeEl.appendChild(this.renderItem(item));
    }
  }

  private renderItem(item: BookmarkItem): HTMLElement {
    if (item.type === "group") return this.renderGroup(item);
    return this.renderBookmark(item);
  }

  private renderGroup(group: BookmarkGroup): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "nav-folder";
    const isOpen = this.expanded.has(group.id);
    wrapper.classList.toggle("is-open", isOpen);

    const row = document.createElement("div");
    row.className = "nav-folder-title nav-item";
    row.dataset.id = group.id;
    row.draggable = true;
    const arrow = document.createElement("span");
    arrow.className = "nav-folder-arrow";
    setIcon(arrow, isOpen ? "chevron-down" : "chevron-right");
    const titleEl = document.createElement("span");
    titleEl.className = "nav-item-title";
    titleEl.textContent = group.title;
    row.append(arrow, titleEl);
    row.addEventListener("click", () => {
      if (this.expanded.has(group.id)) this.expanded.delete(group.id);
      else this.expanded.add(group.id);
      void this.app.mutateBookmarks((root) => toggleGroupExpanded(root, group.id));
    });
    row.addEventListener("contextmenu", (e) => this.itemMenu(e, group.id, group.title));
    // A group is both a draggable row (reorder) and a drop target (drop INTO it).
    this.wireDragSource(row, group.id);
    this.wireGroupDropTarget(row, group.id);
    wrapper.appendChild(row);

    if (isOpen) {
      const childrenEl = document.createElement("div");
      childrenEl.className = "nav-folder-children";
      for (const child of this.ordered(group.items)) childrenEl.appendChild(this.renderItem(child));
      wrapper.appendChild(childrenEl);
    }
    return wrapper;
  }

  private renderBookmark(bookmark: Bookmark): HTMLElement {
    const row = document.createElement("div");
    row.className = "nav-file-title nav-item";
    row.dataset.id = bookmark.id;
    if (bookmark.type === "file" || bookmark.type === "folder" || bookmark.type === "heading" || bookmark.type === "block") {
      row.dataset.path = bookmark.path;
    }
    row.draggable = true;

    const icon = document.createElement("span");
    icon.className = "nav-folder-arrow";
    setIcon(icon, this.iconFor(bookmark));
    row.appendChild(icon);

    const displayTitle = this.displayLabel(bookmark);
    const titleEl = document.createElement("span");
    titleEl.className = "nav-item-title";
    titleEl.textContent = displayTitle;
    row.appendChild(titleEl);

    row.addEventListener("click", (e) => {
      void this.app.openBookmark(bookmark, e.metaKey || e.ctrlKey);
    });
    row.addEventListener("contextmenu", (e) => this.itemMenu(e, bookmark.id, displayTitle));
    this.wireDragSource(row, bookmark.id);
    this.wireSiblingDropTarget(row, bookmark.id);
    return row;
  }

  private itemMenu(e: MouseEvent, id: string, currentTitle: string): void {
    e.preventDefault();
    this.app.showMenu(e, [
      {
        title: "Edit…",
        icon: "pencil",
        action: () => new EditBookmarkModal(this.app, id).open(),
      },
      {
        title: "Rename…",
        icon: "text-cursor-input",
        action: () => {
          new PromptModal(this.app, {
            initialValue: currentTitle,
            onSubmit: (value) => {
              void this.app.mutateBookmarks((root) => renameBookmark(root, id, value));
            },
          }).open();
        },
      },
      {
        title: "Remove",
        icon: "trash",
        warning: true,
        action: () => {
          void this.app.mutateBookmarks((root) => removeBookmark(root, id));
        },
      },
    ]);
  }

  // --- Drag and drop -------------------------------------------------------

  private wireDragSource(row: HTMLElement, id: string): void {
    row.addEventListener("dragstart", (e) => {
      draggingBookmarkId = id;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // Some browsers require data to be set for the drag to start.
        e.dataTransfer.setData("text/plain", id);
      }
      row.classList.add("is-being-dragged");
    });
    row.addEventListener("dragend", () => {
      draggingBookmarkId = null;
      row.classList.remove("is-being-dragged");
    });
  }

  /**
   * A leaf row is a reorder target: dropping onto its top half inserts before
   * it, its bottom half after it, in the same container. The insertion is
   * expressed as a `moveItem` into the row's parent group (or root) at the
   * computed index — this works for both same-container reorders and moves in
   * from another container.
   */
  private wireSiblingDropTarget(row: HTMLElement, targetId: string): void {
    row.addEventListener("dragover", (e) => {
      if (!draggingBookmarkId || draggingBookmarkId === targetId) return;
      e.preventDefault();
      e.stopPropagation();
      const after = this.isAfter(e, row);
      row.classList.toggle("drop-before", !after);
      row.classList.toggle("drop-after", after);
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-before", "drop-after");
    });
    row.addEventListener("drop", (e) => {
      if (!draggingBookmarkId || draggingBookmarkId === targetId) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("drop-before", "drop-after");
      const after = this.isAfter(e, row);
      this.dropRelativeTo(draggingBookmarkId, targetId, after);
    });
  }

  /**
   * A group row is a "drop INTO" target on its middle band, and a reorder
   * target on its top/bottom edges (so you can still place a sibling right
   * above/below a group). Edge zone is the top/bottom 25% of the row.
   */
  private wireGroupDropTarget(row: HTMLElement, groupId: string): void {
    row.addEventListener("dragover", (e) => {
      if (!draggingBookmarkId || draggingBookmarkId === groupId) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = this.edgeZone(e, row);
      row.classList.toggle("drop-into", zone === "into");
      row.classList.toggle("drop-before", zone === "before");
      row.classList.toggle("drop-after", zone === "after");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-into", "drop-before", "drop-after");
    });
    row.addEventListener("drop", (e) => {
      if (!draggingBookmarkId || draggingBookmarkId === groupId) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = this.edgeZone(e, row);
      row.classList.remove("drop-into", "drop-before", "drop-after");
      if (zone === "into") {
        this.applyDrop(draggingBookmarkId, groupId, Number.MAX_SAFE_INTEGER);
      } else {
        this.dropRelativeTo(draggingBookmarkId, groupId, zone === "after");
      }
    });
  }

  /** Whether the pointer is in the lower half of `row` (drop after) vs. upper half (drop before). */
  private isAfter(e: DragEvent, row: HTMLElement): boolean {
    const r = row.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  }

  /** Three-way zone for a group row: top edge → before, bottom edge → after, middle → into. */
  private edgeZone(e: DragEvent, row: HTMLElement): "before" | "after" | "into" {
    const r = row.getBoundingClientRect();
    const rel = (e.clientY - r.top) / r.height;
    if (rel < 0.25) return "before";
    if (rel > 0.75) return "after";
    return "into";
  }

  /**
   * Drop `draggedId` before/after `targetId` in the target's own container.
   * If both live in the same container it's a `reorderSibling`; otherwise it's
   * a `moveItem` into the target's parent at the target's index (+1 for after).
   */
  private dropRelativeTo(draggedId: string, targetId: string, after: boolean): void {
    const root = this.app.bookmarksRoot;
    const targetParent = findParentGroupId(root, targetId);
    const draggedParent = findParentGroupId(root, draggedId);
    const container = this.containerItems(targetParent);
    let index = container.findIndex((i) => i.id === targetId);
    if (index === -1) return;
    if (after) index += 1;

    if (draggedParent === targetParent) {
      // Same container: reorderSibling clamps and no-ops appropriately. Its
      // index is post-removal, so a forward move needs a -1 adjustment.
      const fromIndex = container.findIndex((i) => i.id === draggedId);
      let targetIndex = index;
      if (fromIndex !== -1 && fromIndex < index) targetIndex -= 1;
      void this.app.mutateBookmarks((r) => reorderSibling(r, draggedId, targetIndex, { groupId: targetParent ?? undefined }));
    } else {
      this.applyDrop(draggedId, targetParent, index);
    }
  }

  private containerItems(groupId: string | null): BookmarkItem[] {
    if (groupId === null) return this.app.bookmarksRoot.items;
    const group = this.app.bookmarksRoot.items.length
      ? findGroup(this.app.bookmarksRoot.items, groupId)
      : null;
    return group?.items ?? [];
  }

  private applyDrop(draggedId: string, targetGroupId: string | null, index: number): void {
    void this.app.mutateBookmarks((root) => moveItem(root, draggedId, targetGroupId, index));
  }
}

/** Locate a group node by id within an items array (any depth). */
function findGroup(items: BookmarkItem[], id: string): BookmarkGroup | null {
  for (const item of items) {
    if (item.type === "group") {
      if (item.id === id) return item;
      const found = findGroup(item.items, id);
      if (found) return found;
    }
  }
  return null;
}
