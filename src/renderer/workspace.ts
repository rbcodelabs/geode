import { Events } from "./events";
import type { App } from "./app";
import type { TFile } from "./types";
import { setIcon } from "./api/icons";
import { markStart, markEnd } from "./perf-instrumentation";
import { DeferredView, isDeferredView } from "./views/deferred-view";

export interface View {
  readonly viewType: string;
  containerEl: HTMLElement;
  getDisplayText(): string;
  getIcon(): string;
  onOpen(): void | Promise<void>;
  onClose(): void | Promise<void>;
  /** Serialized state for WorkspaceLeaf.getViewState(). */
  getState?(): unknown;
  /** Optional visibility callback; unlike onOpen, may run whenever a tab is revealed. */
  onReveal?(): void;
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
  /**
   * Distinguishes a docked-sidebar container from a main-area tab group
   * without a cross-module `instanceof` (which would force an
   * obsidian.ts -> workspace.ts import cycle). Used by views to decide
   * whether to render main-pane-only chrome such as the back/forward
   * navigation buttons. `Sidebar` sets `true`, `TabGroup` sets `false`.
   */
  readonly isSidebar: boolean;
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
  /** Obsidian's `.workspace-leaf` wrapper: hosts `contentEl` when mounted into a tab group. */
  leafEl: HTMLElement;
  contentEl: HTMLElement;
  pinned = false;
  private opened = false;

  constructor(
    public group: LeafContainer,
    public app: App
  ) {
    this.tabEl = document.createElement("div");
    this.tabEl.className = "workspace-tab-header";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "workspace-leaf-content";
    this.leafEl = document.createElement("div");
    this.leafEl.className = "workspace-leaf mod-active";
    this.leafEl.appendChild(this.contentEl);
  }

  async setView(view: View): Promise<void> {
    markStart("view-mount");
    try {
      if (this.view && this.opened) await this.view.onClose();
      this.view = view;
      this.opened = false;
      this.contentEl.innerHTML = "";
      this.contentEl.dataset.type = view.viewType;
      // A `DeferredView` impersonates its persisted `viewType`, so `data-type`
      // alone can't tell a placeholder from the real thing. This class is the
      // distinguishing hook (used by CSS and by E2E selectors).
      this.contentEl.classList.toggle("mod-deferred", isDeferredView(view));
      this.contentEl.appendChild(view.containerEl);
      await view.onOpen();
      this.opened = true;
      this.group.renderTabs();
      if (view.getFile?.()) {
        this.app.workspace.trigger("file-open", view.getFile!());
      }
      this.app.workspace.trigger("layout-change");
    } finally {
      markEnd("view-mount");
    }
  }

  getDisplayText(): string {
    return this.view?.getDisplayText() ?? "New tab";
  }

  /** Lazily open built-in leaves the first time they become visible. */
  async ensureOpen(): Promise<void> {
    if (!this.view || this.opened) return;
    await this.view.onOpen();
    this.opened = true;
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
    if ("state" in state && typeof (view as any).setState === "function") {
      await (view as any).setState(state.state, {});
    }
    if (state.active) this.group.setActiveLeaf(this);
  }

  getViewState(): { type: string; state?: unknown } {
    return {
      type: this.view?.viewType ?? this.viewState.type,
      state: this.view?.getState?.() ?? this.viewState.state,
    };
  }

  /** Mount an existing view in this leaf and return it after opening. */
  async open(view: View): Promise<View> {
    await this.setView(view);
    return view;
  }

  /** Pin or unpin this leaf without recreating its view. */
  setPinned(pinned: boolean): void {
    if (this.pinned === pinned) return;
    this.pinned = pinned;
    this.group.renderTabs();
    this.app.workspace.trigger("layout-change");
  }

  /** Toggle this leaf's pinned state (Obsidian-compatible plugin API). */
  togglePinned(): void {
    this.setPinned(!this.pinned);
  }

  /**
   * Update this leaf's persisted view state in place, without recreating
   * the view (unlike calling `setViewState` again). For views whose state
   * changes after mount as a side effect of user interaction — e.g.
   * `WebView` tracking navigation — so session restore (`Workspace.serialize`,
   * which reads `getViewState().state`) reflects the current state rather
   * than only the state the view was first opened with.
   */
  setPersistedState(state: unknown): void {
    this.viewState.state = state;
  }

  /**
   * The last state explicitly handed to `setViewState`/`setPersistedState`,
   * bypassing the live view. The fallback when a view's own `getState()`
   * throws during teardown — see `Workspace.captureLeafForDeferral`.
   */
  getPersistedState(): unknown {
    return this.viewState.state;
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
    // ItemView (api/obsidian.ts) exposes this to refresh its own
    // `.view-header-title` text; duck-typed rather than imported to avoid a
    // workspace.ts <-> obsidian.ts circular dependency.
    (this.view as { refreshHeaderTitle?(): void } | null)?.refreshHeaderTitle?.();
  }

  private _tabTitleEl?: HTMLElement;
  /** Obsidian's inner tab-title element. Geode rebuilds tab DOM on each render, so this is a stable scratch element plugins can write to without crashing. */
  get tabHeaderInnerTitleEl(): HTMLElement {
    if (!this._tabTitleEl) this._tabTitleEl = document.createElement("span");
    return this._tabTitleEl;
  }

  async detach(): Promise<void> {
    // "leaf-detach" is marked here rather than (also) inside
    // TabGroup.removeLeaf/Sidebar.removeLeaf below, since removeLeaf is only
    // ever reached via this method -- double-wrapping the same op name would
    // nest two markStart("leaf-detach") calls under the same fixed mark
    // names and corrupt the measured duration. This boundary also captures
    // the full user-facing cost of closing a tab, including view teardown.
    markStart("leaf-detach");
    try {
      if (this.opened) await this.view?.onClose();
      this.opened = false;
      this.group.removeLeaf(this);
    } finally {
      markEnd("leaf-detach");
    }
  }
}

/**
 * `.view-header-nav-buttons` (back/forward), shared by `ItemView`
 * (api/obsidian.ts) and `MarkdownView` (views/markdown-view.ts). Geode's
 * `Workspace` has no navigation history to wire these to yet, so they render
 * as inert placeholders — real DOM/class shape for themes to style, but
 * disabled and inert rather than silently doing nothing on click. Follow-up:
 * wire to a real back/forward history once `Workspace` tracks one.
 */
export function buildViewHeaderNavButtons(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "view-header-nav-buttons";
  for (const [icon, label] of [
    ["arrow-left", "Navigate back"],
    ["arrow-right", "Navigate forward"],
  ] as const) {
    const btn = document.createElement("div");
    btn.className = "clickable-icon view-action nav-action-button";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-disabled", "true");
    setIcon(btn, icon);
    wrap.appendChild(btn);
  }
  return wrap;
}

/**
 * Build (or rebuild) `leaf.tabEl`'s contents to match real Obsidian's tab
 * header DOM: `.workspace-tab-header[data-type][aria-label]` >
 * `.workspace-tab-header-inner` (icon + title + close button) plus a sibling
 * `.workspace-tab-header-status-container` (pin icon). Shared by `TabGroup`
 * and `Sidebar` so both main-area tabs and docked panes expose the same
 * class names for community themes to target. Caller wires up drag/drop and
 * click handlers afterward — this only builds the static structure.
 */
function buildTabHeader(leaf: WorkspaceLeaf, isActive: boolean): HTMLElement {
  const tab = leaf.tabEl;
  tab.innerHTML = "";
  tab.className = "workspace-tab-header";
  tab.classList.toggle("is-active", isActive);
  tab.classList.toggle("mod-pinned", leaf.pinned);
  tab.dataset.type = leaf.view?.viewType ?? "empty";
  tab.setAttribute("aria-label", leaf.getDisplayText());

  const inner = document.createElement("div");
  inner.className = "workspace-tab-header-inner";

  const icon = document.createElement("div");
  icon.className = "workspace-tab-header-inner-icon";
  if (leaf.view) setIcon(icon, leaf.view.getIcon());

  const title = document.createElement("div");
  title.className = "workspace-tab-header-inner-title";
  title.textContent = leaf.getDisplayText();

  const close = document.createElement("div");
  close.className = "workspace-tab-header-inner-close-button";
  close.setAttribute("aria-label", "Close");
  setIcon(close, "x");
  close.addEventListener("mousedown", (e) => e.stopPropagation());
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    leaf.detach();
  });

  inner.append(icon, title, close);

  const status = document.createElement("div");
  status.className = "workspace-tab-header-status-container";
  if (leaf.pinned) {
    const pin = document.createElement("div");
    pin.className = "workspace-tab-header-status-icon mod-pinned";
    setIcon(pin, "pin");
    status.appendChild(pin);
  }

  tab.append(inner, status);
  return tab;
}

/** A group of tabs sharing one content area. */
export class TabGroup implements LeafContainer {
  readonly isSidebar: boolean;
  leaves: WorkspaceLeaf[] = [];
  active: WorkspaceLeaf | null = null;
  containerEl: HTMLElement;
  /** `.workspace-tab-header-container` — the whole header bar (scrollable inner row + tab-list/new-tab). */
  tabBarEl: HTMLElement;
  /** `.workspace-tab-header-container-inner` — the scrollable row that actually holds the tab headers. */
  tabHeaderInnerEl: HTMLElement;
  contentHostEl: HTMLElement;
  /** Left-sidebar toggle button, first child of `tabBarEl` (only meaningful/visible on the leftmost group). */
  leftToggleEl: HTMLElement;
  /** Right-sidebar toggle button, last child of `tabBarEl` (only meaningful/visible on the rightmost group). */
  rightToggleEl: HTMLElement;
  private bodyDropEdge: "left" | "right" | "top" | "bottom" | null = null;

  constructor(
    public workspace: Workspace,
    public app: App,
    public sidebar?: Sidebar
  ) {
    this.isSidebar = !!sidebar;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-tabs mod-top";
    if (sidebar) this.containerEl.classList.add("sidebar-tab-group");
    this.tabBarEl = document.createElement("div");
    this.tabBarEl.className = "workspace-tab-header-container";
    this.tabHeaderInnerEl = document.createElement("div");
    this.tabHeaderInnerEl.className = "workspace-tab-header-container-inner";

    // Left sidebar toggle: first child of the tab bar, outside the
    // collapsible sidebar itself so it stays clickable when the sidebar
    // shrinks to width 0 (the reason for this whole change — see the
    // `Sidebar.toggle()`/CSS comments for context).
    this.leftToggleEl = document.createElement("div");
    this.leftToggleEl.className = "clickable-icon sidebar-toggle-button mod-left";
    setIcon(this.leftToggleEl, "panel-left");
    this.leftToggleEl.addEventListener("click", () => this.workspace.leftSidebar.toggle());
    this.tabBarEl.appendChild(this.leftToggleEl);

    this.tabBarEl.appendChild(this.tabHeaderInnerEl);

    const tabList = document.createElement("div");
    tabList.className = "workspace-tab-header-tab-list";
    const tabListIcon = document.createElement("div");
    tabListIcon.className = "clickable-icon";
    tabListIcon.title = "All tabs";
    setIcon(tabListIcon, "chevron-down");
    tabListIcon.addEventListener("click", (event) => {
      event.stopPropagation();
      const items = this.leaves.map((leaf) => ({
        title: leaf.getDisplayText(),
        icon: leaf.view?.getIcon() ?? "file",
        checked: leaf === this.active,
        section: "tabs",
        action: () => this.setActiveLeaf(leaf),
      }));
      // Spec: tab-group dropdown → "Bookmark [N] tabs".
      items.push({
        title: `Bookmark ${this.leaves.length} tab${this.leaves.length === 1 ? "" : "s"}`,
        icon: "bookmark",
        checked: false,
        section: "bookmark",
        action: () => void this.app.bookmarkLeaves(this.leaves),
      });
      this.app.showMenu(event, items, {
        anchor: tabListIcon,
        horizontalAlign: "end",
        menuClass: "mod-tab-list",
      });
    });
    tabList.appendChild(tabListIcon);
    this.tabBarEl.appendChild(tabList);

    const newTab = document.createElement("div");
    newTab.className = "workspace-tab-header-new-tab";
    const newTabIcon = document.createElement("div");
    newTabIcon.className = "clickable-icon";
    newTabIcon.title = "New tab";
    setIcon(newTabIcon, "plus");
    newTabIcon.addEventListener("click", () => this.app.openEmptyTab(this));
    newTab.appendChild(newTabIcon);
    this.tabBarEl.appendChild(newTab);

    // Right sidebar toggle: last child of the tab bar.
    this.rightToggleEl = document.createElement("div");
    this.rightToggleEl.className = "clickable-icon sidebar-toggle-button mod-right";
    setIcon(this.rightToggleEl, "panel-right");
    this.rightToggleEl.addEventListener("click", () => this.workspace.rightSidebar.toggle());
    this.tabBarEl.appendChild(this.rightToggleEl);

    this.contentHostEl = document.createElement("div");
    this.contentHostEl.className = "workspace-tab-container";
    this.containerEl.appendChild(this.tabBarEl);
    this.containerEl.appendChild(this.contentHostEl);
    if (sidebar) {
      this.leftToggleEl.hidden = true;
      this.rightToggleEl.hidden = true;
      tabList.hidden = true;
      newTab.hidden = true;
    }
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
    this.contentHostEl.addEventListener("dragover", (e) => {
      if (!draggingLeaf) return;
      over(e, this.containerEl);
      const rect = this.contentHostEl.getBoundingClientRect();
      const x = (e.clientX - rect.left) / Math.max(1, rect.width);
      const y = (e.clientY - rect.top) / Math.max(1, rect.height);
      this.bodyDropEdge = x < 0.2 ? "left" : x > 0.8 ? "right" : y < 0.2 ? "top" : y > 0.8 ? "bottom" : null;
      this.containerEl.dataset.dropTarget = this.bodyDropEdge ?? "tabs";
    });
    this.contentHostEl.addEventListener("dragleave", () => {
      leave(this.containerEl);
      delete this.containerEl.dataset.dropTarget;
    });
    this.contentHostEl.addEventListener("drop", (e) => {
      leave(this.containerEl);
      if (!draggingLeaf) return;
      e.preventDefault();
      if (this.bodyDropEdge) {
        if (this.sidebar) {
          const placeholder = this.sidebar.addSplitGroup(this.bodyDropEdge === "top" ? "top" : "bottom");
          const target = placeholder.group;
          target.extractLeaf(placeholder);
          this.workspace.moveLeaf(draggingLeaf, target);
        } else {
          const target = this.workspace.addGroup(this.bodyDropEdge === "left" || this.bodyDropEdge === "top" ? undefined : this);
          this.workspace.moveLeaf(draggingLeaf, target);
        }
      } else {
        this.workspace.moveLeaf(draggingLeaf, this);
      }
      this.bodyDropEdge = null;
      delete this.containerEl.dataset.dropTarget;
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
    markStart("leaf-create");
    try {
      const leaf = new WorkspaceLeaf(this, this.app);
      this.leaves.push(leaf);
      this.setActiveLeaf(leaf);
      this.workspace.trigger("layout-change");
      return leaf;
    } finally {
      markEnd("leaf-create");
    }
  }

  /** Detach a leaf without destroying its view (for moves). */
  extractLeaf(leaf: WorkspaceLeaf) {
    const i = this.leaves.indexOf(leaf);
    if (i === -1) return;
    this.leaves.splice(i, 1);
    if (this.active === leaf) {
      this.active = this.leaves[Math.min(i, this.leaves.length - 1)] ?? null;
      this.contentHostEl.innerHTML = "";
      if (this.active) this.contentHostEl.appendChild(this.active.leafEl);
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
    markStart("leaf-activate");
    try {
      this.active = leaf;
      this.contentHostEl.innerHTML = "";
      this.contentHostEl.appendChild(leaf.leafEl);
      void leaf.ensureOpen();
      this.renderTabs();
      if (!this.sidebar) this.workspace.activeGroup = this;
      this.workspace.trigger("active-leaf-change", leaf);
      const file = leaf.view?.getFile?.();
      if (file) this.workspace.trigger("file-open", file);
    } finally {
      markEnd("leaf-activate");
    }
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
    this.tabHeaderInnerEl.innerHTML = "";
    for (const leaf of this.leaves) {
      const tab = buildTabHeader(leaf, leaf === this.active);
      tab.draggable = true;
      tab.onmousedown = (e) => {
        if (e.button === 1) leaf.detach();
        else this.setActiveLeaf(leaf);
      };
      tab.oncontextmenu = (e) => this.app.showTabContextMenu(e, leaf);
      tab.ondragstart = (e) => {
        draggingLeaf = leaf;
        e.dataTransfer?.setData("text/plain", leaf.id);
        tab.classList.add("is-dragging");
      };
      tab.ondragend = () => {
        draggingLeaf = null;
        tab.classList.remove("is-dragging");
      };
      this.tabHeaderInnerEl.appendChild(tab);
    }
    const spacer = document.createElement("div");
    spacer.className = "workspace-tab-header-spacer";
    this.tabHeaderInnerEl.appendChild(spacer);
  }
}

/** One entry shown in a sidebar: either a built-in fixed `View` or a docked plugin `WorkspaceLeaf`. */
type SidebarItem = View | WorkspaceLeaf;

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 600;

/**
 * A sidebar dock: an icon strip plus one visible pane at a time. It hosts
 * both Geode's built-in fixed views (file explorer, search, backlinks, …)
 * and — implementing `LeafContainer` — plugin `WorkspaceLeaf`s, so hosted
 * Obsidian plugins can dock their panes here (`getRightLeaf`/`getLeftLeaf`
 * + `revealLeaf`) exactly like real Obsidian.
 */
export class Sidebar implements LeafContainer {
  readonly isSidebar = true;
  containerEl: HTMLElement;
  /** `.workspace-tab-header-container` — the docked-pane tab strip (Obsidian's real sidebar DOM). */
  tabHeaderContainerEl: HTMLElement;
  /** `.workspace-tab-header-container-inner` — the row holding the `.workspace-tab-header` icons. */
  tabHeaderInnerEl: HTMLElement;
  contentEl: HTMLElement;
  resizeHandleEl: HTMLElement;
  views: View[] = [];
  leaves: WorkspaceLeaf[] = [];
  /** Vertically stacked leaf containers; the legacy sidebar itself is the first group. */
  groups: LeafContainer[] = [this];
  groupSizes: number[] = [1];
  private groupDividers: HTMLElement[] = [];
  active: SidebarItem | null = null;
  collapsed = false;
  width: number = SIDEBAR_DEFAULT_WIDTH;
  private dragging = false;
  private splitDrop: "top" | "bottom" | null = null;
  private dragStartX = 0;
  private dragStartWidth = 0;

  constructor(
    public side: "left" | "right",
    public app: App
  ) {
    this.containerEl = document.createElement("div");
    // Alongside Geode's own `.workspace-sidebar mod-${side}` (which existing
    // selectors/tests key on), carry Obsidian's real sidedock container hooks
    // so `.mod-${side}-split` / `.workspace-split.mod-sidedock` descendant
    // rules (and community themes) apply here exactly as in Obsidian.
    this.containerEl.className =
      `workspace-sidebar mod-${side} mod-${side}-split workspace-split mod-sidedock`;
    this.tabHeaderContainerEl = document.createElement("div");
    this.tabHeaderContainerEl.className = "workspace-tab-header-container";
    this.tabHeaderInnerEl = document.createElement("div");
    this.tabHeaderInnerEl.className = "workspace-tab-header-container-inner";
    this.tabHeaderContainerEl.appendChild(this.tabHeaderInnerEl);
    this.contentEl = document.createElement("div");
    this.contentEl.className = "sidebar-content";
    this.tabHeaderContainerEl.parentElement?.classList.add("sidebar-tab-group");
    this.containerEl.appendChild(this.tabHeaderContainerEl);
    this.containerEl.appendChild(this.contentEl);
    // Accept leaves dragged in from tab groups or the other sidebar.
    this.containerEl.addEventListener("dragover", (e) => {
      if (!draggingLeaf) return;
      e.preventDefault();
      this.containerEl.classList.add("drag-over");
      const rect = this.containerEl.getBoundingClientRect();
      const relative = (e.clientY - rect.top) / Math.max(1, rect.height);
      this.splitDrop = relative < 0.25 ? "top" : relative > 0.75 ? "bottom" : null;
      this.containerEl.dataset.dropTarget = this.splitDrop ?? "tabs";
    });
    this.containerEl.addEventListener("dragleave", (e) => {
      if (!this.containerEl.contains(e.relatedTarget as Node)) {
        this.containerEl.classList.remove("drag-over");
        delete this.containerEl.dataset.dropTarget;
      }
    });
    this.containerEl.addEventListener("drop", (e) => {
      this.containerEl.classList.remove("drag-over");
      if (!draggingLeaf) return;
      e.preventDefault();
      if (this.splitDrop) {
        const placeholder = this.addSplitGroup(this.splitDrop);
        const target = placeholder.group;
        target.extractLeaf(placeholder);
        this.app.workspace.moveLeaf(draggingLeaf, target);
      } else {
        this.app.workspace.moveLeaf(draggingLeaf, this);
      }
      this.splitDrop = null;
      delete this.containerEl.dataset.dropTarget;
    });
    this.resizeHandleEl = document.createElement("div");
    this.resizeHandleEl.className = "sidebar-resize-handle";
    this.containerEl.appendChild(this.resizeHandleEl);
    this.attachResizeHandle();
    this.containerEl.classList.add("sidebar-tab-group");
  }

  private endDrag(): void {
    this.containerEl.classList.remove("is-resizing");
    this.dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  /**
   * Drag-to-resize via the thin strip at the sidebar's inner edge. Mirrors
   * the shape of `graph-view.ts`'s `attachInteraction()`: `mousedown` starts
   * the drag on the handle itself, but `mousemove`/`mouseup` are bound to
   * `window` (not the handle) so the drag survives the cursor leaving the
   * 6px-wide strip mid-gesture.
   */
  private attachResizeHandle(): void {
    this.resizeHandleEl.addEventListener("mousedown", (e) => {
      if (this.collapsed) return;
      e.preventDefault();
      this.dragging = true;
      this.dragStartX = e.clientX;
      this.dragStartWidth = this.width;
      this.containerEl.classList.add("is-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragStartX;
      const delta = this.side === "left" ? dx : -dx;
      this.setWidth(this.dragStartWidth + delta);
    });

    window.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.endDrag();
      this.app.workspace.trigger("layout-change");
    });
  }

  setWidth(px: number): void {
    const effectiveMax = Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth * 0.5);
    this.width = Math.min(Math.max(px, SIDEBAR_MIN_WIDTH), effectiveMax);
    this.containerEl.style.setProperty("--sidebar-width", `${this.width}px`);
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

  get defaultGroup(): LeafContainer {
    return this.groups[0];
  }

  addView(view: View) {
    // Built-ins have no registered factory — they're constructed once here at
    // boot and matched during restore by the `existingBuiltin` lookup. Record
    // the type so restore never mints a deferred placeholder for it (see
    // `Workspace.isDeferrableViewType`). Registering here rather than from a
    // hardcoded list keeps the set authoritative as built-ins come and go.
    this.app.workspace.registerBuiltinViewType(view.viewType);
    this.views.push(view);
    const leaf = new WorkspaceLeaf(this, this.app);
    leaf.view = view;
    leaf.contentEl.dataset.type = view.viewType;
    leaf.contentEl.appendChild(view.containerEl);
    this.leaves.push(leaf);
    this.renderIcons();
    if (!this.active) this.setActiveLeaf(leaf);
  }

  /** Create a vertically stacked tab group and its first reusable empty leaf. */
  addSplitGroup(position: "top" | "bottom" = "bottom"): WorkspaceLeaf {
    const group = new TabGroup(this.app.workspace, this.app, this);
    const divider = document.createElement("div");
    divider.className = "workspace-split-resize-handle";
    this.containerEl.insertBefore(divider, this.resizeHandleEl);
    this.containerEl.insertBefore(group.containerEl, this.resizeHandleEl);
    const index = position === "top" ? 0 : this.groups.length;
    this.groups.splice(index, 0, group);
    this.groupDividers.push(divider);
    this.groupSizes = this.groups.map(() => 1 / this.groups.length);
    this.layoutGroups();
    this.attachGroupResize(divider);
    return group.createLeaf();
  }

  private groupContentElement(group: LeafContainer): HTMLElement {
    return group === this ? this.contentEl : (group as TabGroup).containerEl;
  }

  private layoutGroups(): void {
    this.groups.forEach((group, index) => {
      if (group === this) {
        this.tabHeaderContainerEl.style.order = `${index * 2}`;
        this.contentEl.style.order = `${index * 2}`;
      } else {
        (group as TabGroup).containerEl.style.order = `${index * 2}`;
      }
    });
    this.groupDividers.forEach((divider, index) => { divider.style.order = `${index * 2 + 1}`; });
  }

  private attachGroupResize(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const dividerIndex = this.groupDividers.indexOf(handle);
      const upper = this.groupContentElement(this.groups[dividerIndex]);
      const lower = this.groupContentElement(this.groups[dividerIndex + 1]);
      const startY = event.clientY;
      const upperStart = upper.getBoundingClientRect().height;
      const lowerStart = lower.getBoundingClientRect().height;
      const total = upperStart + lowerStart;
      const move = (e: PointerEvent) => {
        const upperPx = Math.max(120, Math.min(total - 120, upperStart + e.clientY - startY));
        upper.style.flex = `0 0 ${upperPx}px`;
        lower.style.flex = `0 0 ${total - upperPx}px`;
        this.groupSizes[dividerIndex] = upperPx / total;
        this.groupSizes[dividerIndex + 1] = (total - upperPx) / total;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.app.workspace.trigger("layout-change");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  removeSplitGroup(group: TabGroup): void {
    const index = this.groups.indexOf(group);
    if (index < 0) return;
    const dividerIndex = Math.min(index, this.groupDividers.length - 1);
    this.groupDividers.splice(dividerIndex, 1)[0]?.remove();
    this.groups.splice(index, 1);
    this.groupSizes.splice(index, 1);
    const total = this.groupSizes.reduce((sum, size) => sum + size, 0) || 1;
    this.groupSizes = this.groupSizes.map((size) => size / total);
    group.containerEl.remove();
    this.layoutGroups();
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

  /**
   * Build one docked-pane tab header, matching real Obsidian's sidedock DOM:
   * `.workspace-tab-header-container-inner` > `.workspace-tab-header` rows.
   * Sidebar tabs are icon-only (the inner title/close/status are hidden by
   * `.mod-${side}-split` CSS), so a fixed built-in view — which isn't a
   * detachable leaf — gets no close button here; only docked plugin
   * `WorkspaceLeaf`s do (and only those are draggable out).
   */
  private buildSidebarTab(item: SidebarItem, isActive: boolean): HTMLElement {
    let tab: HTMLElement;
    if (this.isLeaf(item)) {
      // Reuse the shared tab-header builder so docked plugin panes carry the
      // identical class shape as main-area tabs (incl. the detach close button,
      // hidden by sidebar CSS but functional), then wire drag-out + select.
      tab = buildTabHeader(item, isActive);
      const leaf = item;
      tab.draggable = true;
      tab.ondragstart = (e) => {
        draggingLeaf = leaf;
        e.dataTransfer?.setData("text/plain", leaf.id);
        tab.classList.add("is-dragging");
      };
      tab.ondragend = () => {
        draggingLeaf = null;
        tab.classList.remove("is-dragging");
      };
    } else {
      // Fixed built-in view (file explorer, search, …): same structure minus
      // the close button, since it can't be detached.
      const { icon, title } = this.metaOf(item);
      tab = document.createElement("div");
      tab.className = "workspace-tab-header";
      tab.classList.toggle("is-active", isActive);
      tab.dataset.type = item.viewType;
      tab.setAttribute("aria-label", title);
      const inner = document.createElement("div");
      inner.className = "workspace-tab-header-inner";
      const iconEl = document.createElement("div");
      iconEl.className = "workspace-tab-header-inner-icon";
      setIcon(iconEl, icon);
      const titleEl = document.createElement("div");
      titleEl.className = "workspace-tab-header-inner-title";
      titleEl.textContent = title;
      inner.append(iconEl, titleEl);
      const status = document.createElement("div");
      status.className = "workspace-tab-header-status-container";
      tab.append(inner, status);
    }
    tab.onmousedown = () => this.show(item);
    return tab;
  }

  private renderIcons() {
    // Reset the tab row so tabs don't accumulate across re-renders. The
    // sidebar no longer owns a collapse/expand button — that now lives in
    // the main pane's tab bar (`TabGroup.leftToggleEl`/`rightToggleEl`) so it
    // stays clickable even when this sidebar shrinks to width 0.
    this.tabHeaderContainerEl.innerHTML = "";
    this.tabHeaderInnerEl.innerHTML = "";
    this.tabHeaderContainerEl.appendChild(this.tabHeaderInnerEl);
    for (const item of this.leaves as SidebarItem[]) {
      if (this.isLeaf(item) && !item.view) continue; // no tab until a view is mounted
      this.tabHeaderInnerEl.appendChild(this.buildSidebarTab(item, item === this.active));
    }
  }

  show(item: SidebarItem) {
    const resolved = this.isLeaf(item) ? item : this.leaves.find((leaf) => leaf.view === item);
    if (!resolved) return;
    this.active = resolved;
    this.contentEl.innerHTML = "";
    const { el } = this.metaOf(resolved);
    if (el) this.contentEl.appendChild(el);
    void resolved.ensureOpen();
    resolved.view?.onReveal?.();
    this.renderIcons();
    if (this.collapsed) this.toggle();
    this.app.workspace.trigger("layout-change");
  }

  getView(viewType: string): View | null {
    return this.app.workspace.getLeavesOfType(viewType)[0]?.view ?? null;
  }

  // --- LeafContainer (docked plugin leaves) --------------------------------

  setActiveLeaf(leaf: WorkspaceLeaf) {
    markStart("leaf-activate");
    try {
      this.show(leaf);
    } finally {
      markEnd("leaf-activate");
    }
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
      const fallback = this.leaves[0];
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

  /** A docked leaf's view was (re)mounted — refresh its icon/title and body. */
  renderTabs() {
    this.renderIcons();
    // A docked leaf's body is hosted directly by the sidebar (`show()` moves
    // the view's element into `contentEl`), not inside `leaf.contentEl` the
    // way a tab group does it. So when a view is swapped *in place* — a
    // deferred placeholder hydrating into the real view, or the reverse when a
    // plugin unloads — `setView` alone leaves the sidebar still displaying the
    // outgoing element. Re-attach the current one here.
    const active = this.active;
    if (!(active instanceof WorkspaceLeaf)) return;
    const el = active.view?.containerEl;
    if (!el || el.parentElement === this.contentEl) return;
    this.contentEl.innerHTML = "";
    this.contentEl.appendChild(el);
  }

  toggle() {
    if (this.dragging) this.endDrag();
    this.collapsed = !this.collapsed;
    this.containerEl.classList.toggle("is-collapsed", this.collapsed);
    // Mirrored onto the workspace root so the main pane's toggle button
    // (which lives outside this sidebar) and traffic-light-clearance CSS can
    // react to collapse state without a cross-module class query.
    this.app.workspace.rootEl.classList.toggle(`mod-${this.side}-collapsed`, this.collapsed);
    this.renderIcons();
    this.app.workspace.syncSidebarToggleButtons();
    // Pre-existing gap: toggling collapse state alone never scheduled a
    // layout save (only file-open/active-leaf-change/other layout-change
    // events did, so collapse survived a relaunch only incidentally). Fire
    // it here too, matching `show()` and the resize-drag handler below, so a
    // manual collapse/expand is persisted on its own.
    this.app.workspace.trigger("layout-change");
  }

  /** Obsidian's `WorkspaceSidedock.collapse()` — idempotent; no-op if already collapsed. */
  collapse(): void {
    if (!this.collapsed) this.toggle();
  }

  /** Obsidian's `WorkspaceSidedock.expand()` — idempotent; no-op if already expanded. */
  expand(): void {
    if (this.collapsed) this.toggle();
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
  /**
   * Last known tab/pane title. Optional and purely additive — older
   * `workspace.json` files without it restore fine. Only used to label a
   * deferred placeholder while its provider is unavailable.
   */
  title?: string;
  /**
   * Last known icon id. Also only used for placeholders, but load-bearing
   * rather than cosmetic: sidebar tabs are icon-only, so a deferred pane
   * without an icon is an invisible strip entry.
   */
  icon?: string;
}

/**
 * Types that must never be replaced by a deferred placeholder, regardless of
 * factory registration. `empty`/`markdown`/`canvas` have dedicated restore
 * branches; `graph`/`base` are core app views whose factories are registered
 * unconditionally at boot. Minting a placeholder for any of these would
 * create a ghost leaf that persists forever and breaks callers that cast
 * `getLeavesOfType(t)[0].view` to the concrete class.
 */
export const RESERVED_VIEW_TYPES: ReadonlySet<string> = new Set([
  "empty",
  "markdown",
  "canvas",
  "graph",
  "base",
]);

/**
 * Whether an unresolvable persisted `type` may be restored as a deferred
 * placeholder. Pure so it stays unit-testable — `vitest.config.mts` runs in
 * the `node` environment, so anything touching real DOM isn't.
 *
 * `builtins` is the live set of sidebar built-in view types (see
 * `Sidebar.addView` / `Workspace.registerBuiltinViewType`). Those are
 * constructed at boot and matched during restore by leaf identity, not by
 * factory, so deferring them would mint a duplicate ghost pane *and* break
 * e.g. `app.openSearch`, which does `getLeavesOfType("search")[0].view as
 * SearchView` and then calls `setQuery` on it.
 */
export function isDeferrableViewType(type: string, builtins: ReadonlySet<string>): boolean {
  if (!type) return false;
  if (RESERVED_VIEW_TYPES.has(type)) return false;
  return !builtins.has(type);
}

/**
 * Resolve the "this built-in leaf already exists, move it instead of building
 * a new one" case during restore, restricted to leaves that existed *before*
 * this restore pass began.
 *
 * Without the `preExisting` filter this would match a `DeferredView` created
 * earlier in the same pass (since a `DeferredView` impersonates its persisted
 * type), which would either collapse two same-type panes into one or — because
 * sidebars restore before the center — yank a docked sidebar pane into a
 * center tab group.
 */
export function pickExistingBuiltinLeaf(
  candidates: readonly WorkspaceLeaf[],
  preExisting: ReadonlySet<WorkspaceLeaf>
): WorkspaceLeaf | undefined {
  return candidates.find((leaf) => preExisting.has(leaf));
}

/**
 * Capture the label and icon a placeholder would need if this view's provider
 * went away. Both accessors run arbitrary plugin code on every layout save, so
 * a throwing one degrades to "no title/icon" rather than losing the save.
 */
export function describeViewForPlaceholder(view: View): { title?: string; icon?: string } {
  const out: { title?: string; icon?: string } = {};
  try {
    const title = view.getDisplayText();
    if (typeof title === "string" && title) out.title = title;
  } catch { /* keep the leaf persistable even if the view's accessor throws */ }
  try {
    const icon = view.getIcon();
    if (typeof icon === "string" && icon) out.icon = icon;
  } catch { /* ditto */ }
  return out;
}

export interface PersistedSidebarV1 {
  leaves: PersistedLeaf[];
  activeType: string | null;
  collapsed: boolean;
  width?: number;
}

/** The whole persisted workspace layout, stored per-vault in `.geode/workspace.json`. */
export interface PersistedWorkspaceV1 {
  version: 1;
  groups: { leaves: PersistedLeaf[]; active: number }[];
  activeGroup: number;
  left: PersistedSidebarV1;
  right: PersistedSidebarV1;
}

export interface PersistedTabNode {
  type: "tabs";
  leaves: PersistedLeaf[];
  active: number;
}

export interface PersistedSplitNode {
  type: "split";
  direction: "horizontal" | "vertical";
  sizes: number[];
  children: WorkspaceTreeNode[];
}

export type WorkspaceTreeNode = PersistedTabNode | PersistedSplitNode;

interface PersistedRegionV2 {
  root: WorkspaceTreeNode | null;
  collapsed?: boolean;
  width?: number;
  activeGroup?: number;
}

export interface PersistedWorkspaceV2 {
  version: 2;
  center: PersistedRegionV2;
  left: PersistedRegionV2;
  right: PersistedRegionV2;
}

export type PersistedWorkspace = PersistedWorkspaceV1 | PersistedWorkspaceV2;

/** Remove empty branches and redundant one-child splits after moves/closes. */
export function normalizeWorkspaceNode(node: WorkspaceTreeNode, keepEmptyRoot = false): WorkspaceTreeNode | null {
  if (node.type === "tabs") return node.leaves.length || keepEmptyRoot ? node : null;
  const children = node.children
    .map((child) => normalizeWorkspaceNode(child, false))
    .filter((child): child is WorkspaceTreeNode => child !== null);
  if (!children.length) return keepEmptyRoot ? { type: "tabs", leaves: [], active: 0 } : null;
  if (children.length === 1) return children[0];
  const equal = 1 / children.length;
  const sizes = children.map((child) => {
    const original = node.children.indexOf(child);
    return original >= 0 ? (node.sizes[original] ?? equal) : equal;
  });
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return { ...node, children, sizes: sizes.map((size) => size / total) };
}

/** Upgrade the old flat v1 layout without dropping any user-visible state. */
export function migrateWorkspaceLayout(state: PersistedWorkspace): PersistedWorkspaceV2 {
  if (state.version === 2) return state;
  const tabs = (leaves: PersistedLeaf[], activeType?: string | null): PersistedTabNode => ({
    type: "tabs",
    leaves,
    active: Math.max(0, activeType ? leaves.findIndex((leaf) => leaf.type === activeType) : 0),
  });
  const centerChildren = state.groups.map((group) => tabs(group.leaves)).map((node, index) => ({
    ...node,
    active: state.groups[index]?.active ?? 0,
  }));
  const centerRoot: WorkspaceTreeNode = centerChildren.length <= 1
    ? (centerChildren[0] ?? tabs([]))
    : { type: "split", direction: "horizontal", sizes: centerChildren.map(() => 1 / centerChildren.length), children: centerChildren };
  return {
    version: 2,
    center: { root: centerRoot, activeGroup: state.activeGroup },
    left: { root: tabs(state.left.leaves, state.left.activeType), collapsed: state.left.collapsed, width: state.left.width },
    right: { root: tabs(state.right.leaves, state.right.activeType), collapsed: state.right.collapsed, width: state.right.width },
  };
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
  /** Built-in sidebar view types, recorded by `Sidebar.addView`. Never deferred. */
  private builtinViewTypes = new Set<string>();

  constructor(public app: App, parentEl: HTMLElement) {
    super();
    this.rootEl = document.createElement("div");
    this.rootEl.className = "workspace";
    this.leftSidebar = new Sidebar("left", this.app);
    this.rightSidebar = new Sidebar("right", this.app);
    this.centerEl = document.createElement("div");
    // `workspace-split mod-root mod-vertical` are Obsidian's real root-split
    // hooks (added alongside Geode's own `workspace-center`, which existing
    // selectors/tests still key on). They scope the main-pane-only active-tab
    // curve and let community themes targeting `.workspace-split.mod-root`
    // restyle Geode's main area.
    this.centerEl.className = "workspace-center workspace-split mod-root mod-vertical";
    this.rootEl.appendChild(this.leftSidebar.containerEl);
    this.rootEl.appendChild(this.centerEl);
    this.rootEl.appendChild(this.rightSidebar.containerEl);
    parentEl.appendChild(this.rootEl);
    this.activeGroup = this.addGroup();
  }

  /**
   * Obsidian's `workspace.leftSplit`/`.rightSplit`. Getters (not fields) so
   * identity always resolves live to the current `leftSidebar`/`rightSidebar`
   * — a plugin that does `const { leftSplit } = app.workspace` and later
   * reads `.collapsed` off it sees current state, not a stale snapshot.
   *
   * `rootSplit` (the main-pane `WorkspaceRoot`) is intentionally NOT shimmed:
   * Obsidian's is a full `WorkspaceItem` (`getRoot()`/`getContainer()`/
   * `parent`/`children`), and Geode's main area (`centerEl` + `groups`) can't
   * answer that protocol. A half-shim would pass a plugin's
   * `if (app.workspace.rootSplit)` feature-detect and then throw walking the
   * tree — worse than leaving it `undefined` so the feature-detect fails
   * honestly.
   */
  get leftSplit(): Sidebar {
    return this.leftSidebar;
  }

  get rightSplit(): Sidebar {
    return this.rightSidebar;
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
    this.syncSidebarToggleButtons();
    this.trigger("layout-change");
    return group;
  }

  /**
   * Keep every `TabGroup`'s sidebar-toggle buttons' `aria-label`/`title` in
   * sync with actual collapsed state. Called whenever a sidebar is toggled
   * and whenever a new group is added (splits), so a freshly-created group
   * doesn't start with stale "Collapse sidebar" labels if a sidebar is
   * already collapsed.
   */
  syncSidebarToggleButtons(): void {
    for (const group of this.groups) {
      const leftLabel = this.leftSidebar.collapsed ? "Expand sidebar" : "Collapse sidebar";
      group.leftToggleEl.setAttribute("aria-label", leftLabel);
      group.leftToggleEl.title = leftLabel;
      const rightLabel = this.rightSidebar.collapsed ? "Expand sidebar" : "Collapse sidebar";
      group.rightToggleEl.setAttribute("aria-label", rightLabel);
      group.rightToggleEl.title = rightLabel;
    }
  }

  groupEmptied(group: TabGroup) {
    if (group.sidebar) {
      group.sidebar.removeSplitGroup(group);
      this.trigger("layout-change");
      return;
    }
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

  /**
   * Obsidian's `workspace.activeLeaf` — a plain property, not just a method
   * (real plugins commonly destructure `{ view } = this.app.workspace.activeLeaf`
   * unguarded, e.g. the vendored Calendar fixture's `updateActiveFile`).
   * Kept in sync with `getActiveLeaf()`.
   */
  get activeLeaf(): WorkspaceLeaf | null {
    return this.getActiveLeaf();
  }

  /** Active file in the workspace (from the active leaf's view). */
  getActiveFile(): TFile | null {
    return this.getActiveLeaf()?.view?.getFile?.() ?? null;
  }

  getActiveViewOfType<T extends View>(type: new (...args: any[]) => T): T | null {
    const view = this.activeLeaf?.view;
    return view instanceof type ? view : null;
  }

  /** Get a leaf for opening a file: reuse active unless newTab/pinned. */
  getLeaf(newTab: boolean): WorkspaceLeaf {
    const active = this.getActiveLeaf();
    if (!newTab && active && !active.pinned) return active;
    return this.activeGroup.createLeaf();
  }

  /**
   * Obsidian's `workspace.getUnpinnedLeaf()`: a leaf plugins can open a file
   * into without evicting a pinned tab — identical to `getLeaf(false)`'s
   * "reuse the active leaf unless it's pinned" semantics. Called directly
   * (not via a `Plugin` wrapper) by real plugins, e.g. the vendored
   * Calendar fixture's `openOrCreateDailyNote`/`tryToCreateDailyNote`.
   */
  getUnpinnedLeaf(): WorkspaceLeaf {
    return this.getLeaf(false);
  }

  /**
   * Obsidian's `workspace.splitActiveLeaf()`: open a new leaf in a fresh
   * split next to the active group, mirroring the "split-right" command's
   * `addGroup(activeGroup)` + create-leaf pattern.
   */
  splitActiveLeaf(_direction?: "vertical" | "horizontal"): WorkspaceLeaf {
    const group = this.addGroup(this.activeGroup);
    return group.createLeaf();
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
    for (const sidebar of [this.leftSidebar, this.rightSidebar]) {
      for (const group of sidebar.groups) {
        const leaves = group instanceof Sidebar ? group.leaves : (group as TabGroup).leaves;
        for (const leaf of leaves) cb(leaf);
      }
    }
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
    // A plugin that registers *after* restore (slower than
    // PLUGIN_ONLOAD_TIMEOUT_MS, re-enabled from Settings, or reloaded after an
    // update) reclaims its placeholders here. Fire-and-forget: `registerView`
    // is synchronous in Obsidian's API and a plugin's `onload` must not be
    // made to wait on view mounting. The startup path additionally *awaits*
    // `hydrateDeferredLeaves()` before `flushLayoutReady()` — see App.initialize.
    void this.hydrateDeferredLeaves(viewType);
  }

  /**
   * Record a view type as a built-in (constructed at boot by
   * `Sidebar.addView`, never resolved through a factory). Built-ins are
   * excluded from deferral — see `isDeferrableViewType`.
   */
  registerBuiltinViewType(viewType: string): void {
    this.builtinViewTypes.add(viewType);
  }

  /** Whether an unresolvable persisted type may become a deferred placeholder. */
  isDeferrableViewType(viewType: string): boolean {
    return isDeferrableViewType(viewType, this.builtinViewTypes);
  }

  /**
   * Replace every deferred placeholder whose factory is now available with the
   * real view, handing back the persisted state verbatim.
   *
   * Each leaf is isolated in its own try/catch. A stale persisted state can
   * make a plugin's `setState` reject, and this runs inside the awaited
   * `onload` chain — an escaping rejection would reach
   * `PluginManager.recordAndQuarantine` and disable the entire plugin over one
   * bad pane. On failure the leaf stays deferred with its state intact, shows
   * the error, and retries on the next launch.
   */
  async hydrateDeferredLeaves(viewType?: string): Promise<void> {
    const targets: WorkspaceLeaf[] = [];
    this.iterateLeaves((leaf) => {
      if (!isDeferredView(leaf.view)) return;
      if (viewType !== undefined && leaf.view.viewType !== viewType) return;
      targets.push(leaf);
    });
    for (const leaf of targets) await this.hydrateLeaf(leaf);
  }

  /** Hydrate one deferred leaf. No-op (and never throws) if it isn't deferred or has no factory. */
  async hydrateLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const deferred = leaf.view;
    if (!isDeferredView(deferred)) return;
    const type = deferred.viewType;
    const factory = this.getViewFactory(type);
    if (!factory) return;
    try {
      await leaf.setViewState({ type, state: deferred.getState() });
    } catch (err) {
      console.error(`Failed to restore deferred view "${type}"`, err);
      deferred.setError(`Couldn't restore this pane: ${err instanceof Error ? err.message : String(err)}`);
      // `setViewState` may have already swapped in a half-mounted view before
      // throwing. Put the placeholder back so the state survives to the next
      // attempt rather than being stranded behind a broken view.
      if (leaf.view !== deferred) await leaf.setView(deferred);
      return;
    }
    // Generation guard: `PluginManager.reload()` is disable-then-enable, so a
    // second disable can land during the await above. If the factory we
    // mounted from is no longer the registered one, that view is orphaned —
    // revert to the placeholder rather than leaving a live view backed by an
    // unloaded plugin.
    if (this.getViewFactory(type) !== factory) await leaf.setView(deferred);
  }

  /** Build the placeholder for a persisted leaf whose provider isn't available. */
  createDeferredView(ls: PersistedLeaf): DeferredView {
    return new DeferredView({ type: ls.type, state: ls.state, title: ls.title, icon: ls.icon });
  }

  /**
   * Unregister a view factory, converting its open leaves into deferred
   * placeholders rather than destroying them.
   *
   * This runs from `Plugin.registerView`'s auto-unregister on `onunload` — so
   * it fires on disable, on quarantine, and on the disable half of an
   * *update* or `reload()`. Detaching here (the previous behaviour) meant a
   * routine plugin update silently wiped the user's panes.
   *
   * Known limitation: a plugin that calls `detachLeavesOfType` in its own
   * `onunload` still hard-detaches. The guarantee is "Geode won't destroy your
   * panes", not "no plugin can".
   */
  unregisterViewFactory(viewType: string): void {
    this.viewFactories.delete(viewType);
    if (!this.isDeferrableViewType(viewType)) {
      this.detachLeavesOfType(viewType);
      return;
    }
    for (const leaf of this.getLeavesOfType(viewType)) {
      if (isDeferredView(leaf.view)) continue;
      void leaf.setView(this.createDeferredView(this.captureLeafForDeferral(leaf, viewType)));
    }
  }

  /**
   * Snapshot everything a placeholder needs, reading it *before* any teardown.
   * `setView` calls the outgoing view's `onClose()`, and `Plugin.unload()` may
   * already have released whatever its `getState()` reads, so a throwing
   * accessor here is expected rather than exceptional — fall back to the
   * leaf's last explicitly-set view state.
   */
  private captureLeafForDeferral(leaf: WorkspaceLeaf, viewType: string): PersistedLeaf {
    let state: unknown;
    try {
      state = leaf.getViewState().state;
    } catch {
      state = leaf.getPersistedState();
    }
    const view = leaf.view;
    return { type: viewType, state, ...(view ? describeViewForPlaceholder(view) : {}) };
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
  getRightLeaf(split: boolean): WorkspaceLeaf {
    return split ? this.rightSidebar.addSplitGroup() : this.rightSidebar.addLeaf();
  }
  getLeftLeaf(split: boolean): WorkspaceLeaf {
    return split ? this.leftSidebar.addSplitGroup() : this.leftSidebar.addLeaf();
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

  /**
   * Fire queued `onLayoutReady` callbacks. Called once by App after layout
   * restore. Also emits the `"layout-ready"` Events-based signal — real
   * Obsidian plugins commonly use `workspace.on("layout-ready", cb)`
   * (rather than, or in addition to, `onLayoutReady(cb)`) to defer opening
   * their own view until here; without this, that idiom silently never
   * fires in Geode. Purely additive: nothing in Geode's own code currently
   * subscribes via `.on("layout-ready", ...)`.
   */
  flushLayoutReady(): void {
    this.layoutReady = true;
    for (const cb of this.layoutReadyCbs.splice(0)) {
      try {
        cb();
      } catch (err) {
        console.error("Error in onLayoutReady callback", err);
      }
    }
    this.trigger("layout-ready");
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
    if (v.viewType === "markdown" || v.viewType === "canvas") {
      // No title/icon here: the file path is the source of truth for these,
      // and they always have a restore branch, so they're never deferred.
      const file = v.getFile?.()?.path;
      return file ? { type: v.viewType, file, pinned: leaf.pinned } : null;
    }
    // A `DeferredView` needs no special case: it impersonates its persisted
    // type and returns its persisted state/title/icon, so a leaf that is still
    // deferred re-serializes exactly as it was read. That is what makes a
    // crash-recovery launch — where zero plugin factories exist — non-lossy.
    return {
      type: v.viewType,
      state: leaf.getViewState().state,
      pinned: leaf.pinned,
      ...describeViewForPlaceholder(v),
    };
  }

  /** Snapshot the current layout for persistence. Empty tabs/groups are dropped. */
  serialize(): PersistedWorkspaceV2 {
    const activeGroup = Math.max(0, this.groups.indexOf(this.activeGroup));
    const nodeFor = (container: Sidebar | TabGroup): PersistedTabNode => {
      const leaves = container.leaves
        .map((leaf) => ({ leaf, persisted: this.serializeLeaf(leaf) }))
        .filter((item): item is { leaf: WorkspaceLeaf; persisted: PersistedLeaf } => !!item.persisted);
      const active = container.active instanceof WorkspaceLeaf
        ? Math.max(0, leaves.findIndex((item) => item.leaf === container.active))
        : 0;
      return { type: "tabs", leaves: leaves.map((item) => item.persisted), active };
    };
    const regionRoot = (containers: (Sidebar | TabGroup)[], direction: "horizontal" | "vertical", sizes?: number[]): WorkspaceTreeNode => {
      const children = containers.map(nodeFor);
      return children.length === 1 ? children[0] : {
        type: "split", direction, sizes: sizes?.length === children.length ? sizes : children.map(() => 1 / children.length), children,
      };
    };
    return {
      version: 2,
      center: { root: regionRoot(this.groups, "horizontal"), activeGroup },
      left: {
        root: regionRoot(this.leftSidebar.groups as (Sidebar | TabGroup)[], "vertical", this.leftSidebar.groupSizes),
        collapsed: this.leftSidebar.collapsed,
        width: this.leftSidebar.width,
      },
      right: {
        root: regionRoot(this.rightSidebar.groups as (Sidebar | TabGroup)[], "vertical", this.rightSidebar.groupSizes),
        collapsed: this.rightSidebar.collapsed,
        width: this.rightSidebar.width,
      },
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
    } else if (ls.type === "canvas" && ls.file) {
      const file = this.app.vault.getFileByPath(ls.file);
      if (file) {
        const view = this.app.createCanvasView();
        await view.setFile(file);
        await leaf.setView(view);
      } else {
        await leaf.setView(this.app.createEmptyView());
      }
    } else if (ls.type === "empty") {
      await leaf.setView(this.app.createEmptyView());
    } else if (this.getViewFactory(ls.type)) {
      await leaf.setViewState({ type: ls.type, state: ls.state });
    } else if (this.isDeferrableViewType(ls.type)) {
      // The provider for this view type isn't available right now (plugin
      // disabled, quarantined, mid-update, suppressed by crash recovery, or
      // still loading). Hold the leaf with a placeholder that keeps `type` and
      // `state` intact. Falling back to an EmptyView here used to destroy
      // both: `serializeLeaf` returns null for `empty`, so the next debounced
      // save dropped the leaf from `workspace.json` outright.
      await leaf.setView(this.createDeferredView(ls));
    } else {
      await leaf.setView(this.app.createEmptyView());
    }
    if (ls.pinned) leaf.setPinned(true);
  }

  private async restoreSidebar(
    sb: Sidebar,
    ps: PersistedRegionV2,
    preExisting: ReadonlySet<WorkspaceLeaf>
  ): Promise<void> {
    const nodes = ps.root?.type === "split" ? ps.root.children : ps.root ? [ps.root] : [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.type !== "tabs") continue;
      const target = index === 0 ? sb : (sb.addSplitGroup().group as TabGroup);
      for (const ls of node.leaves) {
        const factory = this.getViewFactory(ls.type);
        const existingBuiltin = !factory
          ? pickExistingBuiltinLeaf(this.getLeavesOfType(ls.type), preExisting)
          : undefined;
        if (existingBuiltin) {
          if (existingBuiltin.group !== target) this.moveLeaf(existingBuiltin, target);
          if (ls.pinned) existingBuiltin.setPinned(true);
        } else if (factory || this.isDeferrableViewType(ls.type)) {
          // Note the `else` that used to be missing entirely: a docked pane
          // whose factory wasn't registered yet was never created at all, and
          // then dropped from the next save. This is the path that lost
          // right-sidebar plugin panes after a crash-recovery restart.
          const leaf = target instanceof Sidebar
            ? target.addLeaf()
            : (target.leaves.find((candidate) => !candidate.view) ?? target.createLeaf());
          if (factory) await leaf.setViewState({ type: ls.type, state: ls.state });
          else await leaf.setView(this.createDeferredView(ls));
          if (ls.pinned) leaf.setPinned(true);
        }
      }
      const leaves = target instanceof Sidebar ? target.leaves : target.leaves;
      if (leaves[node.active]) target.setActiveLeaf(leaves[node.active]);
    }
    if (ps.root?.type === "split") {
      sb.groupSizes = [...ps.root.sizes];
      sb.groups.forEach((group, index) => {
        const element = group instanceof Sidebar ? group.contentEl : (group as TabGroup).containerEl;
        element.style.flex = `1 1 ${Math.max(0, sb.groupSizes[index] ?? 0) * 100}%`;
      });
    }
    // Must run before the collapsed-toggle below so the correct expanded
    // width is recorded even if the sidebar restores collapsed.
    if (typeof ps.width === "number" && Number.isFinite(ps.width)) sb.setWidth(ps.width);
    if (ps.collapsed && !sb.collapsed) sb.toggle();
  }

  /**
   * Rebuild the layout from a persisted snapshot. Returns false (restoring
   * nothing beyond sidebar chrome) if the snapshot has no real tab/leaf
   * content, so the caller can fall back to opening an empty tab.
   */
  async deserialize(input: PersistedWorkspace): Promise<boolean> {
    const state = migrateWorkspaceLayout(input);
    // Snapshot the leaves that exist *before* this pass. The `existingBuiltin`
    // lookups below match on `leaf.view.viewType`, and a `DeferredView` created
    // earlier in this same pass impersonates its persisted type — without this
    // filter, two saved panes of one unavailable type would collapse into one,
    // and (since sidebars restore first) a center tab could steal a docked
    // sidebar pane.
    const preExisting = new Set<WorkspaceLeaf>();
    this.iterateLeaves((leaf) => preExisting.add(leaf));
    const centerNodes = state.center.root?.type === "split" ? state.center.root.children : state.center.root ? [state.center.root] : [];
    const hasContent =
      centerNodes.some((node) => node.type === "tabs" && node.leaves.length) ||
      !!state.left.root || !!state.right.root;

    // Restore sidebar chrome (width/collapsed/docked leaves) unconditionally,
    // even when there's no tab/leaf content at all — a sidebar the user
    // resized (or collapsed) should keep that state even if they never
    // opened a note, so this must not be gated behind `hasContent` below.
    if (state?.left) await this.restoreSidebar(this.leftSidebar, state.left, preExisting);
    if (state?.right) await this.restoreSidebar(this.rightSidebar, state.right, preExisting);

    if (!hasContent) return false;

    // Rebuild the (non-empty) tab groups. Groups the snapshot didn't include
    // are added as needed; a restored group that ends up empty gets exactly
    // one placeholder tab (never accumulating empties across launches).
    const targetGroups = Math.max(1, centerNodes.length);
    while (this.groups.length < targetGroups) this.addGroup();
    for (let gi = 0; gi < this.groups.length; gi++) {
      const group = this.groups[gi];
      const gs = centerNodes[gi];
      if (gs?.type === "tabs") {
        for (const ls of gs.leaves) {
          const factory = this.getViewFactory(ls.type);
          const existingBuiltin = ls.type !== "markdown" && ls.type !== "empty" && !factory
            ? pickExistingBuiltinLeaf(this.getLeavesOfType(ls.type), preExisting)
            : undefined;
          if (existingBuiltin) {
            this.moveLeaf(existingBuiltin, group);
            if (ls.pinned) existingBuiltin.setPinned(true);
          } else {
            const leaf = group.createLeaf();
            await this.restoreLeafView(leaf, ls);
          }
        }
      }
      if (group.leaves.length === 0) {
        const leaf = group.createLeaf();
        await leaf.setView(this.app.createEmptyView());
      }
      const active = (gs?.type === "tabs" && group.leaves[gs.active]) || group.leaves[0];
      if (active) group.setActiveLeaf(active);
    }
    const ag = this.groups[state.center.activeGroup ?? 0] ?? this.groups[0];
    if (ag?.active) ag.setActiveLeaf(ag.active);
    return true;
  }
}
