import type { App } from "../app";
import type { View } from "../workspace";
import { TFile, TFolder } from "../types";

export class FileExplorerView implements View {
  readonly viewType = "file-explorer";
  containerEl: HTMLElement;
  private treeEl: HTMLElement;
  private expanded = new Set<string>();
  private activePath: string | null = null;

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
    newNote.textContent = "📄+";
    newNote.addEventListener("click", () => this.app.createNewNote());
    const newFolder = document.createElement("button");
    newFolder.className = "clickable-icon";
    newFolder.title = "New folder";
    newFolder.textContent = "📁+";
    newFolder.addEventListener("click", async () => {
      const name = prompt("Folder name");
      if (!name) return;
      await this.app.vault.createFolder(name);
      this.render();
    });
    actions.appendChild(newNote);
    actions.appendChild(newFolder);
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
    return "📁";
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {}

  private render() {
    this.treeEl.innerHTML = "";
    const root = this.app.vault.getRoot();
    for (const child of root.children) {
      this.treeEl.appendChild(this.renderItem(child as TFile | TFolder, 0));
    }
    this.highlightActive();
  }

  private renderItem(item: TFile | TFolder, depth: number): HTMLElement {
    const wrapper = document.createElement("div");
    if (item.kind === "folder") {
      const folder = item as TFolder;
      const row = document.createElement("div");
      row.className = "nav-folder-title nav-item";
      row.style.paddingLeft = `${depth * 14 + 4}px`;
      const isOpen = this.expanded.has(folder.path);
      row.innerHTML = `<span class="nav-folder-arrow">${isOpen ? "▾" : "▸"}</span> <span class="nav-item-title">${folder.name}</span>`;
      row.addEventListener("click", () => {
        if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
        else this.expanded.add(folder.path);
        this.render();
      });
      row.addEventListener("contextmenu", (e) => this.folderMenu(e, folder));
      wrapper.appendChild(row);
      if (isOpen) {
        for (const child of folder.children) {
          wrapper.appendChild(this.renderItem(child as TFile | TFolder, depth + 1));
        }
      }
    } else {
      const file = item as TFile;
      const row = document.createElement("div");
      row.className = "nav-file-title nav-item";
      row.dataset.path = file.path;
      row.style.paddingLeft = `${depth * 14 + 18}px`;
      const label =
        file.extension === "md" ? file.basename : `${file.basename} <span class="nav-file-tag">${file.extension}</span>`;
      row.innerHTML = `<span class="nav-item-title">${label}</span>`;
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
