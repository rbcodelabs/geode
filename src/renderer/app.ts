import { Vault } from "./vault";
import { MetadataCache } from "./metadata-cache";
import { Workspace, TabGroup, View, type PersistedWorkspace } from "./workspace";
import { CommandRegistry } from "./commands";
import { PluginManager } from "./plugin-manager";
import { ThemeManager } from "./theme-manager";
import { CommunityManager } from "./community/community-manager";
import { InstallFromGithubModal } from "./community/install-modal";
import { MarkdownRenderer } from "./markdown/render";
import { MarkdownView } from "./views/markdown-view";
import { FileExplorerView } from "./views/file-explorer";
import { BacklinksView, OutlineView, TagPaneView } from "./views/sidebar-views";
import { SearchView } from "./views/search-view";
import { GraphView } from "./views/graph-view";
import { Modal, SuggestModal } from "./modals/modals";
import { TFile, pathName } from "./types";
import { rewriteWikilinksForRename } from "./rename";
import type { Command } from "./commands";

interface AppSettings {
  theme: "dark" | "light";
  readableLineLength: boolean;
  /** Selected community theme name ("" = built-in default). */
  cssTheme: string;
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
    return "file";
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
    this.geodeApp.commands.execute(cmd.id);
  }
}

class SettingsModal extends Modal {
  constructor(private geodeApp: App) {
    super(geodeApp);
    this.modalEl.classList.add("mod-settings");
  }

  onOpen(): void {
    const s = this.geodeApp.settings;
    this.contentEl.innerHTML = `<h2>Appearance</h2>`;
    this.addToggle("Dark mode", s.theme === "dark", (v) => {
      s.theme = v ? "dark" : "light";
      this.geodeApp.applySettings();
    });
    this.addToggle("Readable line length", s.readableLineLength, (v) => {
      s.readableLineLength = v;
      this.geodeApp.applySettings();
    });
    // Community theme picker: "Default" + any installed under .geode/themes/.
    this.addDropdown(
      "Theme",
      () => this.geodeApp.themeManager.list(),
      s.cssTheme,
      async (value) => {
        s.cssTheme = value;
        await this.geodeApp.themeManager.apply(value);
        this.geodeApp.saveSettings();
      }
    );

    const communityHeading = document.createElement("h2");
    communityHeading.textContent = "Community plugins & themes";
    this.contentEl.appendChild(communityHeading);
    const { control } = this.addRow("Install from GitHub");
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add…";
    addBtn.addEventListener("click", () => {
      this.close();
      new InstallFromGithubModal(this.geodeApp, this.geodeApp.communityManager).open();
    });
    control.appendChild(addBtn);
  }

  private addToggle(label: string, value: boolean, onChange: (v: boolean) => void) {
    const { control } = this.addRow(label);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => onChange(input.checked));
    control.appendChild(input);
  }

  private addDropdown(
    label: string,
    options: () => Promise<string[]>,
    selected: string,
    onChange: (value: string) => void
  ) {
    const { control } = this.addRow(label);
    const select = document.createElement("select");
    select.className = "dropdown";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Default";
    select.appendChild(def);
    select.value = selected;
    select.addEventListener("change", () => onChange(select.value));
    control.appendChild(select);
    // Populate installed themes asynchronously.
    options().then((names) => {
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      select.value = selected; // re-apply once options exist
    });
  }

  private addRow(label: string): { control: HTMLElement } {
    const row = document.createElement("div");
    row.className = "setting-item";
    const info = document.createElement("div");
    info.className = "setting-item-info";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = label;
    info.appendChild(name);
    const control = document.createElement("div");
    control.className = "setting-item-control";
    row.appendChild(info);
    row.appendChild(control);
    this.contentEl.appendChild(row);
    return { control };
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
  /** Plugins live under this vault's `.geode/plugins/`; recreated per vault open. */
  pluginManager!: PluginManager;
  themeManager = new ThemeManager(this);
  communityManager = new CommunityManager(this);
  settings: AppSettings = { theme: "dark", readableLineLength: true, cssTheme: "" };
  /** True while restoring a saved layout, to suppress re-saving the in-progress state. */
  private restoringLayout = false;
  private saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Apply the selected community theme (if the vault has it installed).
    this.themeManager.apply(this.settings.cssTheme);

    this.pluginManager = new PluginManager(this);
    await this.pluginManager.initialize();

    // Restore the saved workspace layout (tabs + docked plugin panes) now
    // that plugin view factories are registered; fall back to an empty tab.
    await this.restoreWorkspaceLayout();

    // Subscribe to layout changes BEFORE firing onLayoutReady, so that the
    // initial layout — including panes a plugin opens in its onLayoutReady
    // callback — is captured by the debounced save (restore itself is guarded
    // by restoringLayout, so nothing saves mid-restore).
    const scheduleSave = () => this.scheduleSaveLayout();
    this.workspace.on("layout-change", scheduleSave);
    this.workspace.on("active-leaf-change", scheduleSave);
    this.workspace.on("file-open", scheduleSave);

    // Now that the layout is in place, fire plugins' onLayoutReady callbacks —
    // a plugin that opens its own view will find and reuse the restored pane
    // (via getLeavesOfType) instead of creating a duplicate.
    this.workspace.flushLayoutReady();

    // Persist the initial layout (restored + any onLayoutReady-opened panes).
    this.scheduleSaveLayout();

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
    c("community-add", "Community: Install plugin or theme from GitHub", undefined, () =>
      new InstallFromGithubModal(this, this.communityManager).open()
    );
    c("toggle-theme", "Toggle dark/light theme", undefined, () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      this.applySettings();
      this.saveSettings();
    });
    c("daily-note", "Open today's daily note", "Mod+D", () => this.openDailyNote());
    c("open-graph", "Graph view: Open graph view", "Mod+G", () => this.openGraphView());
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

  /** Open the (singleton) global graph view, reusing an already-open graph tab if there is one. */
  async openGraphView(): Promise<void> {
    const existing = this.workspace.findLeafByViewType("graph");
    if (existing) {
      existing.group.setActiveLeaf(existing);
      return;
    }
    const leaf = this.workspace.getLeaf(false);
    await leaf.setView(new GraphView(this));
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

  /** Restore the saved per-vault workspace layout, or open an empty tab if there's none. */
  private async restoreWorkspaceLayout(): Promise<void> {
    this.restoringLayout = true;
    let restored = false;
    try {
      const saved = (await window.geode.readConfig("workspace")) as PersistedWorkspace | null;
      if (saved && saved.version === 1) {
        restored = await this.workspace.deserialize(saved);
      }
    } catch (err) {
      console.error("Failed to restore workspace layout", err);
    } finally {
      this.restoringLayout = false;
    }
    if (!restored) this.openEmptyTab(this.workspace.activeGroup);
  }

  /** Debounced persist of the current layout to `.geode/workspace.json`. */
  private scheduleSaveLayout(): void {
    if (this.restoringLayout) return;
    if (this.saveLayoutTimer) clearTimeout(this.saveLayoutTimer);
    this.saveLayoutTimer = setTimeout(() => {
      this.saveLayoutTimer = null;
      window.geode.writeConfig("workspace", this.workspace.serialize()).catch((err) => {
        console.error("Failed to save workspace layout", err);
      });
    }, 400);
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

  /** Construct a fresh MarkdownView bound to this app (used by WorkspaceLeaf.openFile for hosted plugins). */
  createMarkdownView(): MarkdownView {
    return new MarkdownView(this);
  }

  /** Construct the "No file is open" placeholder view (used when restoring/cleaning up empty leaves). */
  createEmptyView(): View {
    return new EmptyView(this);
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
    const oldPath = file.path;
    const referencers = this.metadataCache
      .getBacklinks(file)
      .map((b) => b.source)
      .filter((f) => f.path !== file.path);
    await this.vault.rename(file, newPath);
    const renamed = this.vault.getFileByPath(newPath);
    if (!renamed) return;
    const newBasename = renamed.basename;
    for (const ref of referencers) {
      const text = await this.vault.read(ref);
      const updated = rewriteWikilinksForRename(text, oldBasename, oldPathNoExt, oldPath, newBasename);
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
