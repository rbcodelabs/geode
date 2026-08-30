import type { App } from "../app";
import type { View } from "../workspace";
import { TFile, TFolder, TAbstractFile } from "../types";
import { setIcon } from "../api/icons";
import { VAULT_FILE_DRAG_MIME } from "../file-drag";

export type SortOrder = "name-asc" | "name-desc";

/**
 * Folders-first, then case-insensitive name compare (sign flipped for
 * "name-desc"). Returns a new array — never mutates `children`, since
 * `Vault.rebuildChildren()` (vault.ts) owns the canonical child order and
 * other code may depend on it.
 */
export function sortChildren(children: TAbstractFile[], order: SortOrder): TAbstractFile[] {
  const dir = order === "name-asc" ? 1 : -1;
  return [...children].sort((a, b) => {
    const aIsFolder = (a as TFolder).kind === "folder";
    const bIsFolder = (b as TFolder).kind === "folder";
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return dir * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export class FileExplorerView implements View {
  readonly viewType = "file-explorer";
  containerEl: HTMLElement;
  private treeEl: HTMLElement;
  private expanded = new Set<string>();
  private activePath: string | null = null;
  private sortOrder: SortOrder = "name-asc";
  /** Multi-selection state (spec: Alt+click toggles, Shift+click ranges) for "Bookmark all". */
  private selected = new Set<string>();
  /** Anchor for Shift-range selection: the last row clicked without Shift. */
  private lastClicked: string | null = null;

  constructor(private app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "file-explorer-view sidebar-view";

    const header = document.createElement("div");
    header.className = "sidebar-view-header";
    const title = document.createElement("span");
    title.textContent = app.vault.name;
    title.className = "sidebar-view-title nav-vault-name";
    const actions = document.createElement("span");
    actions.className = "sidebar-view-actions";
    const newNote = document.createElement("button");
    newNote.className = "clickable-icon";
    newNote.title = "New note";
    setIcon(newNote, "square-pen");
    newNote.addEventListener("click", () => this.app.createNewNote());
    const newFolder = document.createElement("button");
    newFolder.className = "clickable-icon";
    newFolder.title = "New folder";
    setIcon(newFolder, "folder-plus");
    newFolder.addEventListener("click", async () => {
      const name = prompt("Folder name");
      if (!name) return;
      await this.app.vault.createFolder(name);
      this.render();
    });
    const sortToggle = document.createElement("button");
    sortToggle.className = "clickable-icon";
    const updateSortToggleIcon = () => {
      sortToggle.title = this.sortOrder === "name-asc" ? "Sort: A to Z" : "Sort: Z to A";
      setIcon(sortToggle, this.sortOrder === "name-asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
    };
    updateSortToggleIcon();
    sortToggle.addEventListener("click", () => {
      this.sortOrder = this.sortOrder === "name-asc" ? "name-desc" : "name-asc";
      updateSortToggleIcon();
      this.render();
    });
    const collapseAll = document.createElement("button");
    collapseAll.className = "clickable-icon";
    collapseAll.title = "Collapse all";
    setIcon(collapseAll, "chevrons-down-up");
    collapseAll.addEventListener("click", () => {
      this.expanded.clear();
      this.render();
    });
    const closeSidebar = document.createElement("button");
    closeSidebar.className = "clickable-icon";
    closeSidebar.title = "Collapse sidebar";
    setIcon(closeSidebar, "x");
    closeSidebar.addEventListener("click", () => this.app.workspace.leftSidebar.toggle());
    actions.appendChild(newNote);
    actions.appendChild(newFolder);
    actions.appendChild(sortToggle);
    actions.appendChild(collapseAll);
    actions.appendChild(closeSidebar);
    header.appendChild(title);
    header.appendChild(actions);
    this.containerEl.appendChild(header);

    this.treeEl = document.createElement("div");
    this.treeEl.className = "nav-files-container";
    this.containerEl.appendChild(this.treeEl);

    for (const ev of ["create", "delete", "rename"]) {
      app.vault.on(ev, () => this.render());
    }
    app.workspace.on("file-open", (file: TFile | null) => {
      this.activePath = file?.path ?? null;
      this.highlightActive();
    });
  }

  getDisplayText(): string {
    return "Files";
  }

  getIcon(): string {
    return "folder-closed";
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {}

  private render() {
    this.treeEl.innerHTML = "";
    const root = this.app.vault.getRoot();
    const children = sortChildren(root.children, this.sortOrder);
    for (const child of children) {
      this.treeEl.appendChild(this.renderItem(child as TFile | TFolder));
    }
    this.highlightActive();
  }

  private renderItem(item: TFile | TFolder): HTMLElement {
    const wrapper = document.createElement("div");
    if (item.kind === "folder") {
      const folder = item as TFolder;
      wrapper.className = "nav-folder";
      const isOpen = this.expanded.has(folder.path);
      wrapper.classList.toggle("is-open", isOpen);
      const row = document.createElement("div");
      row.className = "nav-folder-title nav-item";
      row.dataset.path = folder.path;
      row.draggable = !this.app.workspace.isCompactMobile();
      row.style.paddingLeft = "4px";
      const arrow = document.createElement("span");
      arrow.className = "nav-folder-arrow";
      setIcon(arrow, isOpen ? "chevron-down" : "chevron-right");
      const titleEl = document.createElement("span");
      titleEl.className = "nav-item-title";
      titleEl.textContent = folder.name;
      row.appendChild(arrow);
      row.appendChild(titleEl);
      row.addEventListener("click", (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          this.rangeSelectTo(folder.path);
          return;
        }
        if (e.altKey) {
          e.preventDefault();
          this.toggleSelected(folder.path);
          return;
        }
        this.setSingleSelection(folder.path);
        if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
        else this.expanded.add(folder.path);
        this.render();
      });
      row.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(VAULT_FILE_DRAG_MIME, folder.path);
      });
      row.addEventListener("contextmenu", (e) => this.folderMenu(e, folder));
      wrapper.appendChild(row);
      if (isOpen) {
        const childrenEl = document.createElement("div");
        childrenEl.className = "nav-folder-children";
        const children = sortChildren(folder.children, this.sortOrder);
        for (const child of children) {
          childrenEl.appendChild(this.renderItem(child as TFile | TFolder));
        }
        wrapper.appendChild(childrenEl);
      }
    } else {
      const file = item as TFile;
      const row = document.createElement("div");
      row.className = "nav-file-title nav-item";
      row.dataset.path = file.path;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Open file ${file.path}`);
      row.tabIndex = 0;
      row.draggable = !this.app.workspace.isCompactMobile();
      row.style.paddingLeft = "18px";
      const titleEl = document.createElement("span");
      titleEl.className = "nav-item-title";
      titleEl.textContent = file.basename;
      row.appendChild(titleEl);
      if (file.extension !== "md") {
        const tag = document.createElement("span");
        tag.className = "nav-file-tag";
        tag.textContent = file.extension;
        row.appendChild(tag);
      }
      row.addEventListener("click", (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          this.rangeSelectTo(file.path);
          return;
        }
        if (e.altKey) {
          e.preventDefault();
          this.toggleSelected(file.path);
          return;
        }
        // Plain / Cmd / Ctrl click: single-select and open (Cmd/Ctrl → new tab,
        // preserving the existing open-in-new-tab affordance).
        this.setSingleSelection(file.path);
        if (this.app.workspace.isCompactMobile()) {
          row.blur();
          this.app.workspace.closeMobileDrawers(false);
        }
        this.app.openFile(file, e.metaKey || e.ctrlKey);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        this.setSingleSelection(file.path);
        if (this.app.workspace.isCompactMobile()) {
          row.blur();
          this.app.workspace.closeMobileDrawers(false);
        }
        this.app.openFile(file, e.metaKey || e.ctrlKey);
      });
      row.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(VAULT_FILE_DRAG_MIME, file.path);
      });
      row.addEventListener("contextmenu", (e) => this.fileMenu(e, file));
      wrapper.appendChild(row);
    }
    return wrapper;
  }

  private highlightActive() {
    for (const el of this.treeEl.querySelectorAll(".nav-file-title")) {
      el.classList.toggle("is-active", (el as HTMLElement).dataset.path === this.activePath);
    }
    this.applySelection();
  }

  /** Reflect `this.selected` onto the rendered rows' `.is-selected` class. */
  private applySelection() {
    for (const el of this.treeEl.querySelectorAll<HTMLElement>(".nav-item[data-path]")) {
      el.classList.toggle("is-selected", this.selected.has(el.dataset.path!));
    }
  }

  /** The currently-rendered rows' paths, in visual (DOM) order — the axis for Shift-range selection. */
  private flatPaths(): string[] {
    return Array.from(this.treeEl.querySelectorAll<HTMLElement>(".nav-item[data-path]")).map(
      (el) => el.dataset.path!
    );
  }

  private setSingleSelection(path: string) {
    this.selected.clear();
    this.selected.add(path);
    this.lastClicked = path;
    this.applySelection();
  }

  private toggleSelected(path: string) {
    if (this.selected.has(path)) this.selected.delete(path);
    else this.selected.add(path);
    this.lastClicked = path;
    this.applySelection();
  }

  /** Select the inclusive range between the last non-Shift click and `path`, over the flat rendered order. */
  private rangeSelectTo(path: string) {
    const order = this.flatPaths();
    const anchor = this.lastClicked ?? path;
    const from = order.indexOf(anchor);
    const to = order.indexOf(path);
    if (from === -1 || to === -1) {
      this.setSingleSelection(path);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    this.selected.clear();
    for (let i = lo; i <= hi; i++) this.selected.add(order[i]);
    this.applySelection();
  }

  /** Paths to act on for a context menu opened on `path`: the whole multi-selection if `path` is part of it, else just `path`. */
  private menuTargetPaths(path: string): string[] {
    if (this.selected.has(path) && this.selected.size > 1) return [...this.selected];
    return [path];
  }

  private fileMenu(e: MouseEvent, file: TFile) {
    e.preventDefault();
    const targets = this.menuTargetPaths(file.path);
    const items = this.app.resourceMenuItems(file);
    if (targets.length > 1) {
      const bookmark = items.findIndex((item) => item.id === "resource.bookmark");
      if (bookmark >= 0) items.splice(bookmark, 1, {
        ...items[bookmark],
        title: `Bookmark all (${targets.length})`,
        action: () => void this.app.bookmarkPaths(targets),
      });
    }
    this.app.showMenu(e, items);
  }

  private folderMenu(e: MouseEvent, folder: TFolder) {
    e.preventDefault();
    const targets = this.menuTargetPaths(folder.path);
    const resourceItems = this.app.folderMenuItems(folder);
    if (targets.length > 1) {
      const bookmark = resourceItems.findIndex((item) => item.id === "resource.bookmark");
      if (bookmark >= 0) resourceItems.splice(bookmark, 1, {
        ...resourceItems[bookmark],
        title: `Bookmark all (${targets.length})`,
        action: () => void this.app.bookmarkPaths(targets),
      });
    }
    this.app.showMenu(e, resourceItems);
  }
}
