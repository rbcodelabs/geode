import { Vault } from "./vault";
import { MetadataCache } from "./metadata-cache";
import {
  DEFAULT_METADATA_SCAN_CAP_BYTES,
  MAX_METADATA_SCAN_CAP_BYTES,
  MIN_METADATA_SCAN_CAP_BYTES,
  resolveMetadataScanCapBytes,
} from "../indexer/metadata-indexer";
import { Workspace, TabGroup, View, type PersistedWorkspace, type ReloadableView, type WorkspaceLeaf } from "./workspace";
import { CommandRegistry } from "./commands";
import { displayHotkey, eventToBinding, bindingIdentity, type Hotkey } from "../shared/hotkey";
import { PluginManager } from "./plugin-manager";
import { ThemeManager } from "./theme-manager";
import { CommunityManager } from "./community/community-manager";
import { InstallFromGithubModal } from "./community/install-modal";
import { MarkdownRenderer } from "./markdown/render";
import { MermaidPlugin } from "./internal-plugins/mermaid/mermaid-plugin";
import {
  MarkdownProcessorRegistry,
  type MarkdownCodeBlockProcessor,
  type MarkdownPostProcessor,
} from "./markdown/processor-registry";
import { hasExternalChange, MarkdownView } from "./views/markdown-view";
import { BaseView, defaultBaseYaml } from "./views/base-view";
import { CanvasView } from "./views/canvas-view";
import { serializeCanvas } from "./canvas/canvas-data";
import { FileExplorerView } from "./views/file-explorer";
import { BacklinksView, OutlineView, TagPaneView } from "./views/sidebar-views";
import { SearchView } from "./views/search-view";
import { GraphView } from "./views/graph-view";
import { WebView } from "./views/web-view";
import { ArtifactView } from "./views/artifact-view";
import { Modal, PromptModal, SuggestModal } from "./modals/modals";
import { ChromeCookieImportModal } from "./modals/chrome-cookie-modal";
import { renderPerformanceTab } from "./settings/performance-tab";
import { FileSystemAdapter, TFile, TFolder, isTFile, pathName } from "./types";
import {
  addBookmark,
  createEmptyRoot,
  findBookmark,
  findBookmarkByPath,
  normalizeBookmarksRoot,
  removeBookmark,
  type Bookmark,
  type BookmarksRoot,
} from "./bookmarks";
import { renamePathForBasename, rewriteWikilinksForRename } from "./rename";
import { buildConflictPath, formatConflictTimestamp } from "./reconciliation";
import {
  ActionRegistry,
  DOCUMENT_MENU_SPEC,
  FOLDER_MENU_SPEC,
  TAB_MENU_SPEC,
  WEB_TAB_MENU_SPEC,
  composeMenu,
  createActionCommand,
  tabCloseTargets,
} from "./actions";
import { anchorSnapshot, parseLocalFileHref, shouldInterceptAnchor } from "./external-links";
import { initTooltips } from "./tooltip";
import {
  DailyNotesService,
  matchDailyNoteFile,
  dailyNotePath,
  type DailyNoteSettings,
} from "./daily-notes";
import type { Command } from "./commands";
import moment from "moment";
import { Menu, type PluginSettingTab, installObsidianAppCompat } from "./api/obsidian";
import { createDismissibleNotice } from "./notice";
import { setIcon } from "./api/icons";
import { FileManager } from "./file-manager";
import { measureOperation } from "./perf-instrumentation";
import { applyWindowChromeState } from "./window-chrome";
import { getHostServices } from "./host/registry";
import type { HostServices } from "./host/contracts";
import { VaultAccessError } from "./host/contracts";
import { mobileVaultActions, vaultAccessPresentation } from "./host/mobile-vault-access";

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
  showRibbon: boolean;
  showStatusBar: boolean;
  /** Selected community theme name ("" = built-in default). */
  cssTheme: string;
  webViewer: WebViewerSettings;
  /**
   * Cap (in bytes of a note's body, after frontmatter is stripped) beyond
   * which `parseMetadata` skips heading/tag/link/list-item indexing for that
   * note — see `resolveMetadataScanCapBytes`'s doc comment for the OOM this
   * protects against and why it defaults to `DEFAULT_METADATA_SCAN_CAP_BYTES`.
   * Surfaced in Settings -> Advanced in KB; always a resolved (clamped)
   * value, never raw/unvalidated user input.
   */
  metadataScanCapBytes: number;
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

export interface AppActionContext {
  file?: TFile | null;
  resource?: TFile | TFolder | null;
  leaf?: WorkspaceLeaf | null;
  view?: MarkdownView | null;
  /** Present on a Web Viewer tab. Gates the page-scoped actions (bookmark). */
  webView?: WebView | null;
  /** Present on any view that can reload itself in place (Web Viewer, Artifact). */
  reloadable?: ReloadableView | null;
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
    const label = this.geodeApp.commands.bindingsFor(cmd.id).map(binding => displayHotkey(binding)).join(", ");
    const title = document.createElement("div");
    title.className = "prompt-result-title";
    title.textContent = cmd.name;
    el.append(title);
    if (label) {
      const hotkey = document.createElement("span");
      hotkey.className = "prompt-result-hotkey";
      hotkey.textContent = label;
      el.append(hotkey);
    }
  }

  onChooseItem(cmd: Command): void {
    this.geodeApp.commands.execute(cmd.id);
  }
}

class ManageVaultsModal extends Modal {
  private actionPending = false;

  constructor(private geodeApp: App) {
    super(geodeApp);
    this.modalEl.classList.add("mod-manage-vaults");
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    const heading = document.createElement("h2");
    heading.textContent = "Manage vaults";
    this.contentEl.appendChild(heading);

    const currentPath = this.geodeApp.vault.root;
    const recents = await this.geodeApp.host.vaultRegistry.getRecentVaults();
    const paths = [currentPath, ...recents.filter((vaultPath) => vaultPath !== currentPath)];
    const list = document.createElement("div");
    list.className = "vault-switcher-list";
    for (const vaultPath of paths) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "vault-switcher-row";
      const name = document.createElement("span");
      name.className = "vault-switcher-name";
      name.textContent = vaultPath.split(/[\\/]/).filter(Boolean).pop() ?? vaultPath;
      const pathEl = document.createElement("span");
      pathEl.className = "vault-switcher-path";
      pathEl.textContent = this.geodeApp.host.runtime.runtime === "ios" ? "Loading…" : vaultPath;
      if (this.geodeApp.host.runtime.runtime === "ios") {
        void this.geodeApp.host.vaultRegistry.describeVault(vaultPath).then((descriptor) => {
          name.textContent = descriptor.name;
          pathEl.textContent = descriptor.kind === "managed" ? "On this device" : "Files folder";
        }).catch((error) => this.showError(error));
      }
      row.append(name, pathEl);
      if (vaultPath === currentPath) {
        row.classList.add("is-current");
        const marker = document.createElement("span");
        marker.className = "vault-switcher-current";
        marker.textContent = "Open in this window";
        row.appendChild(marker);
      }
      row.addEventListener("click", () => void this.runVaultAction(() => this.openVaultWindow(vaultPath)));
      list.appendChild(row);
    }
    this.contentEl.appendChild(list);

    const openFolder = document.createElement("button");
    openFolder.type = "button";
    openFolder.className = "mod-cta vault-switcher-open-folder";
    openFolder.textContent = "Open folder as vault";
    openFolder.addEventListener("click", () => void this.runVaultAction(() => this.chooseVault()));
    this.contentEl.appendChild(openFolder);

    if (this.geodeApp.host.capabilities.externalVaultFolder) {
      const chooseFiles = document.createElement("button");
      chooseFiles.type = "button";
      chooseFiles.className = "vault-switcher-choose-files";
      chooseFiles.textContent = "Choose folder in Files";
      chooseFiles.addEventListener("click", () => void this.runVaultAction(() => this.chooseExternalVault()));
      this.contentEl.appendChild(chooseFiles);
    }
  }

  private async chooseVault(): Promise<void> {
    const vaultPath = await this.geodeApp.host.vaultRegistry.chooseVault();
    if (vaultPath) await this.openVaultWindow(vaultPath);
  }

  private async chooseExternalVault(): Promise<void> {
    const vaultId = await this.geodeApp.host.vaultRegistry.chooseExternalVault();
    if (vaultId) await this.openVaultWindow(vaultId);
  }

  private async openVaultWindow(vaultPath: string): Promise<void> {
    if (vaultPath === this.geodeApp.vault.root) {
      this.close();
      return;
    }
    if (!this.geodeApp.host.capabilities.multipleWindows || !this.geodeApp.host.desktop) {
      await this.geodeApp.switchVaultInWindow(vaultPath);
    } else {
      await this.geodeApp.host.desktop.openVaultWindow(vaultPath);
      this.close();
    }
  }

  private setActionPending(pending: boolean): void {
    this.actionPending = pending;
    for (const button of this.contentEl.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = pending;
    }
  }

  private async runVaultAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending) return;
    this.setActionPending(true);
    try {
      await action();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setActionPending(false);
    }
  }

  private showError(error: unknown): void {
    let errorEl = this.contentEl.querySelector<HTMLElement>(".vault-switcher-error");
    if (!errorEl) {
      errorEl = document.createElement("div");
      errorEl.className = "vault-switcher-error";
      this.contentEl.appendChild(errorEl);
    }
    errorEl.empty();
    if (error instanceof VaultAccessError) {
      const state = vaultAccessPresentation(error);
      const heading = document.createElement("strong");
      heading.textContent = state.title;
      const message = document.createElement("span");
      message.textContent = state.message;
      const reconnect = document.createElement("button");
      reconnect.type = "button";
      reconnect.textContent = state.action;
      reconnect.disabled = this.actionPending;
      reconnect.addEventListener("click", () => void this.runVaultAction(async () => {
          if (!await this.geodeApp.host.vaultRegistry.reconnectVault(state.vaultId)) {
            message.textContent = "Reconnect canceled. The current vault is still open.";
            return;
          }
          await this.openVaultWindow(state.vaultId);
      }));
      errorEl.append(heading, message, reconnect);
      return;
    }
    errorEl.textContent = error instanceof Error ? error.message : "Unable to open that vault";
  }
}

class VaultSwitchBusyError extends Error {
  readonly code = "VAULT_SWITCH_BUSY";

  constructor(target: string | null) {
    super(`A vault switch to ${target ?? "another vault"} is already in progress`);
    this.name = "VaultSwitchBusyError";
  }
}

/** Ids of the built-in settings tabs, as opposed to a plugin id keyed into `App.settingTabs`. */
type BuiltinTabId = "appearance" | "hotkeys" | "daily-notes" | "community-plugins" | "advanced" | "performance";
const BUILTIN_TAB_IDS: BuiltinTabId[] = ["appearance", "hotkeys", "daily-notes", "community-plugins", "advanced", "performance"];

class SettingsModal extends Modal {
  private navEl!: HTMLElement;
  private contentContainerEl!: HTMLElement;
  private activeTabId: string = "appearance";
  private unsubscribeSettingTabs: (() => void) | null = null;
  private unsubscribeHotkeys: (() => void) | null = null;
  private stopHotkeyRecorder: (() => void) | null = null;
  /** Cleanup for the Performance tab's live-metrics polling interval (set while that tab is active). */
  private stopPerformanceTab: (() => void) | null = null;

  constructor(private geodeApp: App) {
    super(geodeApp);
    this.modalEl.classList.add("mod-settings");
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.modalEl.setAttribute("aria-label", "Settings");
    this.modalEl.tabIndex = -1;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-close-button";
    closeButton.setAttribute("aria-label", "Close Settings");
    closeButton.textContent = "Done";
    closeButton.addEventListener("click", () => this.close());
    this.modalEl.prepend(closeButton);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.navEl = document.createElement("div");
    this.navEl.className = "vertical-tab-header";
    this.navEl.setAttribute("role", "tablist");
    this.navEl.setAttribute("aria-label", "Settings categories");
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
    this.unsubscribeHotkeys?.();
    this.unsubscribeHotkeys = null;
    this.stopHotkeyRecorder?.();
    this.stopHotkeyRecorder = null;

    this.activeTabId = id;
    this.renderNav();
    this.contentContainerEl.empty();

    if (id === "appearance") {
      this.renderAppearanceTab(this.contentContainerEl);
    } else if (id === "hotkeys") {
      this.renderHotkeysTab(this.contentContainerEl);
    } else if (id === "daily-notes") {
      this.renderDailyNotesTab(this.contentContainerEl);
    } else if (id === "community-plugins") {
      this.renderCommunityTab(this.contentContainerEl);
    } else if (id === "advanced") {
      this.renderAdvancedTab(this.contentContainerEl);
    } else if (id === "performance") {
      if (!this.geodeApp.host.capabilities.processDiagnostics) {
        this.activateTab("appearance");
        return;
      }
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
      const item = document.createElement("button");
      item.type = "button";
      item.className = "vertical-tab-nav-item";
      item.textContent = label;
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", String(id === this.activeTabId));
      item.classList.toggle("is-active", id === this.activeTabId);
      item.addEventListener("click", () => this.activateTab(id));
      container.appendChild(item);
    };

    addNavItem("appearance", "Appearance", this.navEl);
    addNavItem("hotkeys", "Hotkeys", this.navEl);
    addNavItem("daily-notes", "Daily Notes", this.navEl);
    addNavItem("community-plugins", "Community plugins & themes", this.navEl);
    addNavItem("advanced", "Advanced", this.navEl);
    if (this.geodeApp.host.capabilities.processDiagnostics) {
      addNavItem("performance", "Performance", this.navEl);
    }

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
    this.addToggle(container, "Show ribbon", s.showRibbon, (v) => {
      s.showRibbon = v;
      this.geodeApp.applySettings();
      this.geodeApp.saveSettings();
    });
    this.addToggle(container, "Show status bar", s.showStatusBar, (v) => {
      s.showStatusBar = v;
      this.geodeApp.applySettings();
      this.geodeApp.saveSettings();
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

  private renderHotkeysTab(container: HTMLElement): void {
    container.innerHTML = `<h2>Hotkeys</h2>`;
    const guidance = document.createElement("p");
    guidance.className = "hotkey-guidance";
    guidance.textContent = "Use a physical hardware keyboard to record shortcuts. Touch-only devices can still remove and reset assignments.";
    const controls = document.createElement("div");
    controls.className = "hotkey-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search commands…";
    search.setAttribute("aria-label", "Search hotkeys");
    const assignedLabel = document.createElement("label");
    const assigned = document.createElement("input");
    assigned.type = "checkbox";
    assignedLabel.append(assigned, " Assigned only");
    controls.append(search, assignedLabel);
    const list = document.createElement("div");
    list.className = "hotkey-list";
    container.append(guidance, controls, list);

    const render = () => {
      list.empty();
      const query = search.value.trim().toLowerCase();
      const commands = this.geodeApp.commands.listCommands().sort((a, b) => a.name.localeCompare(b.name));
      for (const command of commands) {
        const bindings = this.geodeApp.commands.bindingsFor(command.id);
        if (assigned.checked && !bindings.length) continue;
        if (query && !`${command.name} ${command.id}`.toLowerCase().includes(query)) continue;
        const row = document.createElement("div");
        row.className = "hotkey-command";
        row.dataset.commandId = command.id;
        row.setAttribute("role", "group");
        row.setAttribute("aria-label", command.name);
        const info = document.createElement("div");
        info.className = "hotkey-command-info";
        const name = document.createElement("div"); name.className = "hotkey-command-name"; name.textContent = command.name;
        const id = document.createElement("div"); id.className = "hotkey-command-id"; id.textContent = command.id;
        info.append(name, id);
        const bindingList = document.createElement("div"); bindingList.className = "hotkey-bindings";
        for (const binding of bindings) {
          const pill = document.createElement("span"); pill.className = "hotkey-pill"; pill.textContent = displayHotkey(binding);
          const owners = this.geodeApp.commands.snapshot().ownersByBinding[bindingIdentity(binding)] ?? [];
          if (owners.length > 1) {
            const conflictingNames = owners
              .filter(owner => owner !== command.id)
              .map(owner => this.geodeApp.commands.findCommand(owner)?.name ?? owner);
            const conflictDescription = `${displayHotkey(binding)} conflicts with ${conflictingNames.join(", ")}`;
            pill.classList.add("is-conflicted");
            pill.title = conflictDescription;
            const indicator = document.createElement("span");
            indicator.className = "hotkey-conflict-indicator";
            indicator.textContent = "Conflict";
            indicator.setAttribute("aria-label", conflictDescription);
            pill.append(indicator);
          }
          const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${displayHotkey(binding)} from ${command.name}`);
          remove.addEventListener("click", () => void this.geodeApp.commands.removeBinding(command.id, binding));
          pill.append(remove); bindingList.append(pill);
        }
        const add = document.createElement("button"); add.type = "button"; add.className = "hotkey-add"; add.textContent = "+"; add.setAttribute("aria-label", `Add hotkey for ${command.name}`);
        add.addEventListener("click", () => this.captureHotkey(command.id, command.name, add, row));
        bindingList.append(add);
        if (this.geodeApp.commands.hasOverride(command.id)) {
          const reset = document.createElement("button"); reset.type = "button"; reset.className = "hotkey-reset"; reset.textContent = "Reset";
          reset.setAttribute("aria-label", `Reset hotkeys for ${command.name}`);
          reset.addEventListener("click", () => void this.geodeApp.commands.resetBindings(command.id)); bindingList.append(reset);
        }
        row.append(info, bindingList); list.append(row);
      }
    };
    search.addEventListener("input", render); assigned.addEventListener("change", render);
    this.unsubscribeHotkeys = this.geodeApp.commands.onChange(render);
    render();
  }

  private renderDailyNotesTab(container: HTMLElement): void {
    const dailyNotes = this.geodeApp.dailyNotes;
    container.innerHTML = `<h2>Daily Notes</h2>`;
    this.addToggle(
      container,
      "Enable Daily Notes",
      dailyNotes.enabled,
      (enabled) => void this.updateDailyNotes({ enabled })
    );
    let folderInput!: HTMLInputElement;
    folderInput = this.addTextInput(
      container,
      "New file location",
      dailyNotes.options.folder,
      (folder) => void this.updateDailyNotes(
        { folder },
        () => { folderInput.value = dailyNotes.options.folder; }
      )
    );
    let formatInput!: HTMLInputElement;
    formatInput = this.addTextInput(
      container,
      "Date format",
      dailyNotes.options.format,
      (format) => void this.updateDailyNotes(
        { format },
        () => { formatInput.value = dailyNotes.options.format; }
      )
    );
    let templateInput!: HTMLInputElement;
    templateInput = this.addTextInput(
      container,
      "Template file location",
      dailyNotes.options.template,
      (template) => void this.updateDailyNotes(
        { template },
        () => { templateInput.value = dailyNotes.options.template; }
      )
    );
  }

  private async updateDailyNotes(
    patch: Partial<{ enabled: boolean; folder: string; format: string; template: string }>,
    synchronizeControl?: () => void
  ): Promise<void> {
    try {
      await this.geodeApp.dailyNotes.update(patch);
      synchronizeControl?.();
    } catch (err) {
      console.error(err);
      this.geodeApp.notify("Could not save Daily Notes settings. Your previous settings are still active.");
      if (synchronizeControl) synchronizeControl();
      else if (this.activeTabId === "daily-notes") this.activateTab("daily-notes");
    }
  }

  private captureHotkey(commandId: string, commandName: string, button: HTMLButtonElement, row: HTMLElement): void {
    this.stopHotkeyRecorder?.();
    button.textContent = "Press keys…";
    button.setAttribute("aria-label", `Recording hotkey for ${commandName}. Press Escape to cancel.`);
    const status = document.createElement("span");
    status.className = "hotkey-recording-status";
    status.setAttribute("role", "status");
    status.textContent = `Recording hotkey for ${commandName}. Press Escape to cancel.`;
    row.append(status);
    let active = true;
    const stop = (announcement?: string) => {
      if (!active) return;
      active = false;
      window.removeEventListener("keydown", listener, true);
      button.textContent = "+";
      button.setAttribute("aria-label", `Add hotkey for ${commandName}`);
      if (announcement) {
        status.textContent = announcement;
        window.setTimeout(() => status.remove(), 1500);
      } else {
        status.remove();
      }
      if (this.stopHotkeyRecorder === stop) this.stopHotkeyRecorder = null;
    };
    const listener = async (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.code === "Escape") { stop("Hotkey recording canceled."); return; }
      const binding = eventToBinding(event);
      if (!binding) return;
      stop();
      if (["Mod+KeyQ", "Mod+KeyW", "Mod+KeyT"].includes(bindingIdentity(binding))) {
        this.geodeApp.notify("This shortcut may be reserved by the operating system or host.");
      }
      const result = await this.geodeApp.commands.assignBinding(commandId, binding);
      if (result.status !== "conflict") return;
      const existing = row.querySelector(".hotkey-conflict-choice"); existing?.remove();
      const choice = document.createElement("div"); choice.className = "hotkey-conflict-choice";
      choice.setAttribute("role", "alert");
      const names = result.owners.map(owner => this.geodeApp.commands.findCommand(owner)?.name ?? owner);
      choice.append(` ${displayHotkey(binding)} is assigned to ${names.join(", ")}. `);
      if (["Mod+KeyQ", "Mod+KeyW", "Mod+KeyT"].includes(bindingIdentity(binding))) {
        const warning = document.createElement("span"); warning.className = "hotkey-reserved-warning"; warning.textContent = " This shortcut may be reserved by the operating system or host."; choice.append(warning);
      }
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => choice.remove());
      const reassign = document.createElement("button"); reassign.type = "button"; reassign.textContent = `Reassign to ${commandName}`;
      reassign.addEventListener("click", async () => { await this.geodeApp.commands.assignBinding(commandId, binding, { reassign: true }); choice.remove(); });
      choice.append(cancel, reassign); row.append(choice);
    };
    this.stopHotkeyRecorder = stop;
    window.addEventListener("keydown", listener, true);
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
    cookieBtn.disabled = !this.geodeApp.host.capabilities.chromeCookieImport;
    cookieBtn.title = cookieBtn.disabled ? "Chrome cookie import is available on desktop only" : "";
    cookieBtn.addEventListener("click", () => new ChromeCookieImportModal(this.geodeApp).open());
    cookieControl.appendChild(cookieBtn);

    const communityHeading = document.createElement("h2");
    communityHeading.textContent = "Community plugins & themes";
    container.appendChild(communityHeading);
    if (!this.geodeApp.host.capabilities.nodePlugins) {
      const unavailable = document.createElement("p");
      unavailable.className = "community-mobile-unavailable";
      unavailable.textContent = "Installed vault plugins can run when admitted as mobile compatible. GitHub installation and native request/secret services arrive in Slice 3A2.";
      container.appendChild(unavailable);
    }
    const { control } = this.addRow(container, "Install from GitHub");
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add…";
    addBtn.disabled = !this.geodeApp.host.capabilities.nodePlugins;
    addBtn.title = addBtn.disabled ? "Community installation is available on desktop only" : "";
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
      const disable = document.createElement("button");
      disable.textContent = "Disable plugin";
      disable.addEventListener("click", async () => {
        disable.disabled = true;
        await this.geodeApp.pluginManager.disableQuarantined(pluginId);
        await this.renderCommunityList(listEl);
      });
      row.append(info, restore, disable);
      listEl.appendChild(row);
    }
    if (this.geodeApp.pluginManager.isMobileRuntime()) {
      for (const manifest of this.geodeApp.pluginManager.listManifests()) {
        listEl.appendChild(this.renderMobilePluginRow(manifest, listEl));
      }
    }
    if (!cfg.items.length && !Object.keys(quarantined).length) {
      if (this.geodeApp.pluginManager.isMobileRuntime() && this.geodeApp.pluginManager.listManifests().length) return;
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

  private renderMobilePluginRow(
    manifest: import("./plugin-manifest").PluginManifest,
    listEl: HTMLElement,
  ): HTMLElement {
    const manager = this.geodeApp.pluginManager;
    const admission = manager.getMobileAdmission(manifest.id)!;
    const row = document.createElement("div");
    row.className = "community-item mobile-plugin-item";
    row.dataset.pluginId = manifest.id;
    const info = document.createElement("div");
    info.className = "community-item-info";
    const title = document.createElement("div");
    title.className = "community-item-title";
    title.textContent = manifest.name;
    const badge = document.createElement("span");
    badge.className = `community-item-badge mobile-plugin-${admission.compatibility}`;
    badge.textContent = admission.label;
    title.appendChild(badge);
    const reason = document.createElement("div");
    reason.className = "community-item-sub";
    reason.textContent = admission.reason;
    info.append(title, reason);
    const controls = document.createElement("div");
    controls.className = "community-item-controls";
    if (admission.compatibility === "unknown" && !admission.allowed) {
      const optIn = document.createElement("button");
      optIn.textContent = "Allow on mobile";
      optIn.addEventListener("click", async () => {
        optIn.disabled = true;
        await manager.setMobileOptIn(manifest.id, true);
        await this.renderCommunityList(listEl);
      });
      controls.appendChild(optIn);
    } else if (admission.allowed) {
      const toggle = document.createElement("button");
      toggle.textContent = manager.isEnabled(manifest.id) ? "Disable" : "Enable";
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          if (manager.isEnabled(manifest.id)) await manager.disable(manifest.id);
          else await manager.enable(manifest.id);
        } catch (error) {
          this.geodeApp.notify((error as Error).message);
        }
        await this.renderCommunityList(listEl);
      });
      controls.appendChild(toggle);
    }
    const loadError = manager.getLoadError(manifest.id);
    if (loadError) {
      const diagnostic = document.createElement("div");
      diagnostic.className = "community-plugin-diagnostic";
      diagnostic.setAttribute("role", "alert");
      diagnostic.textContent = loadError;
      info.appendChild(diagnostic);
    }
    row.append(info, controls);
    return row;
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
    input.setAttribute("aria-label", label);
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
    select.setAttribute("aria-label", label);
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

  private addTextInput(container: HTMLElement, label: string, value: string, onChange: (v: string) => void): HTMLInputElement {
    const { control } = this.addRow(container, label);
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", label);
    input.className = "web-view-address";
    input.value = value;
    input.spellcheck = false;
    input.addEventListener("change", () => onChange(input.value.trim()));
    control.appendChild(input);
    return input;
  }

  /**
   * A validated, clamped integer input: out-of-range or non-numeric entry is
   * snapped back to the nearest valid value (visibly, in the field) before
   * `onChange` fires, so the caller never has to re-validate.
   */
  private addNumberInput(
    container: HTMLElement,
    label: string,
    description: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void
  ) {
    const { control } = this.addRow(container, label, description);
    const input = document.createElement("input");
    input.type = "number";
    input.setAttribute("aria-label", label);
    input.className = "setting-number-input";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(value);
    input.addEventListener("change", () => {
      const parsed = Number(input.value);
      const clamped = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
      input.value = String(clamped);
      onChange(clamped);
    });
    control.appendChild(input);
  }

  private renderAdvancedTab(container: HTMLElement): void {
    const s = this.geodeApp.settings;
    container.innerHTML = `<h2>Advanced</h2>`;
    // Stored/threaded in bytes (see AppSettings.metadataScanCapBytes and
    // resolveMetadataScanCapBytes); shown here in KB (1 KB = 1000 bytes) as a
    // friendlier unit for a "how big is too big" judgment call.
    const bytesPerKb = 1000;
    this.addNumberInput(
      container,
      "Metadata scan size limit (KB)",
      "Notes larger than this, after frontmatter, skip in-app heading, tag, link, and list-item " +
        "indexing to protect against high memory use in vaults with very large notes (e.g. long " +
        "pasted transcripts or logs). Frontmatter and frontmatter-derived tags are never affected. " +
        "Applies to notes (re)indexed after this change — already-open vaults pick it up fully the " +
        "next time this vault is opened.",
      Math.round(s.metadataScanCapBytes / bytesPerKb),
      Math.ceil(MIN_METADATA_SCAN_CAP_BYTES / bytesPerKb),
      Math.floor(MAX_METADATA_SCAN_CAP_BYTES / bytesPerKb),
      (kb) => {
        s.metadataScanCapBytes = resolveMetadataScanCapBytes(kb * bytesPerKb);
        this.geodeApp.metadataCache.setScanCapBytes(s.metadataScanCapBytes);
        this.geodeApp.saveSettings();
      }
    );
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
    this.unsubscribeHotkeys?.();
    this.unsubscribeHotkeys = null;
    this.stopHotkeyRecorder?.();
    this.stopHotkeyRecorder = null;
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
    this.backlinksEl.className = "status-bar-item mod-core";
    this.wordCountEl = document.createElement("span");
    this.wordCountEl.className = "status-bar-item mod-core";
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
  private protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  private pendingProtocolLinks = new Map<string, Record<string, string>[]>();
  readonly host: HostServices;
  readonly dailyNotes: DailyNotesService;
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager = new FileManager(this);
  commands: CommandRegistry;
  /** Internal Geode actions. Kept separate from the public Obsidian-compatible CommandRegistry. */
  actions = new ActionRegistry<AppActionContext>();
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
  /**
   * Mermaid diagram rendering, shipped as an internal plugin so it goes
   * through the same public `registerMarkdownCodeBlockProcessor` API a
   * community plugin would. Created per vault open (see openVaultMeasured).
   */
  private mermaidPlugin?: MermaidPlugin;
  themeManager = new ThemeManager(this);
  communityManager = new CommunityManager(this);
  settings: AppSettings = {
    theme: "dark",
    readableLineLength: true,
    showRibbon: true,
    showStatusBar: true,
    cssTheme: "",
    webViewer: { ...DEFAULT_WEB_VIEWER_SETTINGS },
    metadataScanCapBytes: DEFAULT_METADATA_SCAN_CAP_BYTES,
  };
  /** Live plugin-facing options alias retained for compatibility with existing callers. */
  get dailyNoteSettings(): DailyNoteSettings { return this.dailyNotes.options; }
  /** In-memory Bookmarks core plugin model (defaults until a vault is opened), backed by ".geode/bookmarks.json". */
  bookmarksRoot: BookmarksRoot = createEmptyRoot();
  /** True while restoring a saved layout, to suppress re-saving the in-progress state. */
  private restoringLayout = false;
  private saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;
  private communityUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private hostDisposers = new Set<() => void>();
  private vaultSwitchInFlight: Promise<void> | null = null;
  private vaultSwitchTarget: string | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileGeneration = 0;
  private suppressReconcileModify = new Set<string>();
  private externalModifyInFlight = new Map<string, Promise<void>>();

  constructor(host: HostServices = getHostServices()) {
    this.host = host;
    this.dailyNotes = new DailyNotesService(host.config);
    this.commands = new CommandRegistry(host.config, () => {
      const source = this.guestHotkeySource;
      const leaf = source !== null ? this.leafOwningGuest(source) : this.workspace?.activeLeaf;
      const view = leaf?.view;
      if (!(view instanceof MarkdownView) || view.mode === "reading" || !view.editor) return null;
      return { editor: view.editor, context: view };
    });
    this.vault = new Vault(host);
    this.metadataCache = new MetadataCache(this.vault);
  }

  isDarkMode(): boolean {
    return document.body.classList.contains("theme-dark");
  }

  private localStorageKey(key: string): string {
    return `geode:vault:${encodeURIComponent(this.vault.root)}:${encodeURIComponent(key)}`;
  }

  loadLocalStorage(key: string): any | null {
    const stored = localStorage.getItem(this.localStorageKey(key));
    if (stored === null) return null;
    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }

  saveLocalStorage(key: string, data: unknown | null): void {
    const storageKey = this.localStorageKey(key);
    if (data === null) {
      localStorage.removeItem(storageKey);
      return;
    }
    const serialized = JSON.stringify(data);
    if (serialized === undefined) throw new TypeError("App local storage data must be JSON-serializable");
    localStorage.setItem(storageKey, serialized);
  }

  registerProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.protocolHandlers.set(action, handler);
    for (const params of this.pendingProtocolLinks.get(action) ?? []) void handler(params);
    this.pendingProtocolLinks.delete(action);
  }

  unregisterProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    if (this.protocolHandlers.get(action) === handler) this.protocolHandlers.delete(action);
  }

  private dispatchProtocolLink(action: string, params: Record<string, string>): void {
    const handler = this.protocolHandlers.get(action);
    if (handler) void handler(params);
    else this.pendingProtocolLinks.set(action, [...(this.pendingProtocolLinks.get(action) ?? []), params]);
  }

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

  private openManageVaults(): void {
    new ManageVaultsModal(this).open();
  }

  switchVaultInWindow(vaultId: string): Promise<void> {
    if (this.vaultSwitchInFlight) {
      if (this.vaultSwitchTarget === vaultId) return this.vaultSwitchInFlight;
      return Promise.reject(new VaultSwitchBusyError(this.vaultSwitchTarget));
    }
    if (vaultId === this.vault.root) return Promise.resolve();
    this.vaultSwitchTarget = vaultId;
    const operation = this.performVaultSwitch(vaultId);
    const tracked = operation.finally(() => {
      if (this.vaultSwitchInFlight === tracked) {
        this.vaultSwitchInFlight = null;
        this.vaultSwitchTarget = null;
      }
    });
    this.vaultSwitchInFlight = tracked;
    return tracked;
  }

  private async performVaultSwitch(vaultId: string): Promise<void> {
    const oldVaultId = this.vault.root;
    const activeReconcile = this.reconcileInFlight;
    if (activeReconcile) await activeReconcile;
    await this.host.vaultRegistry.checkVault(vaultId);
    await this.workspace.prepareVaultSwitch();
    try {
      await this.disposeVaultSession();
    } catch (error) {
      this.workspace.cancelVaultSwitch();
      throw error;
    }
    try {
      await this.host.vaultRegistry.openVault(vaultId);
    } catch (error) {
      await this.host.vaultRegistry.openVault(oldVaultId);
      location.reload();
      throw error;
    }
    location.reload();
  }

  /** Mount the exact action element created by Plugin.addRibbonIcon(). */
  addRibbonIcon(el: HTMLElement): void {
    this.ribbonActionsEl.appendChild(el);
  }

  /** Mount the exact element created by Plugin.addStatusBarItem(). */
  addStatusBarItem(el: HTMLElement): void {
    this.statusBar.containerEl.appendChild(el);
  }

  async start() {
    return measureOperation("startup-total", async () => {
      // Run first, before any vault is open or `pluginManager` exists, so
      // `app.plugins`/`app.internalPlugins`/`app.secretStorage`/etc. are
      // populated app-wide from the first tick — not just for plugins that
      // happen to construct `obsidian.Plugin` (whose constructor also calls
      // this, guarded, as a redundant safety net for `plugin-manager.test.ts`'s
      // fake apps). A plugin built on the bare `GeodePlugin` base, or any
      // code reading `app.plugins` at module-eval time, would otherwise see
      // an undefined/empty registry if this only ran from that constructor.
      installObsidianAppCompat(this);
      const updateWindowChrome = (state: Awaited<ReturnType<HostServices["runtime"]["getWindowChromeState"]>>) =>
        applyWindowChromeState(document.body.classList, state);
      this.hostDisposers.add(this.host.runtime.onWindowChromeState(updateWindowChrome));
      updateWindowChrome(await this.host.runtime.getWindowChromeState());
      this.hostDisposers.add(this.host.runtime.onDeepLink(({ action, params }) => this.dispatchProtocolLink(action, params)));
      this.installExternalLinkInterceptor();
      initTooltips();
      const rootEl = document.getElementById("app")!;
      const [launchTarget, recents] = await measureOperation("startup-recent-vaults", () => Promise.all([
        this.host.vaultRegistry.getLaunchVault(),
        this.host.vaultRegistry.getRecentVaults(),
      ]));
      if (launchTarget || recents.length) {
        await this.openVault(launchTarget ?? recents[0], rootEl);
      } else {
        this.showVaultPicker(rootEl, []);
      }
    });
  }

  private showVaultPicker(rootEl: HTMLElement, recents: string[]) {
    this.workspace?.dispose();
    rootEl.innerHTML = "";
    const picker = document.createElement("div");
    picker.className = "vault-picker";
    picker.innerHTML = `<h1>Geode</h1><p>Your knowledge base, on local Markdown files.</p>`;
    if (this.host.runtime.runtime === "ios") {
      for (const action of mobileVaultActions(this.host.capabilities.externalVaultFolder)) {
        const button = document.createElement("button");
        button.className = action.id === "managed" ? "mod-cta" : "vault-picker-external";
        button.textContent = action.label;
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const id = action.id === "managed"
              ? await this.host.vaultRegistry.chooseVault()
              : await this.host.vaultRegistry.chooseExternalVault();
            if (id) await this.openVault(id, rootEl);
          } catch (error) {
            this.showInlineVaultError(picker, error);
          } finally {
            button.disabled = false;
          }
        });
        picker.appendChild(button);
      }
    } else {
      const openBtn = document.createElement("button");
      openBtn.className = "mod-cta";
      openBtn.textContent = "Open folder as vault";
      openBtn.addEventListener("click", async () => {
        openBtn.disabled = true;
        try {
          const path = await this.host.vaultRegistry.chooseVault();
          if (path) await this.openVault(path, rootEl);
        } catch (error) {
          this.showInlineVaultError(picker, error);
        } finally {
          openBtn.disabled = false;
        }
      });
      picker.appendChild(openBtn);
    }
    if (recents.length) {
      const h = document.createElement("h3");
      h.textContent = "Recent vaults";
      picker.appendChild(h);
      for (const path of recents) {
        const row = document.createElement("div");
        row.className = "vault-picker-recent";
        row.textContent = path;
        void this.host.vaultRegistry.describeVault(path).then(
          (descriptor) => { row.textContent = descriptor.name; },
          () => { row.textContent = "Unavailable vault"; },
        );
        row.addEventListener("click", () => this.openVault(path, rootEl));
        picker.appendChild(row);
      }
    }
    rootEl.appendChild(picker);
  }

  private async openVault(path: string, rootEl: HTMLElement) {
    return measureOperation("startup-open-vault", () => this.openVaultMeasured(path, rootEl));
  }

  private async openVaultMeasured(path: string, rootEl: HTMLElement) {
    try {
      await this.vault.open(path);
    } catch (err) {
      console.error(err);
      if (err instanceof VaultAccessError) {
        this.showVaultAccessError(rootEl, err);
        return;
      }
      const recents = await this.host.vaultRegistry.getRecentVaults();
      this.showVaultPicker(rootEl, recents);
      return;
    }
    const saved = (await this.host.config.read("app")) as Partial<AppSettings> | null;
    await this.commands.loadHotkeys();
    if (saved) {
      this.settings = {
        ...this.settings,
        ...saved,
        webViewer: { ...this.settings.webViewer, ...saved.webViewer },
        // Always re-resolved (never trusted verbatim) — a hand-edited or
        // stale config could carry 0/negative/non-numeric/huge values, and
        // this is the one place raw disk content becomes a validated setting.
        metadataScanCapBytes: resolveMetadataScanCapBytes(saved.metadataScanCapBytes),
      };
    }
    // This vault's resolved cap must be in place before metadataCache.initialize()
    // runs below (see setScanCapBytes's doc comment) — set it immediately after
    // the settings merge rather than deferring to when the Advanced tab renders.
    this.metadataCache.setScanCapBytes(this.settings.metadataScanCapBytes);

    // Loaded before pluginManager.initialize() so the internalPlugins compat
    // shim (installObsidianAppCompat in api/obsidian.ts) has settings ready
    // before any hosted plugin (e.g. Calendar) can query "daily-notes".
    await this.dailyNotes.load();

    // Same shape as daily-notes above: read the persisted Bookmarks tree
    // before registerCommands()/pluginManager.initialize() so both see the
    // real in-memory model rather than the empty-root default.
    const savedBookmarks = await this.host.config.read("bookmarks");
    this.bookmarksRoot = normalizeBookmarksRoot(savedBookmarks);

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
    const createCanvasButton = document.createElement("button");
    createCanvasButton.type = "button";
    createCanvasButton.className = "side-dock-ribbon-action";
    createCanvasButton.title = "Create new canvas";
    createCanvasButton.setAttribute("aria-label", "Create new canvas");
    setIcon(createCanvasButton, "layout-dashboard");
    createCanvasButton.addEventListener("click", () => {
      const activeFile = this.workspace.getActiveFile();
      void this.createNewCanvas(activeFile?.parent ?? "");
    });
    this.ribbonActionsEl.appendChild(createCanvasButton);
    const ribbonBottom = document.createElement("div");
    ribbonBottom.className = "workspace-ribbon-bottom";
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "side-dock-ribbon-action";
    settingsButton.title = "Open settings";
    settingsButton.setAttribute("aria-label", "Open settings");
    setIcon(settingsButton, "settings");
    settingsButton.addEventListener("click", () => this.setting.open());
    const manageVaultsButton = document.createElement("button");
    manageVaultsButton.type = "button";
    manageVaultsButton.className = "side-dock-ribbon-action";
    manageVaultsButton.title = "Manage vaults";
    manageVaultsButton.setAttribute("aria-label", "Manage vaults");
    setIcon(manageVaultsButton, "vault");
    manageVaultsButton.addEventListener("click", () => this.openManageVaults());
    ribbonBottom.append(manageVaultsButton, settingsButton);
    ribbon.append(this.ribbonActionsEl, ribbonBottom);
    main.appendChild(ribbon);

    this.workspace = new Workspace(this, main);
    this.statusBar = new StatusBar(this, shell);
    const mobileNavigation = this.createMobileNavigation();
    mobileNavigation.inert = true;
    mobileNavigation.setAttribute("aria-busy", "true");
    shell.appendChild(mobileNavigation);
    this.trackMobileVisualViewport();

    // Sidebar views
    this.workspace.leftSidebar.addView(new FileExplorerView(this));
    this.workspace.leftSidebar.addView(new SearchView(this));
    this.workspace.rightSidebar.addView(new BacklinksView(this));
    this.workspace.rightSidebar.addView(new OutlineView(this));
    this.workspace.rightSidebar.addView(new TagPaneView(this));

    // Bookmarks is a real plugin-facing ItemView (unlike the other built-ins
    // above, which draw their own .sidebar-view-header) so it needs a
    // WorkspaceLeaf before it can be constructed. leftSidebar.addView(view)
    // builds that leaf itself internally *after* the view already exists,
    // so it can't be used here; leftSidebar.addLeaf() + leaf.setView(view)
    // gets the leaf first, matching what ItemView's constructor needs.
    //
    // Imported dynamically (not at the top of this file) to break an
    // init-time module cycle: api/obsidian.ts re-exports `App` from this
    // module, so importing the plugin shim eagerly evaluates app.ts; a static
    // `import { BookmarksView }` here would pull views/bookmarks-view.ts —
    // whose `class BookmarksView extends ItemView` needs ItemView — back into
    // that eval before api/obsidian.ts has defined ItemView (leaving it
    // `undefined`). Deferring the import to boot lets ItemView exist first.
    const { BookmarksView } = await import("./views/bookmarks-view");
    // Bypassing `addView` also bypasses the built-in registration it performs,
    // so do it explicitly — otherwise a persisted "bookmarks" leaf would be
    // restored as a deferred placeholder *next to* the real one.
    this.workspace.registerBuiltinViewType("bookmarks");
    const bookmarksLeaf = this.workspace.leftSidebar.addLeaf();
    await bookmarksLeaf.setView(new BookmarksView(bookmarksLeaf));

    // Obsidian Web Viewer compat: viewType "webviewer" + { url } state, so
    // any hosted plugin targeting that view type (e.g. Threads'
    // obsidian_open_url) opens a tab here too. Must be registered before
    // restoreWorkspaceLayout() below, which resolves saved leaves by type.
    if (this.host.capabilities.embeddedWebContent) {
      this.workspace.registerViewFactory("webviewer", (leaf) => new WebView(this, leaf));
    }
    if (this.host.capabilities.artifacts) {
      this.workspace.registerViewFactory("geode-artifact", (leaf) => new ArtifactView(this, leaf));
    }

    // Graph and Bases tabs are normally constructed directly (`openGraphView`,
    // `openFile` for `.base`), but restore resolves every saved leaf through
    // the factory map — without these two, an open Graph or Bases tab was
    // silently dropped on relaunch. `BaseView.getState()/setState()` carry the
    // `.base` file path across the restart; `GraphView` is stateless.
    this.workspace.registerViewFactory("graph", () => new GraphView(this));
    this.workspace.registerViewFactory("base", () => new BaseView(this));

    // Internal plugins: features Geode ships that go through the *public*
    // plugin API rather than being hardcoded into the renderer. Mermaid is
    // the first, registering a ```mermaid code-block processor exactly as a
    // community plugin would. Geode has no core-plugin registry yet, so this
    // is a direct instantiation; a registry would slot in here.
    // Reopening a vault re-runs this method, so drop the previous instance's
    // registrations rather than leaking them.
    this.mermaidPlugin?.unload();
    this.mermaidPlugin = new MermaidPlugin(this);
    this.mermaidPlugin.load();

    this.registerActions();
    this.registerCommands();
    this.hostDisposers.add(this.commands.attach(document));
    this.attachGuestHotkeyBridge();
    this.applySettings();
    // Apply the selected community theme (if the vault has it installed).
    this.themeManager.apply(this.settings.cssTheme);

    this.pluginManager = new PluginManager(this);
    await measureOperation("startup-plugins", () => this.pluginManager.initialize());
    if (this.pluginManager.isRecoveryMode()) this.showCrashRecoveryBanner(shell);

    // Restore the saved workspace layout (tabs + docked plugin panes) now
    // that plugin view factories are registered; fall back to an empty tab.
    await measureOperation("startup-layout-restore", () => this.restoreWorkspaceLayout());

    // Any leaf still holding a placeholder must be hydrated BEFORE
    // flushLayoutReady() below. The standard plugin idiom is
    // `if (getLeavesOfType(VIEW).length) return;` — a DeferredView satisfies
    // that check, so a plugin whose onLayoutReady runs while its pane is still
    // deferred would skip opening its view and leave a dead placeholder for
    // the whole session. registerViewFactory also hydrates fire-and-forget,
    // but only this awaited pass guarantees the ordering.
    await measureOperation("startup-deferred-hydrate", () =>
      this.workspace.hydrateDeferredLeaves()
    );

    // Subscribe to layout changes BEFORE firing onLayoutReady, so that the
    // initial layout — including panes a plugin opens in its onLayoutReady
    // callback — is captured by the debounced save (restore itself is guarded
    // by restoringLayout, so nothing saves mid-restore).
    const scheduleSave = () => this.scheduleSaveLayout();
    this.workspace.on("layout-change", scheduleSave);
    this.workspace.on("active-leaf-change", scheduleSave);
    this.workspace.on("file-open", scheduleSave);

    // Hydrate metadata from the persisted warm cache before layout-ready, but
    // never wait for the utility process's full vault reconciliation. On slow
    // or endpoint-protected filesystems that can take minutes. The utility's
    // authoritative result is merged incrementally after startup and emits a
    // later `resolved` event. Warm starts retain Obsidian-style metadata
    // availability for plugin onLayoutReady callbacks; cold starts are
    // progressively populated instead of holding the entire workspace hostage.
    await measureOperation("startup-metadata-warm", () => this.metadataCache.initialize());

    // Now that the layout is in place and warm metadata is available, fire plugins'
    // onLayoutReady callbacks — a plugin that opens its own view will find and
    // reuse the restored pane (via getLeavesOfType) instead of creating a
    // duplicate.
    measureOperation("startup-layout-ready", () => this.workspace.flushLayoutReady());

    // Persist the initial layout (restored + any onLayoutReady-opened panes).
    this.scheduleSaveLayout();

    // The shell renders before asynchronous layout/plugin startup finishes.
    // Keep primary mobile actions out of the hit-test/accessibility tree until
    // their target leaves exist, then place non-editing focus in the web view
    // so the first physical tap is an activation rather than a focus-only tap.
    mobileNavigation.inert = false;
    mobileNavigation.removeAttribute("aria-busy");
    if (document.body.classList.contains("is-mobile")) {
      mobileNavigation.querySelector<HTMLButtonElement>('[aria-label="Files"]')?.focus({ preventScroll: true });
    }

    // Check opt-in community items for updates shortly after startup, off the
    // critical path. No-op unless a tracked item has auto-update enabled.
    this.communityUpdateTimer = setTimeout(() => {
      this.communityUpdateTimer = null;
      void this.checkCommunityUpdates(false);
    }, 2500);

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
    this.vault.on("modify", (file: TFile) => {
      if (this.suppressReconcileModify.delete(file.path)) return;
      void this.handleExternalModify(file);
    });
    this.hostDisposers.add(this.host.runtime.onForeground(() => void this.reconcileVault("foreground")));
    await this.restoreConflictRecovery();
    if (this.vault.needsInitialReconcile()) await this.reconcileVault("foreground");
  }

  private async restoreConflictRecovery(): Promise<void> {
    const prefix = `geode:conflict-recovery:${encodeURIComponent(this.vault.root)}:`;
    for (const key of Object.keys(localStorage).filter((candidate) => candidate.startsWith(prefix))) {
      try {
        const recovery = JSON.parse(localStorage.getItem(key) ?? "null") as { path?: string; text?: string } | null;
        if (!recovery?.path || typeof recovery.text !== "string") continue;
        let leaf = this.workspace.findLeafForFile(recovery.path);
        if (!leaf) {
          const file = this.vault.getFileByPath(recovery.path);
          if (!file) continue;
          await this.openFile(file, false);
          leaf = this.workspace.findLeafForFile(recovery.path);
        }
        const view = leaf?.view;
        if (!(view instanceof MarkdownView)) continue;
        let externalText: string | null = null;
        try { externalText = await this.host.vaultFiles.read(recovery.path); } catch { /* provider deletion remains explicit */ }
        view.restoreConflictRecovery(recovery.text, externalText);
      } catch {
        // Malformed derived recovery records are ignored without touching provider bytes.
      }
    }
  }

  async reconcileVault(_reason: "foreground" | "manual"): Promise<void> {
    if (this.vaultSwitchInFlight) {
      await this.vaultSwitchInFlight;
      return;
    }
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const generation = this.reconcileGeneration;
    const operation = this.performReconcile(generation);
    const tracked = operation.finally(() => {
      if (this.reconcileInFlight === tracked) this.reconcileInFlight = null;
    });
    this.reconcileInFlight = tracked;
    return tracked;
  }

  private async performReconcile(generation: number): Promise<void> {
    let didPause = false;
    let holdViewsForRetry = false;
    const preparedConflictPresentations: Array<() => void> = [];
    try {
      await this.workspace.pauseAutosave();
      didPause = true;
      const result = await this.vault.reconcile();
      if (result.status !== "complete") {
        this.showReconcileState(result.status, result.errorCode);
        return;
      }
      if (!result.manifest || generation !== this.reconcileGeneration) return;
      const publish: Array<() => void> = [];
      for (let index = 0; index < result.changes.length; index += 1) {
        const change = result.changes[index];
        if (change.event === "modify") {
          const file = this.vault.getFileByPath(change.path);
          const view = file ? this.workspace.findLeafForFile(file.path)?.view : null;
          let baseSource: { view: BaseView; file: TFile; text: string } | null = null;
          for (const leaf of this.workspace.getLeavesOfType("base")) {
            if (!(leaf.view instanceof BaseView)) continue;
            const source = await leaf.view.getDirtySourceConflict(change.path);
            if (source) {
              baseSource = { view: leaf.view, ...source };
              break;
            }
          }
          const textBackedView = view instanceof MarkdownView || view instanceof BaseView || view instanceof CanvasView;
          const externalText = textBackedView || baseSource ? await this.host.vaultFiles.read(change.path) : undefined;
          if (baseSource && externalText !== undefined) {
            const conflictPath = buildConflictPath(
              change.path,
              formatConflictTimestamp(new Date()),
              (path) => this.vault.getAbstractFileByPath(path) !== null,
            );
            try {
              await this.vault.create(conflictPath, baseSource.text);
              const present = () => baseSource!.view.presentSourceConflict(conflictPath);
              preparedConflictPresentations.push(present);
              publish.push(present);
            } catch (writeError) {
              baseSource.view.presentSourceConflict(null, true);
              const recoveryKey = `geode:conflict-recovery:${encodeURIComponent(this.vault.root)}:${encodeURIComponent(baseSource.file.path)}`;
              try {
                localStorage.setItem(recoveryKey, JSON.stringify({ vaultId: this.vault.root, path: baseSource.file.path, text: baseSource.text }));
              } catch {
                // The live read-only edit remains the last recovery tier.
              }
              throw writeError;
            }
          }
          if (file && (view instanceof MarkdownView || view instanceof CanvasView) && view.file && externalText !== undefined &&
            hasExternalChange(externalText, view.getLastKnownText())) {
            if (view.hasUnacknowledgedChanges()) {
              const present = await this.prepareConflict(view, file, externalText, file.path);
              preparedConflictPresentations.push(present);
              publish.push(present);
            } else {
              publish.push(() => view.acceptExternalText(externalText));
            }
          } else if (view instanceof BaseView && externalText !== undefined) {
            try {
              await view.acceptExternalText(externalText);
            } catch (error) {
              holdViewsForRetry = true;
              throw error;
            }
          }
          publish.push(() => {
            this.suppressReconcileModify.add(change.path);
            this.vault.applyReconcileChange(change, externalText);
          });
        } else if (change.event === "delete" || change.event === "delete-folder") {
          const prepared = await this.prepareExternalDelete(change.path, change.event === "delete-folder");
          preparedConflictPresentations.push(...prepared.conflicts);
          publish.push(...prepared.conflicts);
          publish.push(() => {
            this.vault.applyReconcileChange(change);
            for (const leaf of prepared.cleanLeaves) void leaf.detach().catch(() => {});
          });
        } else {
          publish.push(() => this.vault.applyReconcileChange(change));
        }
        if (index > 0 && index % 100 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      if (generation !== this.reconcileGeneration) return;
      await this.vault.commitReconcileManifest(result.manifest);
      this.clearReconcileState();
      for (const apply of publish) {
        try { apply(); } catch { /* Durable decisions must not be rolled back by view rendering. */ }
      }
    } catch (error) {
      for (const present of preparedConflictPresentations) {
        try { present(); } catch { /* Preserve the remaining local editor state below. */ }
      }
      this.showReconcileState("unavailable", error instanceof Error ? error.message : undefined);
    } finally {
      if (didPause && !holdViewsForRetry) this.workspace.resumeAutosave();
    }
  }

  private handleExternalModify(file: TFile, suppliedText?: string): Promise<void> {
    const existing = this.externalModifyInFlight.get(file.path);
    if (existing) return existing;
    const operation = this.processExternalModify(file, suppliedText).finally(() => {
      if (this.externalModifyInFlight.get(file.path) === operation) this.externalModifyInFlight.delete(file.path);
    });
    this.externalModifyInFlight.set(file.path, operation);
    return operation;
  }

  private async processExternalModify(file: TFile, suppliedText?: string): Promise<void> {
    const leaf = this.workspace.findLeafForFile(file.path);
    const view = leaf?.view;
    if (!(view instanceof MarkdownView) || !view.file) return;
    const text = suppliedText ?? await this.host.vaultFiles.read(file.path);
    if (!hasExternalChange(text, view.getLastKnownText())) return;
    if (!view.hasUnacknowledgedChanges()) {
      view.acceptExternalText(text);
      return;
    }
    await this.preserveConflict(view, file, text, file.path);
  }

  private async preserveConflict(
    view: MarkdownView,
    file: TFile,
    externalText: string | null,
    candidatePath: string,
  ): Promise<void> {
    const present = await this.prepareConflict(view, file, externalText, candidatePath);
    present();
  }

  private async prepareConflict(
    view: MarkdownView | CanvasView,
    file: TFile,
    externalText: string | null,
    candidatePath: string,
  ): Promise<() => void> {
    const localText = view.getText();
    const conflictPath = buildConflictPath(
      candidatePath,
      formatConflictTimestamp(new Date()),
      (path) => this.vault.getAbstractFileByPath(path) !== null,
    );
    try {
      await this.vault.create(conflictPath, localText);
      return () => view.presentConflict(externalText, conflictPath, false);
    } catch (writeError) {
      const recoveryKey = `geode:conflict-recovery:${encodeURIComponent(this.vault.root)}:${encodeURIComponent(file.path)}`;
      view.presentConflict(externalText, null, true, "memory");
      try {
        localStorage.setItem(recoveryKey, JSON.stringify({ vaultId: this.vault.root, path: file.path, text: localText }));
        view.presentConflict(externalText, null, true, "device");
      } catch (storageError) {
        throw new AggregateError([writeError, storageError], "Conflict copy and device recovery both failed");
      }
      throw writeError;
    }
  }

  private async prepareExternalDelete(path: string, folder: boolean): Promise<{
    cleanLeaves: WorkspaceLeaf[];
    conflicts: Array<() => void>;
  }> {
    const cleanLeaves: WorkspaceLeaf[] = [];
    const work: Array<Promise<() => void>> = [];
    this.workspace.iterateLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof BaseView) {
        if (view.file && (view.file.path === path || (folder && view.file.path.startsWith(`${path}/`)))) {
          cleanLeaves.push(leaf);
        }
        work.push((async () => {
          const source = await view.getDirtySourceConflict(path, folder);
          if (!source) return () => {};
          const candidatePath = folder ? source.file.name : source.file.path;
          const conflictPath = buildConflictPath(
            candidatePath,
            formatConflictTimestamp(new Date()),
            (candidate) => this.vault.getAbstractFileByPath(candidate) !== null,
          );
          try {
            await this.vault.create(conflictPath, source.text);
            return () => view.presentSourceConflict(conflictPath);
          } catch (writeError) {
            view.presentSourceConflict(null, true);
            const recoveryKey = `geode:conflict-recovery:${encodeURIComponent(this.vault.root)}:${encodeURIComponent(source.file.path)}`;
            try {
              localStorage.setItem(recoveryKey, JSON.stringify({ vaultId: this.vault.root, path: source.file.path, text: source.text }));
            } catch {
              // The live read-only Base edit remains the last recovery tier.
            }
            throw writeError;
          }
        })());
        return;
      }
      if (!(view instanceof MarkdownView || view instanceof CanvasView) || !view.file) return;
      if (view.file.path !== path && !(folder && view.file.path.startsWith(`${path}/`))) return;
      if (!view.hasUnacknowledgedChanges()) {
        cleanLeaves.push(leaf);
        return;
      }
      const candidate = folder ? view.file.name : view.file.path;
      work.push(this.prepareConflict(view, view.file, null, candidate));
    });
    return { cleanLeaves, conflicts: await Promise.all(work) };
  }

  private showReconcileState(status: string, detail?: string): void {
    let state = document.querySelector<HTMLElement>(".vault-reconcile-state");
    if (!state) {
      state = document.createElement("div");
      state.className = "vault-reconcile-state";
      state.setAttribute("role", "status");
      document.querySelector(".app-shell")?.prepend(state);
    }
    state.empty();
    const message = document.createElement("span");
    if (status === "partial" || status === "cancelled") {
      message.textContent = "Vault refresh was incomplete. The previous file manifest is still active.";
    } else if (detail === "CONTENT_UNAVAILABLE") {
      message.textContent = "This provider item is offline and has not downloaded yet. No file was overwritten.";
    } else if (detail?.includes("PERMISSION") || detail?.includes("REVOKED")) {
      message.textContent = "Access to this vault was revoked. Reconnect the same vault to continue.";
    } else {
      message.textContent = "Vault provider is temporarily unavailable. Your previous manifest and local edits are preserved.";
    }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry refresh";
    retry.addEventListener("click", () => void this.reconcileVault("manual"));
    state.append(message, retry);
  }

  private clearReconcileState(): void {
    document.querySelector(".vault-reconcile-state")?.remove();
  }

  private showVaultAccessError(rootEl: HTMLElement, error: VaultAccessError): void {
    this.workspace?.dispose();
    rootEl.innerHTML = "";
    const state = vaultAccessPresentation(error);
    const panel = document.createElement("div");
    panel.className = "vault-picker vault-access-error";
    const heading = document.createElement("h1");
    heading.textContent = state.title;
    const message = document.createElement("p");
    message.textContent = state.message;
    const reconnect = document.createElement("button");
    reconnect.className = "mod-cta";
    reconnect.textContent = state.action;
    reconnect.addEventListener("click", async () => {
      reconnect.disabled = true;
      try {
        if (await this.host.vaultRegistry.reconnectVault(state.vaultId)) {
          await this.openVault(state.vaultId, rootEl);
        }
      } catch (reconnectError) {
        this.showInlineVaultError(panel, reconnectError);
      } finally {
        reconnect.disabled = false;
      }
    });
    panel.append(heading, message, reconnect);
    rootEl.appendChild(panel);
  }

  private showInlineVaultError(container: HTMLElement, error: unknown): void {
    let message = container.querySelector<HTMLElement>(".vault-picker-error");
    if (!message) {
      message = document.createElement("div");
      message.className = "vault-picker-error";
      message.setAttribute("role", "alert");
      container.appendChild(message);
    }
    message.textContent = error instanceof Error ? error.message : "Unable to access that vault";
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

  /**
   * `commands.attach(document)` only sees keystrokes in the host document. A
   * `<webview>` tab (Web Viewer, Artifact, canvas web card) runs in its own
   * process, so main intercepts its keys and sends the matching combo back
   * here. Main's interceptor is synchronous and cannot query this registry
   * mid-keystroke, so the bound combos are published to it up front and
   * republished whenever a plugin adds or removes a command.
   */
  private attachGuestHotkeyBridge() {
    let pending = 0;
    const publish = () => {
      // registerCommands() alone fires ~40 times; coalesce into one IPC call.
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        if (this.host.capabilities.embeddedWebContent) {
          void this.host.desktop?.publishHotkeys(this.commands.hotkeys());
        }
      }, 0);
    };
    this.hostDisposers.add(this.commands.onChange(publish));
    publish();
    const stopGuestHotkeys = this.host.desktop?.onGuestHotkey((combo, guestId) => {
      // Transient, and only readable for the duration of this dispatch:
      // createActionCommand resolves its context synchronously, before any
      // await, so activeActionContext() below always sees the right source.
      this.guestHotkeySource = typeof guestId === "number" ? guestId : null;
      try {
        this.commands.dispatchHotkey(combo);
      } finally {
        this.guestHotkeySource = null;
      }
    });
    if (stopGuestHotkeys) this.hostDisposers.add(stopGuestHotkeys);
  }

  async dispose(): Promise<void> {
    this.reconcileGeneration += 1;
    for (const dispose of this.hostDisposers) dispose();
    this.hostDisposers.clear();
    const activeReconcile = this.reconcileInFlight;
    if (activeReconcile) await activeReconcile;
    if (this.saveLayoutTimer) clearTimeout(this.saveLayoutTimer);
    this.saveLayoutTimer = null;
    if (this.communityUpdateTimer) clearTimeout(this.communityUpdateTimer);
    this.communityUpdateTimer = null;
    await this.vault.close();
    this.metadataCache.dispose();
    this.workspace?.dispose();
  }

  private async disposeVaultSession(): Promise<void> {
    this.reconcileGeneration += 1;
    for (const dispose of this.hostDisposers) dispose();
    this.hostDisposers.clear();
    const activeReconcile = this.reconcileInFlight;
    if (activeReconcile) await activeReconcile;
    if (this.saveLayoutTimer) clearTimeout(this.saveLayoutTimer);
    this.saveLayoutTimer = null;
    if (this.communityUpdateTimer) clearTimeout(this.communityUpdateTimer);
    this.communityUpdateTimer = null;
    this.activeSettingsModal?.close();
    await this.workspace?.closeAllLeaves();
    await this.pluginManager?.dispose();
    this.mermaidPlugin?.unload();
    this.workspace?.dispose();
    this.metadataCache.dispose();
    await this.vault.close();
  }

  /**
   * The `<webview>` guest a hotkey currently being dispatched came from, or
   * null for a host-document keystroke. See leafOwningGuest.
   */
  private guestHotkeySource: number | null = null;

  /**
   * The leaf whose subtree contains the guest with this WebContents id.
   *
   * Clicks inside a `<webview>` are consumed by the guest and never produce a
   * host DOM mouse event, so the host's active leaf does not follow focus
   * into one. In a split layout with a web tab active in one group and a
   * canvas web card clicked in another, Cmd+R would otherwise reload a page
   * in a pane the user is not looking at. Resolving through the DOM covers
   * every guest host uniformly: web tabs, artifact tabs, canvas web cards and
   * any plugin view that mounts a webview.
   */
  private leafOwningGuest(guestId: number): WorkspaceLeaf | null {
    const guestEl = [...document.querySelectorAll("webview")].find((el) => {
      // getWebContentsId() throws until the guest process is attached.
      try {
        return (el as unknown as { getWebContentsId(): number }).getWebContentsId() === guestId;
      } catch {
        return false;
      }
    });
    if (!guestEl) return null;
    let owner: WorkspaceLeaf | null = null;
    this.workspace.iterateAllLeaves((leaf) => {
      if (!owner && leaf.contentEl.contains(guestEl)) owner = leaf;
    });
    return owner;
  }

  /**
   * The view-scoped half of an action context.
   *
   * Resolved with `instanceof` against Geode's own view classes, never with a
   * structural `typeof view.reload === "function"` check: that would bind
   * Cmd+R to any plugin view that happens to expose a `reload` method, which
   * is untrusted third-party code.
   *
   * No `isDeferred` branch is needed. The "webviewer" and "geode-artifact"
   * factories are registered in openVaultMeasured before restoreWorkspaceLayout
   * runs, so a restored background web tab already holds a real WebView rather
   * than a DeferredView placeholder. That would stop being true if Web Viewer
   * ever moved behind a core-plugin registry.
   */
  private viewActionContext(view: View | null | undefined): Pick<AppActionContext, "view" | "webView" | "reloadable"> {
    const reloadable: ReloadableView | null =
      view instanceof WebView || view instanceof ArtifactView ? view : null;
    return {
      view: view instanceof MarkdownView ? view : null,
      webView: view instanceof WebView ? view : null,
      reloadable,
    };
  }

  private activeActionContext(): AppActionContext {
    // A guest-sourced hotkey acts on the pane it was pressed in. Falling back
    // to the active leaf when the guest cannot be placed keeps the previous
    // behavior rather than turning an unlocatable guest into a dead key.
    const source = this.guestHotkeySource;
    const leaf = (source !== null ? this.leafOwningGuest(source) : null) ?? this.workspace.getActiveLeaf();
    const file = leaf?.view?.getFile?.() ?? null;
    return {
      leaf,
      file,
      resource: file,
      ...this.viewActionContext(leaf?.view),
    };
  }

  private registerActions(): void {
    this.actions = new ActionRegistry<AppActionContext>();
    const file = (context: AppActionContext) => context.file ?? (isTFile(context.resource) ? context.resource : null);
    this.actions.register({
      id: "file.open-new-tab",
      label: "Open in new tab",
      isAvailable: (context) => !!file(context),
      run: (context) => this.openFile(file(context)!, true),
    });
    this.actions.register({
      id: "resource.bookmark",
      label: (context) => {
        const resource = context.resource ?? context.file;
        return resource && findBookmarkByPath(this.bookmarksRoot, resource.path) ? "Un-bookmark" : "Bookmark";
      },
      icon: "bookmark",
      isAvailable: (context) => !!(context.resource ?? context.file),
      run: async (context) => {
        const resource = context.resource ?? context.file;
        if (!resource) return;
        if (isTFile(resource)) await this.toggleBookmarkFile(resource);
        else await this.toggleBookmarkFolder(resource);
      },
    });
    this.actions.register({
      id: "resource.rename",
      label: "Rename…",
      isAvailable: (context) => !!(context.resource ?? context.file),
      run: (context) => this.promptRenameResource((context.resource ?? context.file)!),
    });
    this.actions.register({
      id: "resource.delete",
      label: "Delete",
      icon: "trash-2",
      warning: true,
      isAvailable: (context) => !!(context.resource ?? context.file),
      run: (context) => this.deleteResource((context.resource ?? context.file)!),
    });
    for (const [id, label, run] of [
      ["folder.new-note", "New note", (folder: TFolder) => this.createNewNote(folder.path)],
      ["folder.new-canvas", "New canvas", (folder: TFolder) => this.createNewCanvas(folder.path)],
      ["folder.new-base", "New base", (folder: TFolder) => this.createNewBase(folder.path)],
      ["folder.new-folder", "New folder", (folder: TFolder) => this.promptNewFolder(folder)],
    ] as const) {
      this.actions.register({
        id,
        label,
        isAvailable: (context) => context.resource?.kind === "folder",
        run: (context) => run(context.resource as TFolder),
      });
    }
    this.actions.register({
      id: "tab.pin",
      label: (context) => context.leaf?.pinned ? "Unpin" : "Pin",
      icon: "pin",
      isAvailable: (context) => !!context.leaf,
      run: (context) => context.leaf!.togglePinned(),
    });
    this.actions.register({
      id: "tab.close",
      label: "Close",
      isAvailable: (context) => !!context.leaf,
      run: (context) => context.leaf!.detach(),
    });
    this.actions.register({
      id: "tab.collection-new",
      label: "Add tab to new collection",
      isAvailable: (context) => !!context.leaf && context.leaf.group instanceof TabGroup && !context.leaf.group.sidebar,
      run: (context) => { (context.leaf!.group as TabGroup).createCollection(context.leaf!); },
    });
    this.actions.register({
      id: "tab.collection-remove",
      label: "Remove tab from collection",
      isAvailable: (context) => !!context.leaf && context.leaf.group instanceof TabGroup && !!context.leaf.collectionId,
      run: (context) => { (context.leaf!.group as TabGroup).removeLeafFromCollection(context.leaf!); },
    });
    this.actions.register({
      id: "tab.collection-rename",
      label: "Rename tab's collection",
      isAvailable: (context) => !!context.leaf && context.leaf.group instanceof TabGroup && !!context.leaf.collectionId,
      run: (context) => {
        const group = context.leaf!.group as TabGroup;
        const collection = group.collectionForLeaf(context.leaf!);
        if (collection) group.beginCollectionRename(collection);
      },
    });
    this.actions.register({
      id: "tab.collection-toggle",
      label: "Toggle tab's collection collapsed",
      isAvailable: (context) => !!context.leaf && context.leaf.group instanceof TabGroup && !!context.leaf.collectionId,
      run: (context) => (context.leaf!.group as TabGroup).toggleCollection(context.leaf!.collectionId!),
    });
    this.actions.register({
      id: "tab.collection-move",
      label: (context) => context.leaf?.collectionId ? "Move tab to collection…" : "Add tab to collection…",
      isAvailable: (context) => !!context.leaf && context.leaf.group instanceof TabGroup && (context.leaf.group as TabGroup).collections.length > 0,
      run: (context) => this.showCollectionPicker(context.leaf!),
    });
    for (const [id, label, direction] of [
      ["tab.collection-left", "Move collection left", -1],
      ["tab.collection-right", "Move collection right", 1],
    ] as const) {
      this.actions.register({
        id,
        label,
        isAvailable: (context) => !!context.leaf && context.leaf.group instanceof TabGroup && !!context.leaf.collectionId,
        run: (context) => { (context.leaf!.group as TabGroup).moveCollection(context.leaf!.collectionId!, direction); },
      });
    }
    for (const [id, label, direction] of [
      ["tab.move-left", "Move tab left", -1],
      ["tab.move-right", "Move tab right", 1],
    ] as const) {
      this.actions.register({
        id,
        label,
        isAvailable: (context) => {
          if (!context.leaf || !(context.leaf.group instanceof TabGroup)) return false;
          const index = context.leaf.group.leaves.indexOf(context.leaf);
          return direction < 0 ? index > 0 : index >= 0 && index < context.leaf.group.leaves.length - 1;
        },
        run: (context) => { (context.leaf!.group as TabGroup).moveLeafStep(context.leaf!, direction); },
      });
    }
    for (const [id, label, mode] of [
      ["tab.close-others", "Close others", "others"],
      ["tab.close-right", "Close tabs to the right", "right"],
    ] as const) {
      this.actions.register({
        id,
        label,
        isAvailable: (context) => {
          const leaf = context.leaf;
          return !!leaf && leaf.group instanceof TabGroup && tabCloseTargets(leaf.group.leaves, leaf, mode).length > 0;
        },
        run: async (context) => {
          const leaf = context.leaf;
          if (!leaf || !(leaf.group instanceof TabGroup)) return;
          await leaf.group.closeLeaves(tabCloseTargets([...leaf.group.leaves], leaf, mode));
        },
      });
    }
    this.actions.register({
      id: "view.toggle-reading",
      label: "Toggle reading view",
      isAvailable: (context) => !!context.view,
      run: (context) => context.view!.toggleMode(),
    });
    this.actions.register({
      id: "view.toggle-source",
      label: "Toggle Live Preview/Source mode",
      isAvailable: (context) => !!context.view,
      run: (context) => context.view!.toggleSource(),
    });
    this.actions.register({
      id: "web.reload",
      // Total by construction: resolve() evaluates the label in every context,
      // including markdown tabs that carry no reloadable view at all.
      label: (context) => context.reloadable?.reloadLabel ?? "Reload",
      icon: "rotate-cw",
      isAvailable: (context) => !!context.reloadable,
      run: (context) => context.reloadable!.reload(),
    });
    this.actions.register({
      id: "web.bookmark-page",
      label: "Bookmark this page",
      icon: "bookmark",
      isAvailable: (context) => !!context.webView,
      run: (context) => {
        const view = context.webView!;
        void this.addLinkBookmark(view.getState().url, view.pageTitle);
      },
    });
  }

  private registerCommands() {
    const c = (id: string, name: string, hotkey: string | undefined, callback: () => void) =>
      this.commands.add({ id, name, hotkey, callback });

    c("command-palette", "Open command palette", "Mod+P", () => this.openCommandPalette());
    c("quick-switcher", "Quick switcher: Open", "Mod+O", () => this.openQuickSwitcher());
    c("new-note", "Create new note", "Mod+N", () => this.createNewNote());
    this.commands.add(createActionCommand(this.actions, "view.toggle-reading", "Toggle reading view", () => this.activeActionContext(), "Mod+E", "toggle-reading"));
    this.commands.add(createActionCommand(this.actions, "view.toggle-source", "Toggle Live Preview/Source mode", () => this.activeActionContext(), undefined, "toggle-source"));
    c("new-tab", "New tab", "Mod+T", () => this.openEmptyTab(this.workspace.activeGroup));
    this.commands.add(createActionCommand(this.actions, "tab.close", "Close current tab", () => this.activeActionContext(), "Mod+W", "close-tab"));
    this.commands.add(createActionCommand(this.actions, "tab.close-others", "Close other tabs", () => this.activeActionContext()));
    this.commands.add(createActionCommand(this.actions, "tab.close-right", "Close tabs to the right", () => this.activeActionContext()));
    this.commands.add(createActionCommand(this.actions, "tab.pin", "Pin or unpin current tab", () => this.activeActionContext()));
    if (!document.body.classList.contains("is-mobile")) {
      this.commands.add(createActionCommand(this.actions, "tab.collection-new", "Tabs: Add active tab to new collection", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.collection-remove", "Tabs: Remove active tab from collection", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.collection-rename", "Tabs: Rename active tab's collection", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.collection-toggle", "Tabs: Toggle active tab's collection collapsed", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.collection-move", "Tabs: Move active tab to collection...", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.move-left", "Tabs: Move tab left", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.move-right", "Tabs: Move tab right", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.collection-left", "Tabs: Move collection left", () => this.activeActionContext()));
      this.commands.add(createActionCommand(this.actions, "tab.collection-right", "Tabs: Move collection right", () => this.activeActionContext()));
    }
    this.commands.add(createActionCommand(this.actions, "resource.rename", "Rename current file", () => this.activeActionContext()));
    this.commands.add(createActionCommand(this.actions, "resource.delete", "Delete current file", () => this.activeActionContext()));
    this.commands.add(createActionCommand(this.actions, "resource.bookmark", "Bookmark or un-bookmark current file", () => this.activeActionContext()));
    this.commands.add(createActionCommand(this.actions, "file.open-new-tab", "Open current file in new tab", () => this.activeActionContext()));
    // Mod+R. Publishing this combo also makes main.ts's guest bridge swallow
    // Cmd+R inside every <webview> guest, including canvas web-preview cards
    // that have no reload path: there it becomes a silent no-op, which is
    // strictly better than the whole-app reload it used to trigger.
    this.commands.add(createActionCommand(this.actions, "web.reload", "Reload page", () => this.activeActionContext(), "Mod+R"));
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
    c("open-another-vault", "Open another vault", undefined, () => this.openManageVaults());
    c("refresh-vault", "Refresh external vault", undefined, () => void this.reconcileVault("manual"));
    if (this.host.capabilities.nodePlugins) {
      c("community-add", "Community: Install plugin or theme from GitHub", undefined, () =>
        new InstallFromGithubModal(this, this.communityManager).open()
      );
      c("community-check-updates", "Community: Check for updates", undefined, () =>
        void this.checkCommunityUpdates(true)
      );
    }
    c("toggle-theme", "Toggle dark/light theme", undefined, () => {
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      this.applySettings();
      this.saveSettings();
    });
    this.commands.add({
      id: "daily-note",
      name: "Open today's daily note",
      hotkey: "Mod+D",
      checkCallback: (checking) => {
        if (!this.dailyNotes.enabled) return false;
        if (!checking) void this.openDailyNote();
        return true;
      },
    });
    c("open-graph", "Graph view: Open graph view", "Mod+G", () => this.openGraphView());
    c("random-note", "Open random note", undefined, () => {
      const files = this.vault.getMarkdownFiles();
      if (files.length) this.openFile(files[Math.floor(Math.random() * files.length)], false);
    });
    if (this.host.capabilities.embeddedWebContent) {
      c("open-web-viewer", "Open web viewer", undefined, () => void this.openWebViewer());
      c("search-web", "Search the web", undefined, () => this.searchWeb());
    }
    c("pin-tab", "Toggle pin on current tab", undefined, () => {
      const leaf = this.workspace.getActiveLeaf();
      leaf?.togglePinned();
    });
    c("bases-create", "Bases: Create new base", undefined, () => {
      const activeFile = this.workspace.getActiveFile();
      void this.createNewBase(activeFile?.parent ?? "");
    });
    c("canvas-create", "Canvas: Create new canvas", undefined, () => {
      const activeFile = this.workspace.getActiveFile();
      void this.createNewCanvas(activeFile?.parent ?? "");
    });
    c("bases-insert", "Bases: Insert new base", undefined, () => this.insertNewBase());
    c("bases-add-view", "Bases: Add view", undefined, () => this.getActiveBaseView()?.addView());
    c("bookmarks-open", "Bookmarks: Show bookmarks", undefined, () => {
      // Reveal the docked Bookmarks leaf the same way openSearch reveals the
      // Search pane: find the leaf by view type, then revealLeaf (expands the
      // sidebar if collapsed and activates the pane).
      const leaf = this.workspace.getLeavesOfType("bookmarks")[0];
      if (leaf) this.workspace.revealLeaf(leaf);
    });
    c("bookmarks-current-file", "Bookmarks: Bookmark current file", undefined, () => {
      const file = this.workspace.getActiveFile();
      if (!file) {
        this.notify("No active file to bookmark");
        return;
      }
      void this.toggleBookmarkFile(file);
    });
    c("bookmark-heading", "Bookmark heading under cursor", undefined, () => {
      const view = this.getActiveMarkdownView();
      if (!view) {
        this.notify("Open a note to bookmark a heading");
        return;
      }
      view.bookmarkHeadingUnderCursor();
    });
    c("bookmark-block", "Bookmark block under cursor", undefined, () => {
      const view = this.getActiveMarkdownView();
      if (!view) {
        this.notify("Open a note to bookmark a block");
        return;
      }
      void view.bookmarkBlockUnderCursor();
    });
    // Deliberately a plain callback delegating to the action, not a
    // createActionCommand adapter. This command is unconditional today: it is
    // always in the palette and notifies when no web page is open. An adapter
    // would hide it from the palette and make
    // executeCommandById("bookmark-webpage") silently return false, which is a
    // visible change to the plugin and host-tooling surface.
    c("bookmark-webpage", "Bookmark current web page", undefined, () => {
      const context = this.activeActionContext();
      if (!context.webView) {
        this.notify("No web page is open");
        return;
      }
      void this.actions.execute("web.bookmark-page", context);
    });
  }

  // --- File opening -------------------------------------------------------

  async openFile(file: TFile, newTab: boolean): Promise<void> {
    if (file.extension === "canvas") {
      const existing = this.workspace.findLeafForFile(file.path);
      if (existing && !newTab) {
        existing.group.setActiveLeaf(existing);
        return;
      }
      const leaf = this.workspace.getLeaf(newTab);
      await this.openFileInLeaf(leaf, file);
      return;
    }
    if (file.extension === "html" || file.extension === "htm") {
      if (!(this.vault.adapter instanceof FileSystemAdapter)) {
        this.notify("Local HTML preview is available on desktop only");
        return;
      }
      const leaf = this.workspace.getLeaf(newTab);
      await leaf.setViewState({
        type: "webviewer",
        active: true,
        state: { url: this.vault.adapter.getResourcePath(file.path) },
      });
      return;
    }
    if (file.extension === "base" || file.extension === "md") {
      const existing = this.workspace.findLeafForFile(file.path);
      if (existing && !newTab) {
        existing.group.setActiveLeaf(existing);
        return;
      }
      const leaf = this.workspace.getLeaf(newTab);
      await this.openFileInLeaf(leaf, file);
      return;
    }
    this.notify(`Cannot open .${file.extension} files yet`);
  }

  /** Open a supported document in a specific leaf; every load is serialized by that leaf. */
  async openFileInLeaf(
    leaf: WorkspaceLeaf,
    file: TFile,
    recordHistory = true,
    alreadySerialized = false
  ): Promise<void> {
    const open = async () => this.mountDocumentInLeaf(leaf, file, recordHistory);
    if (alreadySerialized) return open();
    return leaf.runDocumentNavigation(open);
  }

  private async mountDocumentInLeaf(leaf: WorkspaceLeaf, file: TFile, recordHistory: boolean): Promise<void> {
    const previousPath = leaf.view?.getFile?.()?.path;
    if (file.extension === "canvas") {
      const view = new CanvasView(this);
      await view.setFile(file);
      await leaf.setView(view);
    } else if (file.extension === "base") {
      const view = new BaseView(this);
      await view.setFile(file);
      await leaf.setView(view);
    } else if (file.extension === "md") {
      const view = new MarkdownView(this);
      await view.setFile(file);
      await leaf.setView(view);
    } else {
      throw new Error(`Unsupported document history file extension: .${file.extension}`);
    }
    if (recordHistory) {
      if (previousPath) leaf.recordDocumentNavigation(previousPath);
      leaf.recordDocumentNavigation(file.path);
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

  /** Create a valid empty JSON Canvas in the requested folder and open it. */
  async createNewCanvas(folder?: string, name?: string): Promise<void> {
    const path = this.vault.availablePath(folder ?? "", name ?? "Untitled", "canvas");
    const file = await this.vault.create(path, serializeCanvas({ nodes: [], edges: [] }));
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
    if (!this.host.capabilities.embeddedWebContent) {
      await this.host.navigation.openExternal(url ?? this.settings.webViewer.homeUrl);
      return;
    }
    const leaf = this.workspace.getLeaf(true);
    await leaf.setViewState({
      type: "webviewer",
      active: true,
      state: { url: url ?? this.settings.webViewer.homeUrl },
    });
  }

  /** Open a validated static design artifact in an isolated guest session. */
  async openArtifact(root: string): Promise<void> {
    if (!this.host.capabilities.artifacts) {
      this.notify("Artifacts are available on desktop only");
      return;
    }
    const leaf = this.workspace.getLeaf(true);
    await leaf.setViewState({ type: "geode-artifact", active: true, state: { root } });
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
      if (e.metaKey || e.ctrlKey) void this.host.navigation.openExternal(href);
      else this.openExternalLink(href);
    });
  }

  private async openLocalFileLink(href: string): Promise<void> {
    const result = await this.host.navigation.openLocalFile(href);
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
    if (this.host.capabilities.embeddedWebContent && this.settings.webViewer.openLinksInApp && /^https?:\/\//i.test(url)) {
      void this.openWebViewer(url);
    } else {
      void this.host.navigation.openExternal(url);
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
    if (!name) this.getActiveMarkdownView()?.beginTitleRename();
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

  // --- Bookmarks -----------------------------------------------------------

  /**
   * Apply a pure mutation from `bookmarks.ts` to the in-memory model,
   * persist it to ".geode/bookmarks.json", and notify any open
   * `BookmarksView` (and other listeners, e.g. File Explorer's context menu
   * label) to refresh. Every Bookmarks mutation — from the Bookmarks pane
   * itself or from File Explorer's "Bookmark" menu item — goes through this
   * single path so persistence and change notification never get missed.
   */
  async mutateBookmarks(fn: (root: BookmarksRoot) => BookmarksRoot): Promise<void> {
    this.bookmarksRoot = fn(this.bookmarksRoot);
    await this.host.config.write("bookmarks", this.bookmarksRoot);
    this.workspace.trigger("bookmarks-changed");
  }

  /** Toggle a file bookmark on/off (Obsidian's "Bookmark"/"Un-bookmark" File Explorer menu item). */
  async toggleBookmarkFile(file: TFile): Promise<void> {
    const existing = findBookmarkByPath(this.bookmarksRoot, file.path);
    if (existing) {
      await this.mutateBookmarks((root) => removeBookmark(root, existing.id));
      this.notify(`Un-bookmarked "${file.name}"`);
    } else {
      await this.mutateBookmarks((root) =>
        addBookmark(root, { type: "file", id: crypto.randomUUID(), path: file.path })
      );
      this.notify(`Bookmarked "${file.name}"`);
    }
  }

  /** Toggle a folder bookmark on/off (Obsidian's "Bookmark"/"Un-bookmark" File Explorer folder menu item). */
  async toggleBookmarkFolder(folder: { path: string; name: string }): Promise<void> {
    const existing = findBookmarkByPath(this.bookmarksRoot, folder.path);
    if (existing) {
      await this.mutateBookmarks((root) => removeBookmark(root, existing.id));
      this.notify(`Un-bookmarked "${folder.name}"`);
    } else {
      await this.mutateBookmarks((root) =>
        addBookmark(root, { type: "folder", id: crypto.randomUUID(), path: folder.path })
      );
      this.notify(`Bookmarked "${folder.name}"`);
    }
  }

  /**
   * Bookmark a Search query (spec: Search pane three-dot menu). De-dupes on an
   * exact query match so bookmarking the same search twice is a no-op notice.
   */
  async addSearchBookmark(query: string): Promise<void> {
    const q = query.trim();
    if (!q) {
      this.notify("Enter a search query before bookmarking it");
      return;
    }
    if (findBookmark(this.bookmarksRoot, (b) => b.type === "search" && b.query === q)) {
      this.notify("That search is already bookmarked");
      return;
    }
    await this.mutateBookmarks((root) =>
      addBookmark(root, { type: "search", id: crypto.randomUUID(), query: q })
    );
    this.notify(`Bookmarked search "${q}"`);
  }

  /** Bookmark a heading in a file (spec: right-click heading / "Bookmark heading under cursor"). De-dupes on path+heading. */
  async addHeadingBookmark(file: TFile, heading: { heading: string; level: number }): Promise<void> {
    if (
      findBookmark(
        this.bookmarksRoot,
        (b) => b.type === "heading" && b.path === file.path && b.heading === heading.heading
      )
    ) {
      this.notify("That heading is already bookmarked");
      return;
    }
    await this.mutateBookmarks((root) =>
      addBookmark(root, {
        type: "heading",
        id: crypto.randomUUID(),
        path: file.path,
        heading: heading.heading,
        level: heading.level,
      })
    );
    this.notify(`Bookmarked heading "${heading.heading}"`);
  }

  /** Bookmark a block by its `^blockId` (spec: "Bookmark block under cursor"). De-dupes on path+blockId. */
  async addBlockBookmark(file: TFile, blockId: string): Promise<void> {
    if (
      findBookmark(
        this.bookmarksRoot,
        (b) => b.type === "block" && b.path === file.path && b.blockId === blockId
      )
    ) {
      this.notify("That block is already bookmarked");
      return;
    }
    await this.mutateBookmarks((root) =>
      addBookmark(root, { type: "block", id: crypto.randomUUID(), path: file.path, blockId })
    );
    this.notify(`Bookmarked block ^${blockId}`);
  }

  /** Bookmark a web URL (spec: Web Viewer three-dot menu). De-dupes on the exact URL. */
  async addLinkBookmark(url: string, title?: string): Promise<void> {
    const u = url.trim();
    if (!u) {
      this.notify("No URL to bookmark");
      return;
    }
    if (findBookmark(this.bookmarksRoot, (b) => b.type === "link" && b.url === u)) {
      this.notify("That page is already bookmarked");
      return;
    }
    await this.mutateBookmarks((root) =>
      addBookmark(root, {
        type: "link",
        id: crypto.randomUUID(),
        url: u,
        ...(title ? { title } : {}),
      })
    );
    this.notify(`Bookmarked "${title || u}"`);
  }

  /** Bookmark the global Graph view (spec: Graph tab right-click). De-dupes so at most one graph bookmark exists. */
  async addGraphBookmark(): Promise<void> {
    if (findBookmark(this.bookmarksRoot, (b) => b.type === "graph")) {
      this.notify("The graph is already bookmarked");
      return;
    }
    await this.mutateBookmarks((root) => addBookmark(root, { type: "graph", id: crypto.randomUUID() }));
    this.notify("Bookmarked graph");
  }

  /**
   * Bulk-bookmark every leaf in a tab group (spec: tab-group dropdown →
   * "Bookmark [N] tabs"). File leaves become file bookmarks, Web Viewer leaves
   * become link bookmarks; anything else (empty tabs, settings, etc.) is
   * skipped. All adds are batched through a single `mutateBookmarks` so the
   * pane refreshes and persists once. Already-bookmarked paths/URLs are not
   * duplicated.
   */
  async bookmarkLeaves(leaves: WorkspaceLeaf[]): Promise<void> {
    const toAdd: Bookmark[] = [];
    const seenPaths = new Set<string>();
    const seenUrls = new Set<string>();
    for (const leaf of leaves) {
      const view = leaf.view;
      const file = view?.getFile?.() ?? null;
      if (file) {
        if (seenPaths.has(file.path) || findBookmarkByPath(this.bookmarksRoot, file.path)) continue;
        seenPaths.add(file.path);
        toAdd.push({ type: "file", id: crypto.randomUUID(), path: file.path });
        continue;
      }
      if (view?.viewType === "webviewer") {
        const url = (view.getState?.() as { url?: string } | undefined)?.url;
        if (!url || seenUrls.has(url)) continue;
        if (findBookmark(this.bookmarksRoot, (b) => b.type === "link" && b.url === url)) continue;
        seenUrls.add(url);
        toAdd.push({ type: "link", id: crypto.randomUUID(), url });
      }
    }
    if (!toAdd.length) {
      this.notify("No bookmarkable tabs to add");
      return;
    }
    await this.mutateBookmarks((root) => toAdd.reduce((acc, bm) => addBookmark(acc, bm), root));
    this.notify(`Bookmarked ${toAdd.length} tab${toAdd.length === 1 ? "" : "s"}`);
  }

  /**
   * Open the target of a bookmark (spec: "Selecting a bookmark opens the
   * item"). Dispatches per bookmark type — file/heading/block open the note and
   * (for heading/block) scroll to the right spot; search reveals the Search
   * pane and re-runs the query; link opens the Web Viewer; graph opens the
   * global Graph view; folder reveals the File Explorer pane (Geode has no
   * reveal-to-a-specific-folder affordance yet, so this is a pane reveal + a
   * Notice — flagged for a later pass).
   */
  async openBookmark(bm: Bookmark, newTab = false): Promise<void> {
    switch (bm.type) {
      case "file": {
        const file = this.vault.getFileByPath(bm.path);
        if (file) await this.openFile(file, newTab);
        else this.notify(`"${bm.path}" no longer exists in the vault`);
        return;
      }
      case "folder": {
        const folder = this.vault.getAbstractFileByPath(bm.path);
        const leaf = this.workspace.getLeavesOfType("file-explorer")[0];
        if (leaf) this.workspace.revealLeaf(leaf);
        this.notify(folder ? `Folder: ${bm.path}` : `"${bm.path}" no longer exists in the vault`);
        return;
      }
      case "search":
        this.openSearch(bm.query);
        return;
      case "heading": {
        const file = this.vault.getFileByPath(bm.path);
        if (!file) {
          this.notify(`"${bm.path}" no longer exists in the vault`);
          return;
        }
        const headings = this.metadataCache.getFileCache(file)?.headings ?? [];
        const match =
          headings.find((h) => h.heading === bm.heading && h.level === bm.level) ??
          headings.find((h) => h.heading === bm.heading);
        this.revealOffsetInActiveMarkdownView(file, match?.position.start.offset ?? 0);
        return;
      }
      case "block": {
        const file = this.vault.getFileByPath(bm.path);
        if (!file) {
          this.notify(`"${bm.path}" no longer exists in the vault`);
          return;
        }
        let offset = 0;
        try {
          const content = await this.vault.cachedRead(file);
          let acc = 0;
          for (const line of content.split("\n")) {
            if (line.trimEnd().endsWith(`^${bm.blockId}`)) {
              offset = acc;
              break;
            }
            acc += line.length + 1;
          }
        } catch {
          /* fall back to offset 0 */
        }
        this.revealOffsetInActiveMarkdownView(file, offset);
        return;
      }
      case "link":
        await this.openWebViewer(bm.url);
        return;
      case "graph":
        await this.openGraphView();
        return;
      default:
        // Unreachable for the known union, but a corrupt or newer-versioned
        // config could carry an unknown type — notify and ignore rather than
        // fall through silently.
        this.notify(`Can't open bookmark of unknown type "${(bm as { type?: string }).type}"`);
        return;
    }
  }

  /**
   * Bookmark a batch of vault paths (spec: File Explorer multi-select →
   * "Bookmark all"). Each path becomes a file or folder bookmark depending on
   * what it resolves to; already-bookmarked and missing paths are skipped. All
   * adds go through a single `mutateBookmarks` so the pane refreshes once.
   */
  async bookmarkPaths(paths: string[]): Promise<void> {
    const toAdd: Bookmark[] = [];
    for (const path of paths) {
      if (findBookmarkByPath(this.bookmarksRoot, path)) continue;
      const abstractFile = this.vault.getAbstractFileByPath(path);
      if (!abstractFile) continue;
      const type = isTFile(abstractFile) ? "file" : "folder";
      toAdd.push({ type, id: crypto.randomUUID(), path });
    }
    if (!toAdd.length) {
      this.notify("All selected items are already bookmarked");
      return;
    }
    await this.mutateBookmarks((root) => toAdd.reduce((acc, bm) => addBookmark(acc, bm), root));
    this.notify(`Bookmarked ${toAdd.length} item${toAdd.length === 1 ? "" : "s"}`);
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
      const saved = (await this.host.config.read("workspace")) as PersistedWorkspace | null;
      if (saved && (saved.version === 1 || saved.version === 2 || saved.version === 3)) {
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
    // Belt and braces on top of deferred restore. In crash-recovery mode
    // `PluginManager.initialize()` returns before enabling any plugin, so zero
    // plugin view factories exist for the whole session. Deferral already makes
    // the save lossless, but a recovery launch is precisely the moment a
    // regression here would be unrecoverable — the user's real layout would be
    // overwritten before they ever clicked "Restart with plugins". Not saving
    // at all is strictly safer than saving a layout assembled without plugins.
    //
    // Tradeoff, accepted: layout tweaks made during a recovery session (moving
    // a tab, resizing a sidebar) are not persisted. Recovery sessions are short
    // and end in a reload.
    if (this.pluginManager?.isRecoveryMode()) return;
    if (this.saveLayoutTimer) clearTimeout(this.saveLayoutTimer);
    this.saveLayoutTimer = setTimeout(() => {
      this.saveLayoutTimer = null;
      this.host.config.write("workspace", this.workspace.serialize()).catch((err) => {
        console.error("Failed to save workspace layout", err);
      });
    }, 400);
  }

  openQuickSwitcher() {
    new QuickSwitcherModal(this).open();
  }

  private createMobileNavigation(): HTMLElement {
    const navigation = document.createElement("nav");
    navigation.className = "mobile-navigation";
    navigation.setAttribute("aria-label", "Mobile navigation");
    const addAction = (label: string, icon: string, action: (button: HTMLButtonElement) => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-navigation-action";
      button.setAttribute("aria-label", label);
      setIcon(button, icon);
      const text = document.createElement("span");
      text.textContent = label;
      button.appendChild(text);
      button.addEventListener("touchend", (event) => {
        // WKWebView can consume the first compatibility click while moving
        // focus into web content after launch. A completed touch is already
        // the user's activation; preventing its synthetic click keeps the
        // action exactly-once while keyboard/mouse activation stays intact.
        event.preventDefault();
        action(button);
      }, { passive: false });
      button.addEventListener("click", () => action(button));
      navigation.appendChild(button);
    };

    addAction("Files", "files", (button) => {
      const leaf = this.workspace.getLeavesOfType("file-explorer")[0];
      if (leaf) this.workspace.presentMobileSidebarLeaf("left", leaf, button);
    });
    addAction("Search", "search", (button) => {
      const leaf = this.workspace.getLeavesOfType("search")[0];
      const view = leaf?.view as SearchView | null;
      if (!leaf || !view) return;
      view.setQuery("");
      this.workspace.presentMobileSidebarLeaf("left", leaf, button);
      requestAnimationFrame(() =>
        this.workspace.leftSidebar.containerEl.querySelector<HTMLInputElement>(".search-input")?.focus()
      );
    });
    addAction("New note", "file-plus-2", () => void this.createNewNote());
    addAction("Details", "panel-right", (button) => this.workspace.presentCurrentMobileSidebar("right", button));
    addAction("More", "ellipsis", (button) => {
      this.showMenu(new MouseEvent("click"), [
        { title: "Quick switcher", icon: "arrow-left-right", action: () => this.openQuickSwitcher() },
        { title: "Commands", icon: "terminal", action: () => this.openCommandPalette() },
        { title: "Settings", icon: "settings", action: () => this.setting.open() },
      ], { anchor: button, horizontalAlign: "end", menuClass: "mod-mobile-more" });
    });
    return navigation;
  }

  private trackMobileVisualViewport(): void {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const offset = document.body.classList.contains("is-mobile")
        ? Math.max(0, viewport.offsetTop + window.scrollY)
        : 0;
      document.documentElement.style.setProperty("--geode-visual-viewport-top", `${offset}px`);
    };
    viewport.addEventListener("resize", update, { passive: true });
    viewport.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  openCommandPalette() {
    new CommandPaletteModal(this).open();
  }

  openSearch(query: string) {
    const leaf = this.workspace.getLeavesOfType("search")[0];
    const view = leaf?.view as SearchView | null;
    if (!leaf || !view) return;
    this.workspace.revealLeaf(leaf);
    view.setQuery(query);
  }

  /** Construct a fresh MarkdownView bound to this app (used by WorkspaceLeaf.openFile for hosted plugins). */
  createMarkdownView(): MarkdownView {
    return new MarkdownView(this);
  }

  /** Construct a fresh file-backed JSON Canvas view (used during workspace restore). */
  createCanvasView(): CanvasView {
    return new CanvasView(this);
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

  /** One validated rename path shared by inline title, menus, explorer, and commands. */
  async renameFile(file: TFile, basename: string): Promise<boolean> {
    const result = renamePathForBasename(file.path, basename);
    if (!result.ok) {
      this.notify(result.error);
      return false;
    }
    if (result.path === file.path) return true;
    if (this.vault.getAbstractFileByPath(result.path)) {
      this.notify(`A file named "${basename.trim()}" already exists`);
      return false;
    }
    try {
      await this.renameFileWithLinkUpdate(file, result.path);
      return true;
    } catch (error) {
      console.error("Failed to rename file", error);
      this.notify(`Could not rename "${file.name}"`);
      return false;
    }
  }

  promptRenameResource(resource: TFile | TFolder): void {
    new PromptModal(this, {
      placeholder: "New name",
      initialValue: isTFile(resource) ? resource.basename : resource.name,
      onSubmit: async (name) => {
        if (isTFile(resource)) {
          await this.renameFile(resource, name);
          return;
        }
        const trimmed = name.trim();
        if (!trimmed || /[\\/:#|^\[\]]/.test(trimmed)) {
          this.notify("Invalid folder name");
          return;
        }
        const newPath = `${resource.parent ? resource.parent + "/" : ""}${trimmed}`;
        if (this.vault.getAbstractFileByPath(newPath)) {
          this.notify(`A folder named "${trimmed}" already exists`);
          return;
        }
        try {
          await this.vault.rename(resource, newPath);
        } catch (error) {
          console.error("Failed to rename folder", error);
          this.notify(`Could not rename "${resource.name}"`);
        }
      },
    }).open();
  }

  promptNewFolder(parent: TFolder): void {
    new PromptModal(this, {
      placeholder: "Folder name",
      onSubmit: async (name) => {
        const trimmed = name.trim();
        if (!trimmed || /[\\/:#|^\[\]]/.test(trimmed)) {
          this.notify("Invalid folder name");
          return;
        }
        const path = `${parent.path}/${trimmed}`;
        if (this.vault.getAbstractFileByPath(path)) {
          this.notify(`A folder named "${trimmed}" already exists`);
          return;
        }
        try {
          await this.vault.createFolder(path);
        } catch (error) {
          console.error("Failed to create folder", error);
          this.notify(`Could not create folder "${trimmed}"`);
        }
      },
    }).open();
  }

  async deleteResource(resource: TFile | TFolder): Promise<void> {
    const message = isTFile(resource)
      ? `Delete "${resource.name}"? It will be moved to the system trash.`
      : `Delete folder "${resource.name}" and all its contents?`;
    if (confirm(message)) await this.vault.trash(resource);
  }

  showDocumentMenu(e: MouseEvent, leaf: WorkspaceLeaf, options: { anchor?: HTMLElement } = {}): void {
    const file = leaf.view?.getFile?.() ?? null;
    if (!file) return;
    this.showMenu(e, composeMenu(this.actions, {
      leaf,
      file,
      resource: file,
      view: leaf.view instanceof MarkdownView ? leaf.view : null,
    }, DOCUMENT_MENU_SPEC), options);
  }

  resourceMenuItems(resource: TFile | TFolder) {
    return composeMenu(this.actions, {
      file: isTFile(resource) ? resource : null,
      resource,
    }, DOCUMENT_MENU_SPEC);
  }

  folderMenuItems(folder: TFolder) {
    return composeMenu(this.actions, { resource: folder }, FOLDER_MENU_SPEC);
  }

  /** Page actions for the Web Viewer toolbar's "More options" menu. */
  webPageMenuItems(view: WebView) {
    return composeMenu(this.actions, { webView: view, reloadable: view, leaf: null }, WEB_TAB_MENU_SPEC);
  }

  // --- UI helpers ---------------------------------------------------------

  notify(message: string, timeout = 4000) {
    createDismissibleNotice(message, timeout);
  }

  showMenu(
    e: MouseEvent,
    items: Array<{
      title: string | DocumentFragment;
      action?: () => void;
      submenu?: Array<{
        title: string | DocumentFragment;
        action: () => void;
        icon?: string | null;
        checked?: boolean;
        disabled?: boolean;
        section?: string;
        warning?: boolean;
      }>;
      icon?: string | null;
      checked?: boolean;
      disabled?: boolean;
      section?: string;
      warning?: boolean;
    }>,
    options: { anchor?: HTMLElement; horizontalAlign?: "start" | "end"; menuClass?: string } = {}
  ): Menu {
    const menu = new Menu();
    // Keep the pre-v0.8 selectors during the core-menu migration. The shared
    // Obsidian-compatible DOM remains canonical (`.menu` / `.menu-item`).
    menu.dom.classList.add("context-menu");
    if (options.menuClass) menu.dom.classList.add(options.menuClass);
    for (const item of items) {
      menu.addItem((menuItem) => {
        menuItem.dom.classList.add("context-menu-item");
        menuItem
          .setTitle(item.title)
          .setIcon(item.icon ?? null)
          .setChecked(item.checked ?? false)
          .setDisabled(item.disabled ?? false)
          .setSection(item.section ?? "default")
          .onClick(item.submenu
            ? () => this.showMenu(new MouseEvent("click"), item.submenu!, { anchor: menuItem.dom })
            : (item.action ?? (() => {})));
        menuItem.dom.classList.toggle("has-submenu", !!item.submenu);
        if (item.submenu) menuItem.dom.setAttribute("aria-haspopup", "menu");
        menuItem.dom.classList.toggle("is-warning", item.warning ?? false);
      });
    }
    if (options.anchor) {
      menu.showAtElement(options.anchor, { horizontalAlign: options.horizontalAlign });
    } else {
      menu.showAtMouseEvent(e);
    }
    return menu;
  }

  /** Open the Obsidian-compatible context menu for a main-area tab. */
  showTabContextMenu(e: MouseEvent, leaf: WorkspaceLeaf): void {
    e.preventDefault();
    e.stopPropagation();
    const file = leaf.view?.getFile?.() ?? null;
    this.showMenu(e, composeMenu(this.actions, {
      leaf,
      file,
      resource: file,
      ...this.viewActionContext(leaf.view),
    }, TAB_MENU_SPEC));
  }

  private showCollectionPicker(leaf: WorkspaceLeaf): void {
    if (!(leaf.group instanceof TabGroup)) return;
    const group = leaf.group;
    const items = group.collections.map((collection, index) => ({
      title: `${collection.name} (${collection.color}, ${index + 1})`,
      checked: leaf.collectionId === collection.id,
      action: () => group.addLeafToCollection(leaf, collection.id),
    }));
    if (!items.length) return;
    this.showMenu(new MouseEvent("click", { clientX: 0, clientY: 0 }), items, { anchor: leaf.tabEl });
  }

  applySettings() {
    document.body.classList.toggle("theme-dark", this.settings.theme === "dark");
    document.body.classList.toggle("theme-light", this.settings.theme === "light");
    document.body.classList.toggle("is-readable-line-length", this.settings.readableLineLength);
    document.body.classList.toggle("show-ribbon", this.settings.showRibbon);
    document.body.classList.toggle("show-status-bar", this.settings.showStatusBar);
    // Real Obsidian hides .view-header entirely unless <body> has this class
    // (`body:not(.show-view-header):not(.is-phone) .view-header { display: none }`).
    // Geode always shows it — there's no settings toggle for this yet.
    document.body.classList.add("show-view-header");
    this.syncWindowBackgroundColor();
    // Obsidian's own event name. Anything whose appearance was baked from
    // theme CSS variables at build time — today, rendered Mermaid diagrams —
    // re-derives it here instead of keeping the colors it was born with.
    // Optional-chained defensively: `workspace` is only assigned once a vault
    // is opened, and applySettings() is reachable from the settings tab.
    this.workspace?.trigger("css-change");
  }

  /** Keep macOS's rounded native window corners aligned with theme-owned chrome. */
  syncWindowBackgroundColor(): void {
    const color = getComputedStyle(document.querySelector(".app-main") ?? document.body)
      .backgroundColor;
    if (this.host.capabilities.multipleWindows) {
      void this.host.desktop?.setWindowBackgroundColor(color);
    }
  }

  saveSettings() {
    void this.host.config.write("app", this.settings);
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

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const app = new App();
  // Assigned before `start()` is kicked off (rather than after) so a plugin
  // whose main.js does module-eval-time work that reads `window.app` (or a
  // Node-timer callback that resolves before `start()`'s first `await`)
  // never observes `window.app === undefined`.
  (window as any).app = app;
  void app.start();
}
