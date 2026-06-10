import { Vault } from "./vault";
import { MetadataCache } from "./metadata-cache";
import { Workspace, TabGroup, View } from "./workspace";
import { CommandRegistry } from "./commands";
import { MarkdownRenderer } from "./markdown/render";
import { MarkdownView } from "./views/markdown-view";
import { FileExplorerView } from "./views/file-explorer";
import { BacklinksView, OutlineView, TagPaneView } from "./views/sidebar-views";
import { SearchView } from "./views/search-view";
import { Modal, SuggestModal } from "./modals/modals";
import { TFile, pathName } from "./types";
import type { Command } from "./commands";

interface AppSettings {
  theme: "dark" | "light";
  readableLineLength: boolean;
}

class EmptyView implements View {
  readonly viewType = "empty";
  containerEl: HTMLElement;

  constructor(app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "empty-state";
    this.containerEl.innerHTML = `<div class="empty-state-title">No file is open</div>`;
    const actions = [
      { label: "Create new note (Cmd/Ctrl+N)", fn: () => app.createNewNote() },
      { label: "Open quick switcher (Cmd/Ctrl+O)", fn: () => app.openQuickSwitcher() },
      { label: "Open command palette (Cmd/Ctrl+P)", fn: () => app.openCommandPalette() },
    ];
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = "empty-state-action";
      btn.textContent = a.label;
      btn.addEventListener("click", a.fn);
      this.containerEl.appendChild(btn);
    }
  }

  getDisplayText(): string {
    return "New tab";
  }

  getIcon(): string {
    return "📄";
  }

  onOpen(): void {}
  onClose(): void {}
}

class QuickSwitcherModal extends SuggestModal<TFile> {
  constructor(private geodeApp: App) {
    super(geodeApp);
    this.inputEl.placeholder = "Find or create a note…";
    this.emptyStateText = "No matching notes. Press Enter to create one.";
  }

  getItems(): TFile[] {
    return this.geodeApp.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderItem(file: TFile, el: HTMLElement): void {
    el.innerHTML = `<div class="prompt-result-title">${file.basename}</div><div class="prompt-result-path">${file.parent || ""}</div>`;
  }

  onChooseItem(file: TFile, evt: KeyboardEvent | MouseEvent): void {
    this.geodeApp.openFile(file, evt.metaKey || evt.ctrlKey);
  }

  onNoMatch(query: string): void {
    if (!query.trim()) return;
    this.close();
    this.geodeApp.createNewNote(undefined, query.trim());
  }
}

class CommandPaletteModal extends SuggestModal<Command> {
  constructor(private geodeApp: App) {
    super(geodeApp);
    this.inputEl.placeholder = "Type a command…";
  }

  getItems(): Command[] {
    return this.geodeApp.commands.list();
  }

  getItemText(cmd: Command): string {
    return cmd.name;
  }

  renderItem(cmd: Command, el: HTMLElement): void {
    const hotkey = cmd.hotkey ? `<span class="prompt-result-hotkey">${cmd.hotkey.replace("Mod", navigator.platform.includes("Mac") ? "⌘" : "Ctrl")}</span>` : "";
    el.innerHTML = `<div class="prompt-result-title">${cmd.name}</div>${hotkey}`;
  }

  onChooseItem(cmd: Command): void {
    cmd.callback();
  }
}

class SettingsModal extends Modal {
  constructor(private geodeApp: App) {
    super(geodeApp);
    this.modalEl.classList.add("mod-settings");
  }

  onOpen(): void {
    const s = this.geodeApp.settings;
    this.contentEl.innerHTML = `<h2>Settings</h2>`;
    this.addToggle("Dark mode", s.theme === "dark", (v) => {
      s.theme = v ? "dark" : "light";
      this.geodeApp.applySettings();
    });
    this.addToggle("Readable line length", s.readableLineLength, (v) => {
      s.readableLineLength = v;
      this.geodeApp.applySettings();
    });
  }

  private addToggle(label: string, value: boolean, onChange: (v: boolean) => void) {
    const row = document.createElement("div");
    row.className = "setting-item";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => onChange(input.checked));
    row.appendChild(name);
    row.appendChild(input);
    this.contentEl.appendChild(row);
  }

  onClose(): void {
    this.geodeApp.saveSettings();
  }
}

class StatusBar {
  containerEl: HTMLElement;
  private wordCountEl: HTMLElement;
  private backlinksEl: HTMLElement;

  constructor(private app: App, parentEl: HTMLElement) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "status-bar";
    this.backlinksEl = document.createElement("span");
    this.backlinksEl.className = "status-bar-item";
    this.wordCountEl = document.createElement("span");
    this.wordCountEl.className = "status-bar-item";
    this.containerEl.appendChild(this.backlinksEl);
    this.containerEl.appendChild(this.wordCountEl);
    parentEl.appendChild(this.containerEl);
    app.workspace.on("file-open", () => this.update());
    app.workspace.on("active-leaf-change", () => this.update());
    app.metadataCache.on("resolved", () => this.update());
  }

  update() {
    const view = this.app.getActiveMarkdownView();
    if (!view?.file) {
      this.wordCountEl.textContent = "";
      this.backlinksEl.textContent = "";
      return;
    }
    const text = view.getText().replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
    const words = (text.match(/\S+/g) ?? []).length;
    this.wordCountEl.textContent = `${words} words · ${text.length} characters`;
    const backlinks = this.app.metadataCache.getBacklinks(view.file);
    const n = backlinks.reduce((sum, b) => sum + b.count, 0);
    this.backlinksEl.textContent = n ? `${n} backlink${n === 1 ? "" : "s"}` : "";
  }
}

export class App {
  vault = new Vault();
  metadataCache = new MetadataCache(this.vault);
  commands = new CommandRegistry();
  markdownRenderer = new MarkdownRenderer(this);
  workspace!: Workspace;
  statusBar!: StatusBar;
  settings: AppSettings = { theme: "dark", readableLineLength: true };

  async start() {
    const rootEl = document.getElementById("app")!;
    const recents = await window.geode.getRecentVaults();
    if (recents.length) {
      await this.openVault(recents[0], rootEl);
    } else {
      this.showVaultPicker(rootEl, []);
    }
  }

  private showVaultPicker(rootEl: HTMLElement, recents: string[]) {
    rootEl.innerHTML = "";
    const picker = document.createElement("div");
    picker.className = "vault-picker";
    picker.innerHTML = `<h1>Geode</h1><p>Your knowledge base, on local Markdown files.</p>`;
    const openBtn = document.createElement("button");
    openBtn.className = "mod-cta";
    openBtn.textContent = "Open folder as vault";
    openBtn.addEventListener("click", async () => {
      const path = await window.geode.chooseVault();
      if (path) await this.openVault(path, rootEl);
    });
    picker.appendChild(openBtn);
    if (recents.length) {
      const h = document.createElement("h3");
      h.textContent = "Recent vaults";
      picker.appendChild(h);
      for (const path of recents) {
        const row = document.createElement("div");
        row.className = "vault-picker-recent";
        row.textContent = path;
        row.addEventListener("click", () => this.openVault(path, rootEl));
        picker.appendChild(row);
      }
    }
    rootEl.appendChild(picker);
  }

  private async openVault(path: string, rootEl: HTMLElement) {
    try {
      await this.vault.open(path);
    } catch (err) {
      console.error(err);
      const recents = await window.geode.getRecentVaults();
      this.showVaultPicker(rootEl, recents);
      return;
    }
    const saved = (await window.geode.readConfig("app")) as Partial<AppSettings> | null;
    if (saved) this.settings = { ...this.settings, ...saved };

    rootEl.innerHTML = "";
    const shell = document.createElement("div");
    shell.className = "app-shell";
    rootEl.appendChild(shell);

    const main = document.createElement("div");
    main.className = "app-main";
    shell.appendChild(main);

    this.workspace = new Workspace(this, main);
    this.statusBar = new StatusBar(this, shell);

    // Sidebar views
    this.workspace.leftSidebar.addView(new FileExplorerView(this));
    this.workspace.leftSidebar.addView(new SearchView(this));
    this.workspace.rightSidebar.addView(new BacklinksView(this));
    this.workspace.rightSidebar.addView(new OutlineView(this));
    this.workspace.rightSidebar.addView(new TagPaneView(this));

    this.registerCommands();
    this.commands.attach(document);
    this.applySettings();

    this.openEmptyTab(this.workspace.activeGroup);
    this.metadataCache.initialize().then(() => {
      this.notify(`Indexed ${this.vault.getMarkdownFiles().length} notes`);
    });

    // Re-render open views when files change externally
    this.vault.on("modify", async (file: TFile) => {
      const leaf = this.workspace.findLeafForFile(file.path);
      const view = leaf?.view;
      if (view instanceof MarkdownView && view.file) {
        const text = await this.vault.cachedRead(view.file);
        if (text !== view.getText()) await view.setFile(view.file);
      }
    });
  }

  private registerCommands() {
    const c = (id: string, name: string, hotkey: string | undefined, callback: () => void) =>
      this.commands.add({ id, name, hotkey, callback });

    c("command-palette", "Open command palette", "Mod+P", () => this.openCommandPalette());
    c("quick-switcher", "Quick switcher: Open", "Mod+O", () => this.openQuickSwitcher());
    c("new-note", "Create new note", "Mod+N", () => this.createNewNote());
    c("toggle-reading", "Toggle reading view", "Mod+E", () =>
      this.getActiveMarkdownView()?.toggleMode()
    );
    c("toggle-source", "Toggle Live Preview/Source mode", undefined, () =>
      this.getActiveMarkdownView()?.toggleSource()
    );
    c("new-tab", "New tab", "Mod+T", () => this.openEmptyTab(this.workspace.activeGroup));
    c("close-tab", "Close current tab", "Mod+W", () =>
      this.workspace.getActiveLeaf()?.detach()
    );
    c("split-right", "Split right", undefined, () => {
      const group = this.workspace.addGroup(this.workspace.activeGroup);
      this.openEmptyTab(group);
    });
    c("search", "Search in all files", "Mod+Shift+F", () => this.openSearch(""));
    c("toggle-left-sidebar", "Toggle left sidebar", "Mod+Shift+L", () =>
      this.workspace.leftSidebar.toggle()
    );
    c("toggle-right-sidebar", "Toggle right sidebar", "Mod+Shift+R", () =>
      this.workspace.rightSidebar.toggle()
    );
    c("open-settings", "Open settings", "Mod+,", () => new SettingsModal(this).open());
    c("toggle-theme", "Toggle dark/light theme", undefined, () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      this.applySettings();
      this.saveSettings();
    });
    c("daily-note", "Open today's daily note", "Mod+D", () => this.openDailyNote());
    c("random-note", "Open random note", undefined, () => {
      const files = this.vault.getMarkdownFiles();
      if (files.length) this.openFile(files[Math.floor(Math.random() * files.length)], false);
    });
    c("pin-tab", "Toggle pin on current tab", undefined, () => {
      const leaf = this.workspace.getActiveLeaf();
      if (leaf) {
        leaf.pinned = !leaf.pinned;
        leaf.group.renderTabs();
      }
    });
  }

  // --- File opening -------------------------------------------------------

  async openFile(file: TFile, newTab: boolean): Promise<void> {
    if (file.extension !== "md") {
      this.notify(`Cannot open .${file.extension} files yet`);
      return;
    }
    const existing = this.workspace.findLeafForFile(file.path);
    if (existing && !newTab) {
      existing.group.setActiveLeaf(existing);
      return;
    }
    const leaf = this.workspace.getLeaf(newTab);
    const current = leaf.view;
    if (current instanceof MarkdownView) {
      await current.setFile(file);
      leaf.group.renderTabs();
      this.workspace.trigger("file-open", file);
    } else {
      const view = new MarkdownView(this);
      await view.setFile(file);
      await leaf.setView(view);
    }
  }

  async openLink(linktext: string, sourcePath: string, newTab: boolean): Promise<void> {
    const dest = this.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (dest) {
      await this.openFile(dest, newTab);
      const sub = linktext.includes("#") ? linktext.slice(linktext.indexOf("#") + 1) : null;
      if (sub && !sub.startsWith("^")) {
        const heading = this.metadataCache
          .getHeadings(dest)
          .find((h) => h.heading.toLowerCase() === sub.toLowerCase());
        if (heading) this.revealOffsetInActiveMarkdownView(dest, heading.position.start.offset);
      }
    } else {
      // Unresolved link: create the note (Obsidian behavior)
      const name = linktext.split("#")[0].trim();
      if (!name) return;
      const file = await this.vault.create(this.vault.availablePath("", name, "md"), "");
      await this.openFile(file, newTab);
    }
  }

  async createNewNote(folder?: string, name?: string): Promise<void> {
    const path = name
      ? this.vault.availablePath(folder ?? "", name, "md")
      : this.vault.availablePath(folder ?? "", "Untitled", "md");
    const file = await this.vault.create(path, "");
    await this.openFile(file, false);
  }

  async openDailyNote(): Promise<void> {
    const today = new Date();
    const name = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    let file = this.vault.getFileByPath(`${name}.md`);
    if (!file) {
      for (const f of this.vault.getMarkdownFiles()) {
        if (f.basename === name) {
          file = f;
          break;
        }
      }
    }
    if (!file) file = await this.vault.create(`${name}.md`, `# ${name}\n\n`);
    await this.openFile(file, false);
  }

  openEmptyTab(group: TabGroup) {
    const leaf = group.createLeaf();
    leaf.setView(new EmptyView(this));
  }

  openQuickSwitcher() {
    new QuickSwitcherModal(this).open();
  }

  openCommandPalette() {
    new CommandPaletteModal(this).open();
  }

  openSearch(query: string) {
    const view = this.workspace.leftSidebar.getView("search") as SearchView | null;
    if (!view) return;
    this.workspace.leftSidebar.show(view);
    view.setQuery(query);
  }

  getActiveMarkdownView(): MarkdownView | null {
    const view = this.workspace.getActiveLeaf()?.view;
    return view instanceof MarkdownView ? view : null;
  }

  revealOffsetInActiveMarkdownView(file: TFile, offset: number) {
    this.openFile(file, false).then(() => {
      this.getActiveMarkdownView()?.scrollToOffset(offset);
    });
  }

  /** Rename a file and rewrite wikilinks in all notes that reference it. */
  async renameFileWithLinkUpdate(file: TFile, newPath: string): Promise<void> {
    const oldBasename = file.basename;
    const oldPathNoExt = file.path.replace(/\.md$/, "");
    const referencers = this.metadataCache
      .getBacklinks(file)
      .map((b) => b.source)
      .filter((f) => f.path !== file.path);
    await this.vault.rename(file, newPath);
    const renamed = this.vault.getFileByPath(newPath);
    if (!renamed) return;
    const newBasename = renamed.basename;
    const linkRe = /(!?\[\[)([^\[\]\n|#]+)([^\[\]\n]*\]\])/g;
    for (const ref of referencers) {
      const text = await this.vault.read(ref);
      const updated = text.replace(linkRe, (m, open, target, rest) => {
        const t = target.trim();
        if (
          t.toLowerCase() === oldBasename.toLowerCase() ||
          t === oldPathNoExt ||
          t === file.path
        ) {
          return `${open}${newBasename}${rest}`;
        }
        return m;
      });
      if (updated !== text) await this.vault.modify(ref, updated);
    }
    // Refresh any open view of the renamed file
    const leaf = this.workspace.findLeafForFile(newPath) ?? this.workspace.findLeafForFile(file.path);
    if (leaf?.view instanceof MarkdownView) {
      await leaf.view.setFile(renamed);
      leaf.group.renderTabs();
    }
  }

  // --- UI helpers ---------------------------------------------------------

  notify(message: string, timeout = 4000) {
    let host = document.querySelector(".notice-container") as HTMLElement | null;
    if (!host) {
      host = document.createElement("div");
      host.className = "notice-container";
      document.body.appendChild(host);
    }
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.textContent = message;
    host.appendChild(notice);
    setTimeout(() => notice.remove(), timeout);
  }

  showMenu(e: MouseEvent, items: { title: string; action: () => void }[]) {
    document.querySelector(".context-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    for (const item of items) {
      const el = document.createElement("div");
      el.className = "context-menu-item";
      el.textContent = item.title;
      el.addEventListener("click", () => {
        menu.remove();
        item.action();
      });
      menu.appendChild(el);
    }
    document.body.appendChild(menu);
    const dismiss = () => {
      menu.remove();
      document.removeEventListener("mousedown", onDown, true);
    };
    const onDown = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) dismiss();
    };
    document.addEventListener("mousedown", onDown, true);
  }

  applySettings() {
    document.body.classList.toggle("theme-dark", this.settings.theme === "dark");
    document.body.classList.toggle("theme-light", this.settings.theme === "light");
    document.body.classList.toggle("is-readable-line-length", this.settings.readableLineLength);
  }

  saveSettings() {
    window.geode.writeConfig("app", this.settings);
  }
}

const app = new App();
app.start();
(window as any).app = app;
