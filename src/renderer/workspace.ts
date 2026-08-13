import { Events } from "./events";
import type { App } from "./app";
import type { TFile } from "./types";
import { setIcon } from "./api/icons";

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
  /** Remove and destroy the leaf's view (calls `onClose`). */
  removeLeaf(leaf: WorkspaceLeaf): void;
  /** Detach the leaf without destroying its view — used when moving it elsewhere. */
  extractLeaf(leaf: WorkspaceLeaf): void;
  /** Adopt an already-constructed leaf (from another container) at an optional index. */
  insertLeaf(leaf: WorkspaceLeaf, index?: number): void;
  renderTabs(): void;
}

let leafIdCounter = 0;

/** The leaf currently being dragged, shared across containers during a drag-and-drop. */
let draggingLeaf: WorkspaceLeaf | null = null;

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
    this.app.workspace.trigger("layout-change");
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
    this.installDropTarget();
  }

  /** Accept a dragged leaf: dropping over the tab bar inserts at a position; over the body appends. */
  private installDropTarget() {
    const over = (e: DragEvent, el: HTMLElement) => {
      if (!draggingLeaf) return;
      e.preventDefault();
      el.classList.add("drag-over");
    };
    const leave = (el: HTMLElement) => el.classList.remove("drag-over");
    this.tabBarEl.addEventListener("dragover", (e) => over(e, this.tabBarEl));
    this.tabBarEl.addEventListener("dragleave", () => leave(this.tabBarEl));
    this.tabBarEl.addEventListener("drop", (e) => {
      leave(this.tabBarEl);
      if (!draggingLeaf) return;
      e.preventDefault();
      this.workspace.moveLeaf(draggingLeaf, this, this.dropIndex(e.clientX));
    });
    this.contentHostEl.addEventListener("dragover", (e) => over(e, this.containerEl));
    this.contentHostEl.addEventListener("dragleave", () => leave(this.containerEl));
    this.contentHostEl.addEventListener("drop", (e) => {
      leave(this.containerEl);
      if (!draggingLeaf) return;
      e.preventDefault();
      this.workspace.moveLeaf(draggingLeaf, this);
    });
  }

  /** Insertion index for a drop at horizontal position `x` over the tab bar. */
  private dropIndex(x: number): number {
    const tabs = this.leaves;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].tabEl.getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tabs.length;
  }

  createLeaf(): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this, this.app);
    this.leaves.push(leaf);
    this.setActiveLeaf(leaf);
    this.workspace.trigger("layout-change");
    return leaf;
  }

  /** Detach a leaf without destroying its view (for moves). */
  extractLeaf(leaf: WorkspaceLeaf) {
    const i = this.leaves.indexOf(leaf);
    if (i === -1) return;
    this.leaves.splice(i, 1);
    if (this.active === leaf) {
      this.active = this.leaves[Math.min(i, this.leaves.length - 1)] ?? null;
      this.contentHostEl.innerHTML = "";
      if (this.active) this.contentHostEl.appendChild(this.active.contentEl);
    }
    this.renderTabs();
  }

  /** Adopt an existing leaf (from another container) at `index` (default: end). */
  insertLeaf(leaf: WorkspaceLeaf, index?: number) {
    leaf.group = this;
    // The view element may have been mounted directly in a sidebar; put it
    // back inside the leaf's own content wrapper for tab display.
    if (leaf.view && leaf.view.containerEl.parentElement !== leaf.contentEl) {
      leaf.contentEl.appendChild(leaf.view.containerEl);
    }
    const at = index ?? this.leaves.length;
    this.leaves.splice(Math.max(0, Math.min(at, this.leaves.length)), 0, leaf);
    this.renderTabs();
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
    this.workspace.trigger("layout-change");
  }

  renderTabs() {
    this.tabBarEl.innerHTML = "";
    for (const leaf of this.leaves) {
      const tab = leaf.tabEl;
      tab.innerHTML = "";
      tab.classList.toggle("is-active", leaf === this.active);
      tab.draggable = true;
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
      tab.ondragstart = (e) => {
        draggingLeaf = leaf;
        e.dataTransfer?.setData("text/plain", leaf.id);
        tab.classList.add("is-dragging");
      };
      tab.ondragend = () => {
        draggingLeaf = null;
        tab.classList.remove("is-dragging");
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
    // Accept leaves dragged in from tab groups or the other sidebar.
    this.containerEl.addEventListener("dragover", (e) => {
      if (!draggingLeaf) return;
      e.preventDefault();
      this.containerEl.classList.add("drag-over");
    });
    this.containerEl.addEventListener("dragleave", (e) => {
      if (!this.containerEl.contains(e.relatedTarget as Node)) {
        this.containerEl.classList.remove("drag-over");
      }
    });
    this.containerEl.addEventListener("drop", (e) => {
      this.containerEl.classList.remove("drag-over");
      if (!draggingLeaf) return;
      e.preventDefault();
      this.app.workspace.moveLeaf(draggingLeaf, this);
    });
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
      setIcon(btn, icon); // render a Lucide SVG (falls back to the glyph/text for emoji)
      btn.title = title;
      btn.classList.toggle("is-active", item === this.active);
      btn.addEventListener("click", () => this.show(item));
      // Docked plugin panes can be dragged out to a tab group or the other sidebar.
      if (this.isLeaf(item)) {
        const leaf = item;
        btn.draggable = true;
        btn.addEventListener("dragstart", (e) => {
          draggingLeaf = leaf;
          e.dataTransfer?.setData("text/plain", leaf.id);
          btn.classList.add("is-dragging");
        });
        btn.addEventListener("dragend", () => {
          draggingLeaf = null;
          btn.classList.remove("is-dragging");
        });
      }
      this.iconBarEl.appendChild(btn);
    }
    const collapseBtn = document.createElement("div");
    collapseBtn.className = "sidebar-icon sidebar-collapse-btn";
    setIcon(collapseBtn, this.side === "left" ? "panel-left" : "panel-right");
    collapseBtn.title = this.collapsed ? "Expand sidebar" : "Collapse sidebar";
    collapseBtn.addEventListener("click", () => this.toggle());
    this.iconBarEl.appendChild(collapseBtn);
  }

  show(item: SidebarItem) {
    this.active = item;
    this.contentEl.innerHTML = "";
    const { el } = this.metaOf(item);
    if (el) this.contentEl.appendChild(el);
    if (!this.isLeaf(item)) item.onOpen(); // fixed views (re)render on show; leaf views already opened via setView
    this.renderIcons();
    if (this.collapsed) this.toggle();
    this.app.workspace.trigger("layout-change");
  }

  getView(viewType: string): View | null {
    return this.views.find((v) => v.viewType === viewType) ?? null;
  }

  // --- LeafContainer (docked plugin leaves) --------------------------------

  setActiveLeaf(leaf: WorkspaceLeaf) {
    this.show(leaf);
  }

  removeLeaf(leaf: WorkspaceLeaf) {
    this.extractLeaf(leaf);
    this.app.workspace.trigger("layout-change");
  }

  /** Remove a docked leaf, falling back to another pane if it was showing. */
  extractLeaf(leaf: WorkspaceLeaf) {
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

  /** Adopt an existing leaf, docking it in this sidebar. */
  insertLeaf(leaf: WorkspaceLeaf, _index?: number) {
    leaf.group = this;
    if (!this.leaves.includes(leaf)) this.leaves.push(leaf);
    this.renderIcons();
  }

  /** A docked leaf's view was (re)mounted — refresh its icon/title. */
  renderTabs() {
    this.renderIcons();
  }

  toggle() {
    this.collapsed = !this.collapsed;
    this.containerEl.classList.toggle("is-collapsed", this.collapsed);
    this.renderIcons();
  }
}

/** One serialized leaf in the persisted workspace layout. */
export interface PersistedLeaf {
  type: string;
  /** For markdown views: the file path. */
  file?: string;
  /** For plugin views: the view's serialized state (from `getViewState`). */
  state?: unknown;
  pinned?: boolean;
}

interface PersistedSidebar {
  leaves: PersistedLeaf[];
  activeType: string | null;
  collapsed: boolean;
}

/** The whole persisted workspace layout, stored per-vault in `.geode/workspace.json`. */
export interface PersistedWorkspace {
  version: 1;
  groups: { leaves: PersistedLeaf[]; active: number }[];
  activeGroup: number;
  left: PersistedSidebar;
  right: PersistedSidebar;
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

  private layoutReadyCbs: (() => void)[] = [];
  private layoutReady = false;

  /**
   * Obsidian defers plugin work until the initial layout is ready — crucially,
   * *after* the saved workspace is restored, so a plugin's `onLayoutReady`
   * (which typically opens its view, reusing any existing leaf of that type)
   * reuses the restored pane instead of creating a duplicate. Geode mirrors
   * that: callbacks queue until `flushLayoutReady()` is called post-restore.
   */
  onLayoutReady(cb: () => void): void {
    if (this.layoutReady) Promise.resolve().then(cb);
    else this.layoutReadyCbs.push(cb);
  }

  /** Fire queued `onLayoutReady` callbacks. Called once by App after layout restore. */
  flushLayoutReady(): void {
    this.layoutReady = true;
    for (const cb of this.layoutReadyCbs.splice(0)) {
      try {
        cb();
      } catch (err) {
        console.error("Error in onLayoutReady callback", err);
      }
    }
  }

  /** Obsidian's `workspace.activeEditor` — the active editor host, or null. */
  get activeEditor(): { editor?: unknown; file?: TFile | null } | null {
    const view = this.getActiveLeaf()?.view as any;
    if (view && (view.editor || typeof view.getFile === "function")) {
      return { editor: view.editor, file: view.getFile?.() ?? null };
    }
    return null;
  }

  // --- Drag-and-drop leaf moves --------------------------------------------

  /**
   * Move `leaf` into `target` (a tab group or a sidebar), at optional index.
   * Reorders within the same tab group, or relocates the leaf — and its live
   * view — across containers without destroying it. An emptied source tab
   * group is cleaned up.
   */
  moveLeaf(leaf: WorkspaceLeaf, target: LeafContainer, index?: number): void {
    const from = leaf.group;
    if (from === target && target instanceof TabGroup) {
      const arr = target.leaves;
      const cur = arr.indexOf(leaf);
      if (cur === -1) return;
      let ins = index ?? arr.length;
      if (ins > cur) ins -= 1; // account for the slot we're vacating
      arr.splice(cur, 1);
      arr.splice(Math.max(0, Math.min(ins, arr.length)), 0, leaf);
      target.renderTabs();
    } else if (from !== target) {
      from.extractLeaf(leaf);
      target.insertLeaf(leaf, index);
      target.setActiveLeaf(leaf);
      if (from instanceof TabGroup && from.leaves.length === 0) this.groupEmptied(from);
    }
    this.trigger("layout-change");
  }

  // --- Layout persistence --------------------------------------------------

  private serializeLeaf(leaf: WorkspaceLeaf): PersistedLeaf | null {
    const v = leaf.view;
    if (!v) return null;
    // Empty/placeholder tabs (and markdown tabs whose file vanished) aren't
    // worth persisting — and persisting them caused empties to accumulate
    // across launches (restore recreated them, then a fresh one was added).
    if (v.viewType === "empty") return null;
    if (v.viewType === "markdown") {
      const file = v.getFile?.()?.path;
      return file ? { type: "markdown", file, pinned: leaf.pinned } : null;
    }
    return { type: v.viewType, state: leaf.getViewState().state, pinned: leaf.pinned };
  }

  private serializeSidebar(sb: Sidebar): PersistedSidebar {
    return {
      leaves: sb.leaves
        .map((l) => this.serializeLeaf(l))
        .filter((l): l is PersistedLeaf => !!l && l.type !== "empty"),
      activeType: sb.active instanceof WorkspaceLeaf ? (sb.active.view?.viewType ?? null) : null,
      collapsed: sb.collapsed,
    };
  }

  /** Snapshot the current layout for persistence. Empty tabs/groups are dropped. */
  serialize(): PersistedWorkspace {
    const groups: { leaves: PersistedLeaf[]; active: number }[] = [];
    let activeGroup = 0;
    for (const g of this.groups) {
      // Keep leaves and their persisted form paired so the active index maps
      // correctly after empties are filtered out.
      const kept = g.leaves
        .map((l) => ({ leaf: l, ser: this.serializeLeaf(l) }))
        .filter((x): x is { leaf: WorkspaceLeaf; ser: PersistedLeaf } => !!x.ser);
      if (!kept.length) continue; // skip all-empty groups
      if (g === this.activeGroup) activeGroup = groups.length;
      const activeIdx = Math.max(0, kept.findIndex((x) => x.leaf === g.active));
      groups.push({ leaves: kept.map((x) => x.ser), active: activeIdx });
    }
    return {
      version: 1,
      groups,
      activeGroup,
      left: this.serializeSidebar(this.leftSidebar),
      right: this.serializeSidebar(this.rightSidebar),
    };
  }

  private async restoreLeafView(leaf: WorkspaceLeaf, ls: PersistedLeaf): Promise<void> {
    if (ls.type === "markdown" && ls.file) {
      const file = this.app.vault.getFileByPath(ls.file);
      if (file) {
        const view = this.app.createMarkdownView();
        await view.setFile(file);
        await leaf.setView(view);
      } else {
        await leaf.setView(this.app.createEmptyView());
      }
    } else if (ls.type === "empty") {
      await leaf.setView(this.app.createEmptyView());
    } else if (this.getViewFactory(ls.type)) {
      await leaf.setViewState({ type: ls.type, state: ls.state });
    } else {
      // Plugin providing this view type isn't installed/enabled — leave empty.
      await leaf.setView(this.app.createEmptyView());
    }
    if (ls.pinned) leaf.pinned = true;
  }

  private async restoreSidebar(sb: Sidebar, ps: PersistedSidebar): Promise<void> {
    for (const ls of ps.leaves) {
      if (!this.getViewFactory(ls.type)) continue; // plugin absent
      const leaf = sb.addLeaf();
      await leaf.setViewState({ type: ls.type, state: ls.state });
    }
    if (ps.activeType) {
      const l = sb.leaves.find((x) => x.view?.viewType === ps.activeType);
      if (l) sb.setActiveLeaf(l);
    }
    if (ps.collapsed && !sb.collapsed) sb.toggle();
  }

  /**
   * Rebuild the layout from a persisted snapshot. Returns false (restoring
   * nothing) if the snapshot has no real content, so the caller can fall
   * back to opening an empty tab.
   */
  async deserialize(state: PersistedWorkspace): Promise<boolean> {
    const hasContent =
      (state?.groups?.some((g) => g.leaves.length) ?? false) ||
      !!state?.left?.leaves.length ||
      !!state?.right?.leaves.length;
    if (!hasContent) return false;

    // Rebuild the (non-empty) tab groups. Groups the snapshot didn't include
    // are added as needed; a restored group that ends up empty gets exactly
    // one placeholder tab (never accumulating empties across launches).
    const targetGroups = Math.max(1, state.groups.length);
    while (this.groups.length < targetGroups) this.addGroup();
    for (let gi = 0; gi < this.groups.length; gi++) {
      const group = this.groups[gi];
      const gs = state.groups[gi];
      if (gs) {
        for (const ls of gs.leaves) {
          const leaf = group.createLeaf();
          await this.restoreLeafView(leaf, ls);
        }
      }
      if (group.leaves.length === 0) {
        const leaf = group.createLeaf();
        await leaf.setView(this.app.createEmptyView());
      }
      const active = (gs && group.leaves[gs.active]) || group.leaves[0];
      if (active) group.setActiveLeaf(active);
    }
    await this.restoreSidebar(this.leftSidebar, state.left);
    await this.restoreSidebar(this.rightSidebar, state.right);
    const ag = this.groups[state.activeGroup] ?? this.groups[0];
    if (ag?.active) ag.setActiveLeaf(ag.active);
    return true;
  }
}
