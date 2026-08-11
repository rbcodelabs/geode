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

let leafIdCounter = 0;

/** A leaf is one tab: a container that hosts a single view. */
export class WorkspaceLeaf {
  id = `leaf-${++leafIdCounter}`;
  view: View | null = null;
  tabEl: HTMLElement;
  contentEl: HTMLElement;
  pinned = false;

  constructor(
    public group: TabGroup,
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

/** A sidebar dock: icon strip + one visible view at a time. */
export class Sidebar {
  containerEl: HTMLElement;
  iconBarEl: HTMLElement;
  contentEl: HTMLElement;
  views: View[] = [];
  active: View | null = null;
  collapsed = false;

  constructor(public side: "left" | "right") {
    this.containerEl = document.createElement("div");
    this.containerEl.className = `workspace-sidebar mod-${side}`;
    this.iconBarEl = document.createElement("div");
    this.iconBarEl.className = "sidebar-icon-bar";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "sidebar-content";
    this.containerEl.appendChild(this.iconBarEl);
    this.containerEl.appendChild(this.contentEl);
  }

  addView(view: View) {
    this.views.push(view);
    const btn = document.createElement("div");
    btn.className = "sidebar-icon";
    btn.textContent = view.getIcon();
    btn.title = view.getDisplayText();
    btn.dataset.viewType = view.viewType;
    btn.addEventListener("click", () => this.show(view));
    this.iconBarEl.appendChild(btn);
    if (!this.active) this.show(view);
  }

  show(view: View) {
    this.active = view;
    this.contentEl.innerHTML = "";
    this.contentEl.appendChild(view.containerEl);
    view.onOpen();
    for (const icon of [...this.iconBarEl.children] as HTMLElement[]) {
      icon.classList.toggle("is-active", icon.dataset.viewType === view.viewType);
    }
    if (this.collapsed) this.toggle();
  }

  getView(viewType: string): View | null {
    return this.views.find((v) => v.viewType === viewType) ?? null;
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
    this.leftSidebar = new Sidebar("left");
    this.rightSidebar = new Sidebar("right");
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

  iterateLeaves(cb: (leaf: WorkspaceLeaf) => void) {
    for (const group of this.groups) for (const leaf of group.leaves) cb(leaf);
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
}
