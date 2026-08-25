import { ItemView } from "../api/obsidian";
import type { WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import { PromptModal } from "../modals/modals";
import {
  createGroup,
  removeBookmark,
  renameBookmark,
  toggleGroupExpanded,
  type Bookmark,
  type BookmarkGroup,
  type BookmarkItem,
} from "../bookmarks";

/**
 * Bookmarks core plugin's sidebar pane. Deliberately built on the
 * plugin-facing `ItemView` (api/obsidian.ts) rather than the internal
 * `SidebarView`/`.sidebar-view-header` idiom every other built-in sidebar
 * view uses (see views/sidebar-views.ts, views/file-explorer.ts) — real
 * Obsidian's own Bookmarks plugin shows a visible `.view-header` with
 * `addAction()` icons when docked in the sidebar, so this view exercises
 * that real plugin-facing path and its CSS opt-in (`mod-show-generic-header`,
 * see styles/app.css) instead of coincidentally working because nothing else
 * needed it.
 */
export class BookmarksView extends ItemView {
  private treeEl: HTMLElement;
  /** File-Explorer-style expand state (views/file-explorer.ts), keyed by group id. */
  private expanded = new Set<string>();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Opt in to the generic .view-header the blanket sidebar rule hides by
    // default (styles/app.css: ".workspace-sidebar .view-header { display:
    // none }" + the ".mod-show-generic-header" override right after it).
    this.containerEl.classList.add("mod-show-generic-header");

    this.treeEl = document.createElement("div");
    this.treeEl.className = "nav-files-container";
    this.contentEl.appendChild(this.treeEl);

    this.app.workspace.on("bookmarks-changed", () => this.render());
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
    this.addAction("bookmark", "Bookmark the active tab", () => void this.bookmarkActiveTab());
    this.addAction("folder-plus", "New bookmark group", () => this.promptNewGroup());
    this.render();
  }

  async onClose(): Promise<void> {}

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
    for (const item of items) {
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
    wrapper.appendChild(row);

    if (isOpen) {
      const childrenEl = document.createElement("div");
      childrenEl.className = "nav-folder-children";
      for (const child of group.items) childrenEl.appendChild(this.renderItem(child));
      wrapper.appendChild(childrenEl);
    }
    return wrapper;
  }

  private renderBookmark(bookmark: Bookmark): HTMLElement {
    const row = document.createElement("div");
    row.className = "nav-file-title nav-item";
    row.dataset.id = bookmark.id;
    row.dataset.path = bookmark.path;

    const icon = document.createElement("span");
    icon.className = "nav-folder-arrow";
    setIcon(icon, bookmark.type === "folder" ? "folder-closed" : "file");
    row.appendChild(icon);

    const abstractFile = this.app.vault.getAbstractFileByPath(bookmark.path);
    const fallbackTitle = bookmark.path.split("/").pop() ?? bookmark.path;
    const displayTitle = bookmark.title ?? abstractFile?.name ?? fallbackTitle;
    const titleEl = document.createElement("span");
    titleEl.className = "nav-item-title";
    titleEl.textContent = displayTitle;
    row.appendChild(titleEl);

    if (bookmark.type === "file") {
      row.addEventListener("click", (e) => {
        const file = this.app.vault.getAbstractFileByPath(bookmark.path);
        if (file && file.kind === "file") this.app.openFile(file, e.metaKey || e.ctrlKey);
        else this.app.notify(`"${displayTitle}" no longer exists in the vault`);
      });
    }
    row.addEventListener("contextmenu", (e) => this.itemMenu(e, bookmark.id, displayTitle));
    return row;
  }

  private itemMenu(e: MouseEvent, id: string, currentTitle: string): void {
    e.preventDefault();
    this.app.showMenu(e, [
      {
        title: "Rename…",
        icon: "pencil",
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
        action: () => {
          void this.app.mutateBookmarks((root) => removeBookmark(root, id));
        },
      },
    ]);
  }
}
