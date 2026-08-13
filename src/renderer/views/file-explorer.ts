import type { App } from "../app";
import type { View } from "../workspace";
import { TFile, TFolder, TAbstractFile } from "../types";
import { setIcon } from "../api/icons";

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
      row.style.paddingLeft = "4px";
      const arrow = document.createElement("span");
      arrow.className = "nav-folder-arrow";
      setIcon(arrow, isOpen ? "chevron-down" : "chevron-right");
      const titleEl = document.createElement("span");
      titleEl.className = "nav-item-title";
      titleEl.textContent = folder.name;
      row.appendChild(arrow);
      row.appendChild(titleEl);
      row.addEventListener("click", () => {
        if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
        else this.expanded.add(folder.path);
        this.render();
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
        this.app.openFile(file, e.metaKey || e.ctrlKey);
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
  }

  private fileMenu(e: MouseEvent, file: TFile) {
    e.preventDefault();
    this.app.showMenu(e, [
      { title: "Open in new tab", action: () => this.app.openFile(file, true) },
      {
        title: "Rename…",
        action: async () => {
          const name = prompt("New name", file.basename);
          if (!name || name === file.basename) return;
          const newPath = (file.parent ? file.parent + "/" : "") + name + "." + file.extension;
          await this.app.renameFileWithLinkUpdate(file, newPath);
        },
      },
      {
        title: "Delete",
        action: async () => {
          if (confirm(`Delete "${file.name}"? It will be moved to the system trash.`)) {
            await this.app.vault.trash(file);
          }
        },
      },
    ]);
  }

  private folderMenu(e: MouseEvent, folder: TFolder) {
    e.preventDefault();
    this.app.showMenu(e, [
      {
        title: "New note",
        action: () => this.app.createNewNote(folder.path),
      },
      {
        title: "New folder",
        action: async () => {
          const name = prompt("Folder name");
          if (!name) return;
          await this.app.vault.createFolder(`${folder.path}/${name}`);
          this.render();
        },
      },
      {
        title: "Rename…",
        action: async () => {
          const name = prompt("New name", folder.name);
          if (!name || name === folder.name) return;
          const newPath = (folder.parent ? folder.parent + "/" : "") + name;
          await this.app.vault.rename(folder, newPath);
        },
      },
      {
        title: "Delete",
        action: async () => {
          if (confirm(`Delete folder "${folder.name}" and all its contents?`)) {
            await this.app.vault.trash(folder);
          }
        },
      },
    ]);
  }
}
