import { Events } from "./events";
import type { App } from "./app";
import type { TFile } from "./types";

export interface View {
  readonly viewType: string;
  containerEl: HTMLElement;
  getDisplayText(): string;
  getIcon(): string;
  onOpen(): void | Promise<void>;
  onClose(): void | Promise<void>;
  /** Views showing a file implement this. */
  getFile?(): TFile | null;
}

/**
 * The minimal surface a `WorkspaceLeaf` needs from whatever hosts it. Both
 * `TabGroup` (main tab area) and `Sidebar` (docked panes) implement this, so
 * a leaf — and any plugin view mounted in it — can live in either place. This
 * is what lets hosted Obsidian plugins open their views in the sidebars, the
 * way real Obsidian does, rather than always as main-area tabs.
 */
export interface LeafContainer {
  setActiveLeaf(leaf: WorkspaceLeaf): void;
  removeLeaf(leaf: WorkspaceLeaf): void;
  renderTabs(): void;
}

let leafIdCounter = 0;

/** A leaf is one tab (or one docked sidebar pane): a container hosting a single view. */
export class WorkspaceLeaf {
  id = `leaf-${++leafIdCounter}`;
  view: View | null = null;
  tabEl: HTMLElement;
  contentEl: HTMLElement;
  pinned = false;

  constructor(
    public group: LeafContainer,
    public app: App
  ) {
    this.tabEl = document.createElement("div");
    this.tabEl.className = "workspace-tab-header";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "workspace-leaf-content";
  }

  async setView(view: View): Promise<void> {
    if (this.view) await this.view.onClose();
    this.view = view;
    this.contentEl.innerHTML = "";
    this.contentEl.appendChild(view.containerEl);
    await view.onOpen();
    this.group.renderTabs();
    if (view.getFile?.()) {
      this.app.workspace.trigger("file-open", view.getFile!());
    }
  }

  getDisplayText(): string {
    return this.view?.getDisplayText() ?? "New tab";
  }

  private viewState: { type: string; state?: unknown } = { type: "empty" };

  /**
   * Obsidian-compatible view opener: resolve the registered factory for
   * `state.type` (from `Plugin.registerView`/`registerViewFactory`) and
   * mount its view in this leaf. This is how Obsidian plugins open their
   * own views (`leaf.setViewState({ type: MY_VIEW })`).
   */
  async setViewState(state: { type: string; active?: boolean; state?: unknown }): Promise<void> {
    this.viewState = { type: state.type, state: state.state };
    const factory = this.app.workspace.getViewFactory(state.type);
    if (!factory) throw new Error(`No view registered for type "${state.type}"`);
    const view = factory(this);
    await this.setView(view);
    if (state.state && typeof (view as any).setState === "function") {
      await (view as any).setState(state.state, {});
    }
    if (state.active) this.group.setActiveLeaf(this);
  }

  getViewState(): { type: string; state?: unknown } {
    return { type: this.view?.viewType ?? this.viewState.type, state: this.viewState.state };
  }

  /** Open a markdown file in *this* leaf (Obsidian `leaf.openFile`). */
  async openFile(file: TFile): Promise<void> {
    const view = this.app.createMarkdownView();
    await view.setFile(file);
    await this.setView(view);
  }

  /** Re-render this leaf's tab header (Obsidian `leaf.updateHeader`). */
  updateHeader(): void {
    this.group.renderTabs();
  }

  private _tabTitleEl?: HTMLElement;
  /** Obsidian's inner tab-title element. Geode rebuilds tab DOM on each render, so this is a stable scratch element plugins can write to without crashing. */
  get tabHeaderInnerTitleEl(): HTMLElement {
    if (!this._tabTitleEl) this._tabTitleEl = document.createElement("span");
    return this._tabTitleEl;
  }

  async detach(): Promise<void> {
    await this.view?.onClose();
    this.group.removeLeaf(this);
  }
}

/** A group of tabs sharing one content area. */
export class TabGroup {
  leaves: WorkspaceLeaf[] = [];
  active: WorkspaceLeaf | null = null;
  containerEl: HTMLElement;
  tabBarEl: HTMLElement;
  contentHostEl: HTMLElement;

  constructor(
    public workspace: Workspace,
    public app: App
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-tab-group";
    this.tabBarEl = document.createElement("div");
    this.tabBarEl.className = "workspace-tab-bar";
    this.contentHostEl = document.createElement("div");
    this.contentHostEl.className = "workspace-tab-content";
    this.containerEl.appendChild(this.tabBarEl);
    this.containerEl.appendChild(this.contentHostEl);
    this.containerEl.addEventListener("mousedown", () => {
      this.workspace.setActiveGroup(this);
    });
  }

  createLeaf(): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this, this.app);
    this.leaves.push(leaf);
    this.setActiveLeaf(leaf);
    return leaf;
  }

  setActiveLeaf(leaf: WorkspaceLeaf) {
    this.active = leaf;
    this.contentHostEl.innerHTML = "";
    this.contentHostEl.appendChild(leaf.contentEl);
    this.renderTabs();
    this.workspace.activeGroup = this;
    this.workspace.trigger("active-leaf-change", leaf);
    const file = leaf.view?.getFile?.();
    if (file) this.workspace.trigger("file-open", file);
  }

  removeLeaf(leaf: WorkspaceLeaf) {
    const i = this.leaves.indexOf(leaf);
    if (i === -1) return;
    this.leaves.splice(i, 1);
    if (this.active === leaf) {
      const next = this.leaves[Math.min(i, this.leaves.length - 1)] ?? null;
      if (next) this.setActiveLeaf(next);
      else {
        this.active = null;
        this.contentHostEl.innerHTML = "";
        this.workspace.groupEmptied(this);
      }
    }
    this.renderTabs();
  }

  renderTabs() {
    this.tabBarEl.innerHTML = "";
    for (const leaf of this.leaves) {
      const tab = leaf.tabEl;
      tab.innerHTML = "";
      tab.classList.toggle("is-active", leaf === this.active);
      const title = document.createElement("span");
      title.className = "workspace-tab-title";
      title.textContent = (leaf.pinned ? "📌 " : "") + leaf.getDisplayText();
      const close = document.createElement("span");
      close.className = "workspace-tab-close";
      close.textContent = "×";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        leaf.detach();
      });
      tab.appendChild(title);
      tab.appendChild(close);
      tab.onmousedown = (e) => {
        if (e.button === 1) leaf.detach();
        else this.setActiveLeaf(leaf);
      };
      this.tabBarEl.appendChild(tab);
    }
    const newTab = document.createElement("div");
    newTab.className = "workspace-tab-new";
    newTab.textContent = "+";
    newTab.title = "New tab";
    newTab.addEventListener("click", () => this.app.openEmptyTab(this));
    this.tabBarEl.appendChild(newTab);
  }
}

/** One entry shown in a sidebar: either a built-in fixed `View` or a docked plugin `WorkspaceLeaf`. */
type SidebarItem = View | WorkspaceLeaf;

/**
 * A sidebar dock: an icon strip plus one visible pane at a time. It hosts
 * both Geode's built-in fixed views (file explorer, search, backlinks, …)
 * and — implementing `LeafContainer` — plugin `WorkspaceLeaf`s, so hosted
 * Obsidian plugins can dock their panes here (`getRightLeaf`/`getLeftLeaf`
 * + `revealLeaf`) exactly like real Obsidian.
 */
export class Sidebar implements LeafContainer {
  containerEl: HTMLElement;
  iconBarEl: HTMLElement;
  contentEl: HTMLElement;
  views: View[] = [];
  leaves: WorkspaceLeaf[] = [];
  active: SidebarItem | null = null;
  collapsed = false;

  constructor(
    public side: "left" | "right",
    public app: App
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = `workspace-sidebar mod-${side}`;
    this.iconBarEl = document.createElement("div");
    this.iconBarEl.className = "sidebar-icon-bar";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "sidebar-content";
    this.containerEl.appendChild(this.iconBarEl);
    this.containerEl.appendChild(this.contentEl);
  }

  private isLeaf(item: SidebarItem): item is WorkspaceLeaf {
    return item instanceof WorkspaceLeaf;
  }

  private metaOf(item: SidebarItem): { icon: string; title: string; el: HTMLElement | null } {
    if (this.isLeaf(item)) {
      return {
        icon: item.view?.getIcon() ?? "•",
        title: item.view?.getDisplayText() ?? "…",
        el: item.view?.containerEl ?? null,
      };
    }
    return { icon: item.getIcon(), title: item.getDisplayText(), el: item.containerEl };
  }

  addView(view: View) {
    this.views.push(view);
    this.renderIcons();
    if (!this.active) this.show(view);
  }

  /**
   * Create and host a new plugin leaf docked in this sidebar. The icon
   * appears (and updates) once a view is mounted via `leaf.setViewState`.
   * Reuses an existing empty (view-less) docked leaf if one is available,
   * so repeated `getRightLeaf` calls don't pile up blank panes.
   */
  addLeaf(): WorkspaceLeaf {
    const empty = this.leaves.find((l) => !l.view);
    if (empty) return empty;
    const leaf = new WorkspaceLeaf(this, this.app);
    this.leaves.push(leaf);
    this.renderIcons();
    return leaf;
  }

  private renderIcons() {
    this.iconBarEl.innerHTML = "";
    for (const item of [...this.views, ...this.leaves] as SidebarItem[]) {
      if (this.isLeaf(item) && !item.view) continue; // no icon until a view is mounted
      const { icon, title } = this.metaOf(item);
      const btn = document.createElement("div");
      btn.className = "sidebar-icon";
      btn.textContent = icon;
      btn.title = title;
      btn.classList.toggle("is-active", item === this.active);
      btn.addEventListener("click", () => this.show(item));
      this.iconBarEl.appendChild(btn);
    }
  }

  show(item: SidebarItem) {
    this.active = item;
    this.contentEl.innerHTML = "";
    const { el } = this.metaOf(item);
    if (el) this.contentEl.appendChild(el);
    if (!this.isLeaf(item)) item.onOpen(); // fixed views (re)render on show; leaf views already opened via setView
    this.renderIcons();
    if (this.collapsed) this.toggle();
  }

  getView(viewType: string): View | null {
    return this.views.find((v) => v.viewType === viewType) ?? null;
  }

  // --- LeafContainer (docked plugin leaves) --------------------------------

  setActiveLeaf(leaf: WorkspaceLeaf) {
    this.show(leaf);
  }

  removeLeaf(leaf: WorkspaceLeaf) {
    const i = this.leaves.indexOf(leaf);
    if (i === -1) return;
    this.leaves.splice(i, 1);
    if (this.active === leaf) {
      this.active = null;
      this.contentEl.innerHTML = "";
      const fallback = this.views[0] ?? this.leaves[0];
      if (fallback) this.show(fallback);
    }
    this.renderIcons();
  }

  /** A docked leaf's view was (re)mounted — refresh its icon/title. */
  renderTabs() {
    this.renderIcons();
  }

  toggle() {
    this.collapsed = !this.collapsed;
    this.containerEl.classList.toggle("is-collapsed", this.collapsed);
  }
}

/**
 * The workspace: left/right sidebars and a horizontally-splittable row of
 * tab groups. Events: file-open(file), active-leaf-change(leaf),
 * layout-change().
 */
export class Workspace extends Events {
  rootEl: HTMLElement;
  centerEl: HTMLElement;
  leftSidebar: Sidebar;
  rightSidebar: Sidebar;
  groups: TabGroup[] = [];
  activeGroup: TabGroup;
  /** viewType -> factory, populated by `Plugin.registerView` (see plugin.ts). */
  private viewFactories = new Map<string, (leaf: WorkspaceLeaf) => View>();

  constructor(public app: App, parentEl: HTMLElement) {
    super();
    this.rootEl = document.createElement("div");
    this.rootEl.className = "workspace";
    this.leftSidebar = new Sidebar("left", this.app);
    this.rightSidebar = new Sidebar("right", this.app);
    this.centerEl = document.createElement("div");
    this.centerEl.className = "workspace-center";
    this.rootEl.appendChild(this.leftSidebar.containerEl);
    this.rootEl.appendChild(this.centerEl);
    this.rootEl.appendChild(this.rightSidebar.containerEl);
    parentEl.appendChild(this.rootEl);
    this.activeGroup = this.addGroup();
  }

  addGroup(after?: TabGroup): TabGroup {
    const group = new TabGroup(this, this.app);
    if (after) {
      const i = this.groups.indexOf(after);
      this.groups.splice(i + 1, 0, group);
      after.containerEl.after(group.containerEl);
    } else {
      this.groups.push(group);
      this.centerEl.appendChild(group.containerEl);
    }
    this.trigger("layout-change");
    return group;
  }

  groupEmptied(group: TabGroup) {
    if (this.groups.length <= 1) {
      this.app.openEmptyTab(group);
      return;
    }
    const i = this.groups.indexOf(group);
    this.groups.splice(i, 1);
    group.containerEl.remove();
    this.activeGroup = this.groups[Math.max(0, i - 1)];
    this.trigger("layout-change");
  }

  setActiveGroup(group: TabGroup) {
    this.activeGroup = group;
  }

  getActiveLeaf(): WorkspaceLeaf | null {
    return this.activeGroup.active;
  }

  /** Active file in the workspace (from the active leaf's view). */
  getActiveFile(): TFile | null {
    return this.getActiveLeaf()?.view?.getFile?.() ?? null;
  }

  /** Get a leaf for opening a file: reuse active unless newTab/pinned. */
  getLeaf(newTab: boolean): WorkspaceLeaf {
    const active = this.getActiveLeaf();
    if (!newTab && active && !active.pinned) return active;
    return this.activeGroup.createLeaf();
  }

  /** Find an open leaf already displaying the given file. */
  findLeafForFile(path: string): WorkspaceLeaf | null {
    for (const group of this.groups) {
      for (const leaf of group.leaves) {
        if (leaf.view?.getFile?.()?.path === path) return leaf;
      }
    }
    return null;
  }

  /** Find an open leaf whose view has the given `viewType` (e.g. reusing a singleton view like Graph). */
  findLeafByViewType(viewType: string): WorkspaceLeaf | null {
    for (const group of this.groups) {
      for (const leaf of group.leaves) {
        if (leaf.view?.viewType === viewType) return leaf;
      }
    }
    return null;
  }

  iterateLeaves(cb: (leaf: WorkspaceLeaf) => void) {
    for (const group of this.groups) for (const leaf of group.leaves) cb(leaf);
    // Docked plugin leaves count too, so getLeavesOfType/findLeafByViewType
    // see sidebar panes and plugins don't reopen a view they already docked.
    for (const leaf of this.leftSidebar.leaves) cb(leaf);
    for (const leaf of this.rightSidebar.leaves) cb(leaf);
  }

  // --- Plugin view registration -------------------------------------------

  /**
   * Register a factory for a plugin-provided view type. Mirrors Obsidian's
   * `Plugin.registerView(type, factory)` — plugins call this indirectly via
   * `Plugin.registerView`, which also arranges auto-unregistration.
   */
  registerViewFactory(viewType: string, factory: (leaf: WorkspaceLeaf) => View): void {
    if (this.viewFactories.has(viewType)) {
      throw new Error(`View type "${viewType}" is already registered`);
    }
    this.viewFactories.set(viewType, factory);
  }

  /** Unregister a view factory. Also detaches any currently-open leaves of that type. */
  unregisterViewFactory(viewType: string): void {
    this.viewFactories.delete(viewType);
    this.detachLeavesOfType(viewType);
  }

  getViewFactory(viewType: string): ((leaf: WorkspaceLeaf) => View) | undefined {
    return this.viewFactories.get(viewType);
  }

  /** All open leaves (across every tab group) currently showing a view of this type. */
  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.iterateLeaves((leaf) => {
      if (leaf.view?.viewType === viewType) out.push(leaf);
    });
    return out;
  }

  /** Detach (close) every open leaf of this view type. */
  detachLeavesOfType(viewType: string): void {
    for (const leaf of this.getLeavesOfType(viewType)) leaf.detach();
  }

  /**
   * Open a view registered via `registerViewFactory`/`Plugin.registerView`
   * in the main tab area. Returns null if no factory is registered for
   * `viewType`. When `newTab` is false, reuses an existing leaf of that
   * type if one is open instead of creating another.
   */
  async openViewOfType(viewType: string, newTab = true): Promise<WorkspaceLeaf | null> {
    const factory = this.viewFactories.get(viewType);
    if (!factory) return null;
    if (!newTab) {
      const existing = this.getLeavesOfType(viewType)[0];
      if (existing) {
        existing.group.setActiveLeaf(existing);
        return existing;
      }
    }
    const leaf = this.getLeaf(newTab);
    const view = factory(leaf);
    await leaf.setView(view);
    return leaf;
  }

  // --- Obsidian-compat workspace API (for hosted plugins) ------------------

  /**
   * Return a leaf docked in the right/left sidebar, matching Obsidian —
   * this is where plugins put their panes (chat, outline, etc.). The leaf
   * is hosted by the sidebar; mounting a view via `leaf.setViewState` makes
   * its icon appear, and `revealLeaf` shows it.
   */
  getRightLeaf(_split: boolean): WorkspaceLeaf {
    return this.rightSidebar.addLeaf();
  }
  getLeftLeaf(_split: boolean): WorkspaceLeaf {
    return this.leftSidebar.addLeaf();
  }

  /** Focus/activate a leaf (Obsidian `revealLeaf`); expands its sidebar if collapsed. */
  revealLeaf(leaf: WorkspaceLeaf): void {
    leaf.group.setActiveLeaf(leaf);
  }

  /** Open an internal link, delegating to the app's link handler. */
  async openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean): Promise<void> {
    await this.app.openLink(linktext, sourcePath, !!newLeaf);
  }

  /** Obsidian alias for iterating every open leaf. */
  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => void): void {
    this.iterateLeaves(cb);
  }

  /**
   * Obsidian defers plugin work until the initial layout is ready. Geode's
   * layout is constructed synchronously before plugins load, so the layout
   * is always ready — run the callback on the next microtask.
   */
  onLayoutReady(cb: () => void): void {
    Promise.resolve().then(cb);
  }

  /** Obsidian's `workspace.activeEditor` — the active editor host, or null. */
  get activeEditor(): { editor?: unknown; file?: TFile | null } | null {
    const view = this.getActiveLeaf()?.view as any;
    if (view && (view.editor || typeof view.getFile === "function")) {
      return { editor: view.editor, file: view.getFile?.() ?? null };
    }
    return null;
  }
}
