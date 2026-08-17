import { Vault } from "./vault";
import { MetadataCache } from "./metadata-cache";
import { Workspace, TabGroup, View, type PersistedWorkspace } from "./workspace";
import { CommandRegistry } from "./commands";
import { PluginManager } from "./plugin-manager";
import { ThemeManager } from "./theme-manager";
import { CommunityManager } from "./community/community-manager";
import { InstallFromGithubModal } from "./community/install-modal";
import { MarkdownRenderer } from "./markdown/render";
import {
  MarkdownProcessorRegistry,
  type MarkdownCodeBlockProcessor,
  type MarkdownPostProcessor,
} from "./markdown/processor-registry";
import { hasExternalChange, MarkdownView } from "./views/markdown-view";
import { BaseView, defaultBaseYaml } from "./views/base-view";
import { FileExplorerView } from "./views/file-explorer";
import { BacklinksView, OutlineView, TagPaneView } from "./views/sidebar-views";
import { SearchView } from "./views/search-view";
import { GraphView } from "./views/graph-view";
import { WebView } from "./views/web-view";
import { Modal, PromptModal, SuggestModal } from "./modals/modals";
import { ChromeCookieImportModal } from "./modals/chrome-cookie-modal";
import { renderPerformanceTab } from "./settings/performance-tab";
import { TFile, isTFile, pathName } from "./types";
import { rewriteWikilinksForRename } from "./rename";
import { anchorSnapshot, parseLocalFileHref, shouldInterceptAnchor } from "./external-links";
import {
  resolveDailyNoteSettings,
  matchDailyNoteFile,
  dailyNotePath,
  type DailyNoteSettings,
} from "./daily-notes";
import type { Command } from "./commands";
import moment from "moment";
import type { PluginSettingTab } from "./api/obsidian";
import { setIcon } from "./api/icons";

/** Web Viewer settings (Settings → Web Viewer). Matches Obsidian's Web Viewer core plugin surface, plus Geode's Chrome cookie import. */
interface WebViewerSettings {
  /** URL prefix a search query is appended to (URI-encoded). */
  searchEngine: string;
  /** Default URL for "Open web viewer". */
  homeUrl: string;
  /** When true, clicking an external link opens it in a Web Viewer tab instead of the OS browser. */
  openLinksInApp: boolean;
}

const DEFAULT_WEB_VIEWER_SETTINGS: WebViewerSettings = {
  searchEngine: "https://duckduckgo.com/?q=",
  homeUrl: "https://duckduckgo.com/",
  openLinksInApp: false,
};

interface AppSettings {
  theme: "dark" | "light";
  readableLineLength: boolean;
  /** Selected community theme name ("" = built-in default). */
  cssTheme: string;
  webViewer: WebViewerSettings;
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

/** Ids of the built-in settings tabs, as opposed to a plugin id keyed into `App.settingTabs`. */
type BuiltinTabId = "appearance" | "community-plugins" | "performance";
const BUILTIN_TAB_IDS: BuiltinTabId[] = ["appearance", "community-plugins", "performance"];

class SettingsModal extends Modal {
  private navEl!: HTMLElement;
  private contentContainerEl!: HTMLElement;
  private activeTabId: string = "appearance";
  private unsubscribeSettingTabs: (() => void) | null = null;
  /** Cleanup for the Performance tab's live-metrics polling interval (set while that tab is active). */
  private stopPerformanceTab: (() => void) | null = null;

  constructor(private geodeApp: App) {
    super(geodeApp);
    this.modalEl.classList.add("mod-settings");
  }

  onOpen(): void {
    this.contentEl.empty();
    this.navEl = document.createElement("div");
    this.navEl.className = "vertical-tab-header";
    this.contentContainerEl = document.createElement("div");
    this.contentContainerEl.className = "vertical-tab-content-container";
    this.contentEl.append(this.navEl, this.contentContainerEl);

    // A plugin being enabled/disabled while the modal is open must update the
    // nav immediately, and bounce back to Appearance if the currently active
    // tab just disappeared.
    this.unsubscribeSettingTabs = this.geodeApp.onSettingTabsChanged(() => {
      this.renderNav();
      if (
        !(BUILTIN_TAB_IDS as string[]).includes(this.activeTabId) &&
        !this.geodeApp.settingTabs.has(this.activeTabId)
      ) {
        this.activateTab("appearance");
      }
    });

    // Real Obsidian always opens Settings on Appearance; last-active tab is
    // not persisted across opens.
    this.activateTab("appearance");
  }

  /** Switch the content pane (and nav highlight) to the tab with this id. Drives nav clicks, openTabById, and the initial onOpen(). */
  activateTab(id: string): void {
    if (!(BUILTIN_TAB_IDS as string[]).includes(this.activeTabId)) {
      const prevTab = this.geodeApp.settingTabs.get(this.activeTabId);
      if (prevTab) {
        try {
          prevTab.hide();
        } catch (err) {
          console.error(err);
        }
      }
    }
    // Leaving the Performance tab must stop its ~2s metrics-polling
    // interval — otherwise it keeps polling in the background for as long
    // as the modal stays open on a different tab.
    if (this.activeTabId === "performance" && this.stopPerformanceTab) {
      this.stopPerformanceTab();
      this.stopPerformanceTab = null;
    }

    this.activeTabId = id;
    this.renderNav();
    this.contentContainerEl.empty();

    if (id === "appearance") {
      this.renderAppearanceTab(this.contentContainerEl);
    } else if (id === "community-plugins") {
      this.renderCommunityTab(this.contentContainerEl);
    } else if (id === "performance") {
      this.stopPerformanceTab = renderPerformanceTab(this.contentContainerEl);
    } else {
      const tab = this.geodeApp.settingTabs.get(id);
      if (!tab) {
        // The requested plugin tab no longer exists (e.g. race with a
        // disable) — fall back rather than render an empty pane.
        this.activateTab("appearance");
        return;
      }
      this.contentContainerEl.appendChild(tab.containerEl);
      try {
        tab.display();
      } catch (err) {
        console.error(err);
        const errEl = document.createElement("div");
        errEl.className = "setting-tab-error";
        errEl.textContent = "This plugin's settings failed to load";
        this.contentContainerEl.appendChild(errEl);
      }
    }
  }

  /** Rebuild the left nav column: built-in tabs, then an alphabetized "Plugin options" group. */
  private renderNav(): void {
    this.navEl.empty();

    const addNavItem = (id: string, label: string, container: HTMLElement) => {
      const item = document.createElement("div");
      item.className = "vertical-tab-nav-item";
      item.textContent = label;
      item.classList.toggle("is-active", id === this.activeTabId);
      item.addEventListener("click", () => this.activateTab(id));
      container.appendChild(item);
    };

    addNavItem("appearance", "Appearance", this.navEl);
    addNavItem("community-plugins", "Community plugins & themes", this.navEl);
    addNavItem("performance", "Performance", this.navEl);

    const pluginTabs = [...this.geodeApp.settingTabs.keys()]
      .map((id) => ({ id, name: this.geodeApp.pluginManager?.getManifest(id)?.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (pluginTabs.length) {
      const group = document.createElement("div");
      group.className = "vertical-tab-header-group";
      const title = document.createElement("div");
      title.className = "vertical-tab-header-group-title";
      title.textContent = "Plugin options";
      group.appendChild(title);
      for (const { id, name } of pluginTabs) addNavItem(id, name, group);
      this.navEl.appendChild(group);
    }
  }

  private renderAppearanceTab(container: HTMLElement): void {
    const s = this.geodeApp.settings;
    container.innerHTML = `<h2>Appearance</h2>`;
    this.addToggle(container, "Dark mode", s.theme === "dark", (v) => {
      s.theme = v ? "dark" : "light";
      this.geodeApp.applySettings();
    });
    this.addToggle(container, "Readable line length", s.readableLineLength, (v) => {
      s.readableLineLength = v;
      this.geodeApp.applySettings();
    });
    // Community theme picker: "Default" + any installed under .geode/themes/.
    this.addDropdown(
      container,
      "Theme",
      () => this.geodeApp.themeManager.list(),
      s.cssTheme,
      async (value) => {
        s.cssTheme = value;
        await this.geodeApp.themeManager.apply(value);
        this.geodeApp.saveSettings();
      }
    );
  }

  private renderCommunityTab(container: HTMLElement): void {
    const s = this.geodeApp.settings;
    const webViewerHeading = document.createElement("h2");
    webViewerHeading.textContent = "Web Viewer";
    container.appendChild(webViewerHeading);
    this.addTextInput(container, "Search engine", s.webViewer.searchEngine, (v) => {
      s.webViewer.searchEngine = v;
      this.geodeApp.saveSettings();
    });
    this.addTextInput(container, "Home URL", s.webViewer.homeUrl, (v) => {
      s.webViewer.homeUrl = v;
      this.geodeApp.saveSettings();
    });
    this.addToggle(container, "Open external links in Geode", s.webViewer.openLinksInApp, (v) => {
      s.webViewer.openLinksInApp = v;
      this.geodeApp.saveSettings();
    });
    const { control: cookieControl } = this.addRow(
      container,
      "Import cookies from Chrome",
      "One-time import so viewer tabs open already logged in."
    );
    const cookieBtn = document.createElement("button");
    cookieBtn.textContent = "Import cookies from Chrome…";
    cookieBtn.addEventListener("click", () => new ChromeCookieImportModal(this.geodeApp).open());
    cookieControl.appendChild(cookieBtn);

    const communityHeading = document.createElement("h2");
    communityHeading.textContent = "Community plugins & themes";
    container.appendChild(communityHeading);
    const { control } = this.addRow(container, "Install from GitHub");
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add…";
    control.appendChild(addBtn);
    const listEl = document.createElement("div");
    listEl.className = "community-list";
    container.appendChild(listEl);
    addBtn.addEventListener("click", () => {
      new InstallFromGithubModal(this.geodeApp, this.geodeApp.communityManager, () =>
        this.renderCommunityList(listEl)
      ).open();
    });
    void this.renderCommunityList(listEl);
  }

  /** Render the list of tracked community items with per-item controls. */
  private async renderCommunityList(listEl: HTMLElement): Promise<void> {
    listEl.innerHTML = "";
    const cfg = await this.geodeApp.communityManager.load();
    const quarantined = this.geodeApp.pluginManager.listQuarantined();
    for (const [pluginId, diagnostic] of Object.entries(quarantined)) {
      const row = document.createElement("div");
      row.className = "community-item plugin-quarantine-item";
      row.dataset.pluginId = pluginId;
      const info = document.createElement("div");
      info.className = "community-item-info";
      const title = document.createElement("div");
      title.className = "community-item-title";
      title.textContent = `${this.geodeApp.pluginManager.getManifest(pluginId)?.name ?? pluginId} — quarantined`;
      const detail = document.createElement("div");
      detail.className = "community-item-sub";
      detail.textContent = `${diagnostic.boundary}: ${diagnostic.message}`;
      info.append(title, detail);
      const restore = document.createElement("button");
      restore.textContent = "Restore plugin";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try {
          await this.geodeApp.pluginManager.restoreQuarantined(pluginId);
          this.geodeApp.notify(`Restored ${this.geodeApp.pluginManager.getManifest(pluginId)?.name ?? pluginId}`);
        } catch (error) {
          this.geodeApp.notify(`Could not restore ${pluginId}: ${(error as Error).message}`);
        }
        await this.renderCommunityList(listEl);
      });
      row.append(info, restore);
      listEl.appendChild(row);
    }
    if (!cfg.items.length && !Object.keys(quarantined).length) {
      const empty = document.createElement("div");
      empty.className = "community-empty";
      empty.textContent = "No community plugins or themes installed yet.";
      listEl.appendChild(empty);
      return;
    }
    for (const item of cfg.items) {
      listEl.appendChild(this.renderCommunityRow(item, listEl));
    }
  }

  private renderCommunityRow(
    item: import("./community/store").CommunityItem,
    listEl: HTMLElement
  ): HTMLElement {
    const cm = this.geodeApp.communityManager;
    const refresh = () => this.renderCommunityList(listEl);
    const pinned = Boolean(item.pinnedVersion);
    // Only meaningful for type "plugin" (themes aren't gated by plugin
    // policy), but isBlocked() is a safe no-op id lookup either way.
    const blocked = this.geodeApp.pluginManager.isBlocked(item.id);

    const row = document.createElement("div");
    row.className = "community-item";
    row.dataset.repo = item.repo;

    const info = document.createElement("div");
    info.className = "community-item-info";
    info.innerHTML =
      `<div class="community-item-title">${item.id}` +
      `<span class="community-item-badge">${item.type}</span>` +
      (pinned ? `<span class="community-item-badge is-pinned">pinned</span>` : "") +
      (blocked
        ? `<span class="community-item-badge is-blocked" title="Disabled by administrator policy">blocked by admin</span>`
        : "") +
      `</div>` +
      `<div class="community-item-sub">${item.repo} · v${item.installedVersion}</div>`;
    row.appendChild(info);

    const controls = document.createElement("div");
    controls.className = "community-item-controls";

    const autoLabel = document.createElement("label");
    autoLabel.className = "community-item-toggle";
    const auto = document.createElement("input");
    auto.type = "checkbox";
    auto.checked = item.autoUpdate;
    auto.disabled = pinned;
    auto.addEventListener("change", async () => {
      await cm.setAutoUpdate(item.repo, auto.checked);
      await refresh();
    });
    autoLabel.appendChild(auto);
    autoLabel.appendChild(document.createTextNode(" auto-update"));
    controls.appendChild(autoLabel);

    const pinLabel = document.createElement("label");
    pinLabel.className = "community-item-toggle";
    const pin = document.createElement("input");
    pin.type = "checkbox";
    pin.checked = pinned;
    pin.addEventListener("change", async () => {
      await cm.setPinned(item.repo, pin.checked);
      await refresh();
    });
    pinLabel.appendChild(pin);
    pinLabel.appendChild(document.createTextNode(" pin"));
    controls.appendChild(pinLabel);

    const updateBtn = document.createElement("button");
    updateBtn.textContent = "Update now";
    updateBtn.disabled = pinned;
    updateBtn.addEventListener("click", async () => {
      updateBtn.disabled = true;
      const sum = await cm.checkForUpdates({ repos: [item.repo] });
      if (sum.updated.length) this.geodeApp.notify(`Updated ${sum.updated.join(", ")}`);
      else if (sum.failed.length) this.geodeApp.notify(`Update failed: ${sum.failed[0].error}`);
      else this.geodeApp.notify(`${item.id} is up to date`);
      await refresh();
    });
    controls.appendChild(updateBtn);

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "Stop updating";
    stopBtn.title = "Keep the files but stop tracking updates";
    stopBtn.addEventListener("click", async () => {
      await cm.stopUpdating(item.repo);
      this.geodeApp.notify(`Stopped tracking ${item.id}`);
      await refresh();
    });
    controls.appendChild(stopBtn);

    const uninstallBtn = document.createElement("button");
    uninstallBtn.textContent = "Uninstall";
    uninstallBtn.addEventListener("click", async () => {
      await cm.uninstall(item.repo);
      this.geodeApp.notify(`Uninstalled ${item.id}`);
      await refresh();
    });
    controls.appendChild(uninstallBtn);

    row.appendChild(controls);
    return row;
  }

  private addToggle(container: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void) {
    const { control } = this.addRow(container, label);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => onChange(input.checked));
    control.appendChild(input);
  }

  private addDropdown(
    container: HTMLElement,
    label: string,
    options: () => Promise<string[]>,
    selected: string,
    onChange: (value: string) => void
  ) {
    const { control } = this.addRow(container, label);
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

  private addRow(container: HTMLElement, label: string, description?: string): { control: HTMLElement } {
    const row = document.createElement("div");
    row.className = "setting-item";
    const info = document.createElement("div");
    info.className = "setting-item-info";
    const name = document.createElement("div");
    name.className = "setting-item-name";
    name.textContent = label;
    info.appendChild(name);
    if (description) {
      const desc = document.createElement("div");
      desc.className = "setting-item-description";
      desc.textContent = description;
      info.appendChild(desc);
    }
    const control = document.createElement("div");
    control.className = "setting-item-control";
    row.appendChild(info);
    row.appendChild(control);
    container.appendChild(row);
    return { control };
  }

  private addTextInput(container: HTMLElement, label: string, value: string, onChange: (v: string) => void) {
    const { control } = this.addRow(container, label);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "web-view-address";
    input.value = value;
    input.spellcheck = false;
    input.addEventListener("change", () => onChange(input.value.trim()));
    control.appendChild(input);
  }

  onClose(): void {
    if (!(BUILTIN_TAB_IDS as string[]).includes(this.activeTabId)) {
      const activeTab = this.geodeApp.settingTabs.get(this.activeTabId);
      if (activeTab) {
        try {
          activeTab.hide();
        } catch (err) {
          console.error(err);
        }
      }
    }
    // The modal can close while Performance is the active tab (not just via
    // activateTab switching away from it) — stop its polling interval here
    // too, or it leaks and keeps polling in the background.
    if (this.stopPerformanceTab) {
      this.stopPerformanceTab();
      this.stopPerformanceTab = null;
    }
    this.unsubscribeSettingTabs?.();
    this.unsubscribeSettingTabs = null;
    this.geodeApp.activeSettingsModal = null;
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
  /** Reading-view code-block + post processors registered by plugins (see `Plugin.registerMarkdownCodeBlockProcessor`). */
  markdownProcessors = new MarkdownProcessorRegistry();
  /**
   * Hover-link sources registered by plugins (`Plugin.registerHoverLinkSource`).
   * STORE-ONLY: Geode has no hover-preview infrastructure yet, so this is kept
   * purely so the registration is a well-behaved, inspectable no-op rather than
   * silently dropped. Nothing reads it to drive rendering.
   */
  hoverLinkSources = new Map<string, unknown>();
  /**
   * In-editor autocomplete suggests registered by plugins
   * (`Plugin.registerEditorSuggest`). STORE-ONLY, like `hoverLinkSources`:
   * Geode doesn't yet drive the suggest popover from the editor, so this
   * keeps the registration inspectable/cleaned-up rather than silently
   * dropping it. Nothing reads it to drive behavior yet.
   */
  editorSuggests = new Set<unknown>();
  workspace!: Workspace;
  statusBar!: StatusBar;
  private ribbonActionsEl!: HTMLElement;
  /** Plugins live under this vault's `.geode/plugins/`; recreated per vault open. */
  pluginManager!: PluginManager;
  themeManager = new ThemeManager(this);
  communityManager = new CommunityManager(this);
  settings: AppSettings = {
    theme: "dark",
    readableLineLength: true,
    cssTheme: "",
    webViewer: { ...DEFAULT_WEB_VIEWER_SETTINGS },
  };
  /** Resolved "daily-notes" config (defaults until a vault is opened); also read by the internalPlugins compat shim. */
  dailyNoteSettings: DailyNoteSettings = resolveDailyNoteSettings(null);
  /** True while restoring a saved layout, to suppress re-saving the in-progress state. */
  private restoringLayout = false;
  private saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Plugin settings tabs -----------------------------------------------

  /** Registered plugin settings tabs, keyed by plugin id (`Plugin.addSettingTab`). */
  settingTabs = new Map<string, PluginSettingTab>();
  private settingTabListeners = new Set<() => void>();

  registerSettingTab(id: string, tab: PluginSettingTab): void {
    this.settingTabs.set(id, tab);
    this.settingTabListeners.forEach((fn) => fn());
  }

  unregisterSettingTab(id: string): void {
    this.settingTabs.delete(id);
    this.settingTabListeners.forEach((fn) => fn());
  }

  /** Subscribe to setting-tab registry changes; returns an unsubscribe function. */
  onSettingTabsChanged(fn: () => void): () => void {
    this.settingTabListeners.add(fn);
    return () => this.settingTabListeners.delete(fn);
  }

  // --- Markdown reading-view processors -----------------------------------
  // Thin delegations to `markdownProcessors`, called by the Obsidian-compat
  // `Plugin` (see api/obsidian.ts). Registration returns a handle and cleanup
  // is arranged plugin-side via `Component.register`, mirroring `registerView`.

  /**
   * Register a reading-view code-block processor for a fenced language.
   * Returns a `MarkdownPostProcessor` handle for API parity with Obsidian
   * (whose `.sortOrder` is settable); the handle itself is not what drives
   * dispatch — code blocks dispatch by language via `markdownProcessors`.
   */
  registerMarkdownCodeBlockProcessor(
    lang: string,
    handler: MarkdownCodeBlockProcessor
  ): MarkdownPostProcessor {
    this.markdownProcessors.registerCodeBlock(lang, handler);
    return Object.assign((_el: HTMLElement) => {}, { sortOrder: 0 }) as MarkdownPostProcessor;
  }

  unregisterMarkdownCodeBlockProcessor(lang: string, handler: MarkdownCodeBlockProcessor): void {
    this.markdownProcessors.unregisterCodeBlock(lang, handler);
  }

  /** Register a whole-document reading-view post processor. Returns the handle for later unregistration. */
  registerMarkdownPostProcessor(
    processor: MarkdownPostProcessor,
    sortOrder = 0
  ): MarkdownPostProcessor {
    return this.markdownProcessors.registerPostProcessor(processor, sortOrder);
  }

  unregisterMarkdownPostProcessor(processor: MarkdownPostProcessor): void {
    this.markdownProcessors.unregisterPostProcessor(processor);
  }

  setting = {
    open: () => this.openSettingsModal(),
    openTabById: (id: string) => this.openSettingsModal(id),
    close: () => this.activeSettingsModal?.close(),
  };

  /**
   * The singleton Settings modal instance, reused across opens. Not
   * `private` — `SettingsModal.onClose()` clears it back to `null` when the
   * modal closes.
   */
  activeSettingsModal: SettingsModal | null = null;

  private openSettingsModal(tabId?: string): void {
    if (!this.activeSettingsModal) this.activeSettingsModal = new SettingsModal(this);
    this.activeSettingsModal.open();
    if (tabId) this.activeSettingsModal.activateTab(tabId);
  }

  /** Mount the exact action element created by Plugin.addRibbonIcon(). */
  addRibbonIcon(el: HTMLElement): void {
    this.ribbonActionsEl.appendChild(el);
  }

  async start() {
    this.installExternalLinkInterceptor();
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
    if (saved) {
      this.settings = {
        ...this.settings,
        ...saved,
        webViewer: { ...this.settings.webViewer, ...saved.webViewer },
      };
    }

    // Loaded before pluginManager.initialize() so the internalPlugins compat
    // shim (installObsidianAppCompat in api/obsidian.ts) has settings ready
    // before any hosted plugin (e.g. Calendar) can query "daily-notes".
    const savedDailyNotes = (await window.geode.readConfig(
      "daily-notes"
    )) as Partial<DailyNoteSettings> | null;
    this.dailyNoteSettings = resolveDailyNoteSettings(savedDailyNotes);

    rootEl.innerHTML = "";
    const shell = document.createElement("div");
    shell.className = "app-shell";
    rootEl.appendChild(shell);

    const main = document.createElement("div");
    main.className = "app-main";
    shell.appendChild(main);

    const ribbon = document.createElement("div");
    ribbon.className = "workspace-ribbon mod-left";
    ribbon.setAttribute("aria-label", "Ribbon");
    this.ribbonActionsEl = document.createElement("div");
    this.ribbonActionsEl.className = "workspace-ribbon-actions";
    const ribbonBottom = document.createElement("div");
    ribbonBottom.className = "workspace-ribbon-bottom";
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "side-dock-ribbon-action";
    settingsButton.title = "Open settings";
    settingsButton.setAttribute("aria-label", "Open settings");
    setIcon(settingsButton, "settings");
    settingsButton.addEventListener("click", () => this.setting.open());
    ribbonBottom.appendChild(settingsButton);
    ribbon.append(this.ribbonActionsEl, ribbonBottom);
    main.appendChild(ribbon);

    this.workspace = new Workspace(this, main);
    this.statusBar = new StatusBar(this, shell);

    // Sidebar views
    this.workspace.leftSidebar.addView(new FileExplorerView(this));
    this.workspace.leftSidebar.addView(new SearchView(this));
    this.workspace.rightSidebar.addView(new BacklinksView(this));
    this.workspace.rightSidebar.addView(new OutlineView(this));
    this.workspace.rightSidebar.addView(new TagPaneView(this));

    // Obsidian Web Viewer compat: viewType "webviewer" + { url } state, so
    // any hosted plugin targeting that view type (e.g. Threads'
    // obsidian_open_url) opens a tab here too. Must be registered before
    // restoreWorkspaceLayout() below, which resolves saved leaves by type.
    this.workspace.registerViewFactory("webviewer", (leaf) => new WebView(this, leaf));

    this.registerCommands();
    this.commands.attach(document);
    this.applySettings();
    // Apply the selected community theme (if the vault has it installed).
    this.themeManager.apply(this.settings.cssTheme);

    this.pluginManager = new PluginManager(this);
    await this.pluginManager.initialize();
    if (this.pluginManager.isRecoveryMode()) this.showCrashRecoveryBanner(shell);

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

    // Index the vault's metadata BEFORE firing onLayoutReady. Obsidian
    // guarantees the metadata cache is resolved by the time layout-ready
    // fires, and plugins rely on it: obsidian-tasks builds its task cache in
    // an onLayoutReady callback by reading `getFileCache(f).listItems` for
    // every file — if the metadata isn't indexed yet it finds nothing, caches
    // an empty result, and a ```tasks query renders "0 tasks". `initialize()`
    // also fires the "resolved" event plugins subscribe to.
    await this.metadataCache.initialize();
    this.notify(`Indexed ${this.vault.getMarkdownFiles().length} notes`);

    // Now that the layout is in place and metadata is indexed, fire plugins'
    // onLayoutReady callbacks — a plugin that opens its own view will find and
    // reuse the restored pane (via getLeavesOfType) instead of creating a
    // duplicate.
    this.workspace.flushLayoutReady();

    // Persist the initial layout (restored + any onLayoutReady-opened panes).
    this.scheduleSaveLayout();

    // Check opt-in community items for updates shortly after startup, off the
    // critical path. No-op unless a tracked item has auto-update enabled.
    setTimeout(() => void this.checkCommunityUpdates(false), 2500);

    // Re-render open views when files change externally.
    //
    // This must compare against `view.getLastKnownText()` (last text this
    // view knows to be on disk), NOT `view.getText()` (live, in-progress
    // editor content). `MarkdownView.flush()` autosaves 1s after the last
    // keystroke and can be echoed by up to two "modify" events (a
    // synchronous one from `Vault.modify()` and a delayed one from the
    // main-process chokidar watcher — see `src/main/main.ts`). If the user
    // is still typing when that echo arrives, `getText()` legitimately
    // differs from what was just saved, which this handler used to
    // misdiagnose as an external change and respond to with a full
    // `setFile()` → editor teardown/rebuild — the visible "document
    // disappears then re-renders" flicker, which also dropped any
    // keystrokes typed after the autosave snapshot. Comparing disk content
    // against the last-known-saved text instead is immune to duplicate/
    // delayed echoes and only fires `setFile()` for genuine external edits.
    // Mirrors `BaseView.reloadIfChangedExternally()` (`base-view.ts`) —
    // don't "simplify" this back to comparing live editor text.
    this.vault.on("modify", async (file: TFile) => {
      const leaf = this.workspace.findLeafForFile(file.path);
      const view = leaf?.view;
      if (view instanceof MarkdownView && view.file) {
        const text = await this.vault.cachedRead(view.file);
        if (hasExternalChange(text, view.getLastKnownText())) await view.setFile(view.file);
      }
    });
  }

  private showCrashRecoveryBanner(shell: HTMLElement): void {
    const banner = document.createElement("div");
    banner.className = "crash-recovery-banner";
    const message = document.createElement("span");
    message.textContent = "Geode recovered from a renderer failure. Community plugins are temporarily suppressed; your vault data was not changed.";
    const retry = document.createElement("button");
    retry.textContent = "Restart with plugins";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      await this.pluginManager.leaveRecoveryMode();
      location.reload();
    });
    banner.append(message, retry);
    shell.prepend(banner);
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
    c("open-settings", "Open settings", "Mod+,", () => this.setting.open());
    c("community-add", "Community: Install plugin or theme from GitHub", undefined, () =>
      new InstallFromGithubModal(this, this.communityManager).open()
    );
    c("community-check-updates", "Community: Check for updates", undefined, () =>
      void this.checkCommunityUpdates(true)
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
    c("open-web-viewer", "Open web viewer", undefined, () => void this.openWebViewer());
    c("search-web", "Search the web", undefined, () => this.searchWeb());
    c("pin-tab", "Toggle pin on current tab", undefined, () => {
      const leaf = this.workspace.getActiveLeaf();
      if (leaf) {
        leaf.pinned = !leaf.pinned;
        leaf.group.renderTabs();
      }
    });
    c("bases-create", "Bases: Create new base", undefined, () => {
      const activeFile = this.workspace.getActiveFile();
      void this.createNewBase(activeFile?.parent ?? "");
    });
    c("bases-insert", "Bases: Insert new base", undefined, () => this.insertNewBase());
    c("bases-add-view", "Bases: Add view", undefined, () => this.getActiveBaseView()?.addView());
  }

  // --- File opening -------------------------------------------------------

  async openFile(file: TFile, newTab: boolean): Promise<void> {
    if (file.extension === "base") {
      const existing = this.workspace.findLeafForFile(file.path);
      if (existing && !newTab) {
        existing.group.setActiveLeaf(existing);
        return;
      }
      const leaf = this.workspace.getLeaf(newTab);
      const current = leaf.view;
      if (current instanceof BaseView) {
        await current.setFile(file);
        leaf.group.renderTabs();
        this.workspace.trigger("file-open", file);
      } else {
        const view = new BaseView(this);
        await view.setFile(file);
        await leaf.setView(view);
      }
      return;
    }
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

  /** Create a new `.base` file (Obsidian's "Bases: Create new base" command / file-explorer "New base" menu item) and open it. */
  async createNewBase(folder?: string, name?: string): Promise<void> {
    const path = name
      ? this.vault.availablePath(folder ?? "", name, "base")
      : this.vault.availablePath(folder ?? "", "Untitled", "base");
    const file = await this.vault.create(path, defaultBaseYaml());
    await this.openFile(file, false);
  }

  /**
   * "Bases: Insert new base" — embeds a base as a ```base fenced code block
   * in the active markdown note, at the cursor. Reading view renders that
   * block as a live, interactive base (see MarkdownRenderer.mountBases).
   */
  insertNewBase(): void {
    const view = this.getActiveMarkdownView();
    if (!view?.editor) return;
    const block = "```base\n" + defaultBaseYaml() + "```\n";
    const { from, to } = view.editor.state.selection.main;
    view.editor.dispatch({ changes: { from, to, insert: block } });
  }

  getActiveBaseView(): BaseView | null {
    const view = this.workspace.getActiveLeaf()?.view;
    return view instanceof BaseView ? view : null;
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

  /** "Open web viewer" (Obsidian compat command `open-web-viewer`): opens a new Web Viewer tab at the given URL, or the configured home URL. */
  async openWebViewer(url?: string): Promise<void> {
    const leaf = this.workspace.getLeaf(true);
    await leaf.setViewState({
      type: "webviewer",
      active: true,
      state: { url: url ?? this.settings.webViewer.homeUrl },
    });
  }

  /** "Search the web" (Obsidian compat command `search-web`): prompts for a query, opens the results in a Web Viewer tab. */
  searchWeb(): void {
    new PromptModal(this, {
      placeholder: "Search the web…",
      onSubmit: (query) => {
        void this.openWebViewer(`${this.settings.webViewer.searchEngine}${encodeURIComponent(query)}`);
      },
    }).open();
  }

  /**
   * Global safety net for external-link clicks. Plugin content (e.g. Claude
   * Threads) renders ordinary `<a href="https://…">` anchors that no other
   * handler catches, so without this a click would navigate the entire
   * renderer window away from the app. This delegated listener intercepts
   * such clicks and routes them through `openExternalLink` (Web Viewer or OS
   * browser) instead.
   *
   * Anchors already handled elsewhere — Live Preview external/wiki links and
   * rendered-Markdown internal-link/tag anchors (which call `preventDefault`
   * before the event bubbles to `document`) — are skipped: the
   * `defaultPrevented` bail-out defers to those handlers, and
   * `shouldInterceptAnchor` additionally skips them by class / `data-href`.
   * The main-process `will-navigate` guard (src/main/main.ts) is the last
   * line of defense if anything ever slips past this.
   */
  private installExternalLinkInterceptor(): void {
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      // Events crossing a plugin's shadow-root boundary are retargeted to the
      // shadow host at `document`. Inspect the composed path first so anchors
      // rendered inside an open shadow root receive the same handling as
      // ordinary plugin DOM.
      const anchor = e.composedPath().find(
        (node): node is HTMLAnchorElement =>
          node instanceof HTMLAnchorElement && node.matches("a[href]")
      ) ?? null;
      if (!anchor || !shouldInterceptAnchor(anchorSnapshot(anchor))) return;
      e.preventDefault();
      e.stopPropagation();
      const rawHref = anchor.getAttribute("href")!;
      const localHref = parseLocalFileHref(rawHref) ? rawHref :
        (parseLocalFileHref(anchor.href) ? anchor.href : null);
      if (localHref) {
        void this.openLocalFileLink(localHref);
        return;
      }
      const href = anchor.href || rawHref;
      // Cmd/Ctrl-click forces the OS browser, matching the Live Preview
      // convention (markdown/live-preview.ts).
      if (e.metaKey || e.ctrlKey) window.geode.openExternal(href);
      else this.openExternalLink(href);
    });
  }

  private async openLocalFileLink(href: string): Promise<void> {
    const result = await window.geode.openLocalFile(href);
    if (result.kind !== "vault") return;
    const file = this.vault.getAbstractFileByPath(result.path);
    if (!isTFile(file)) return;
    await this.openFile(file, false);
    if (file.extension === "md" && result.line !== undefined) {
      const view = this.getActiveMarkdownView();
      if (!view?.editor) return;
      const line = view.editor.state.doc.line(Math.min(result.line, view.editor.state.doc.lines));
      const columnOffset = Math.min((result.column ?? 1) - 1, line.length);
      view.scrollToOffset(line.from + columnOffset);
    }
  }

  /** Route an external link click through the Web Viewer or the OS browser, per the "open links in app" setting. */
  openExternalLink(url: string): void {
    // Only web URLs can render in the in-app Web Viewer; anything else (e.g.
    // mailto:) always goes to the OS regardless of the setting.
    if (this.settings.webViewer.openLinksInApp && /^https?:\/\//i.test(url)) {
      void this.openWebViewer(url);
    } else {
      window.geode.openExternal(url);
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

  /**
   * Open today's daily note, creating it (under the configured folder/format)
   * if it doesn't exist yet. Shares `resolveDailyNoteSettings`/
   * `matchDailyNoteFile` with the "daily-notes" internalPlugins compat shim
   * (api/obsidian.ts) so Geode's own feature and hosted plugins (e.g.
   * Calendar, via obsidian-daily-notes-interface) agree on what "today's
   * note" means.
   */
  async openDailyNote(): Promise<void> {
    const settings = this.dailyNoteSettings;
    const today = moment();
    const key = today.format(settings.format);
    const index = matchDailyNoteFile(this.vault.getMarkdownFiles(), settings);
    let file = index.get(key) ?? null;
    if (!file) {
      file = await this.vault.create(dailyNotePath(today, settings), `# ${key}\n\n`);
    }
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
    // Real Obsidian hides .view-header entirely unless <body> has this class
    // (`body:not(.show-view-header):not(.is-phone) .view-header { display: none }`).
    // Geode always shows it — there's no settings toggle for this yet.
    document.body.classList.add("show-view-header");
  }

  saveSettings() {
    window.geode.writeConfig("app", this.settings);
  }

  /** Select a community theme by name (or "" for the built-in default): apply it and persist. */
  async applyCommunityTheme(name: string): Promise<void> {
    this.settings.cssTheme = name;
    await this.themeManager.apply(name);
    this.saveSettings();
  }

  /**
   * Run a community update check and surface the result as notices. `force`
   * (the command) checks every non-pinned item; otherwise (on-launch) only
   * opt-in items past the cadence.
   */
  async checkCommunityUpdates(force: boolean): Promise<void> {
    try {
      const sum = await this.communityManager.checkForUpdates({ force });
      if (sum.updated.length) {
        this.notify(`Updated ${sum.updated.length} community item(s): ${sum.updated.join(", ")}`);
      } else if (force) {
        this.notify(sum.checked ? `Community: all ${sum.checked} up to date` : "No community items to check");
      }
      for (const f of sum.failed) console.error(`Community update check failed for ${f.repo}: ${f.error}`);
      if (force && sum.failed.length) {
        this.notify(`${sum.failed.length} community update check(s) failed — see console`);
      }
    } catch (err) {
      console.error("Community update check failed", err);
    }
  }
}

const app = new App();
app.start();
(window as any).app = app;
