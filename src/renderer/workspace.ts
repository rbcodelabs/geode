import { Events } from "./events";
import type { App } from "./app";
import type { TFile } from "./types";
import { setIcon } from "./api/icons";
import { markStart, markEnd } from "./perf-instrumentation";

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
      if (this.view) await this.view.onClose();
      this.view = view;
      this.contentEl.innerHTML = "";
      this.contentEl.dataset.type = view.viewType;
      this.contentEl.appendChild(view.containerEl);
      await view.onOpen();
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
      await this.view?.onClose();
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
  readonly isSidebar = false;
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

  constructor(
    public workspace: Workspace,
    public app: App
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-tabs mod-top";
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
      this.renderTabs();
      this.workspace.activeGroup = this;
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
  active: SidebarItem | null = null;
  collapsed = false;
  width: number = SIDEBAR_DEFAULT_WIDTH;
  private dragging = false;
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
    this.containerEl.appendChild(this.tabHeaderContainerEl);
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
    this.resizeHandleEl = document.createElement("div");
    this.resizeHandleEl.className = "sidebar-resize-handle";
    this.containerEl.appendChild(this.resizeHandleEl);
    this.attachResizeHandle();
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
    for (const item of [...this.views, ...this.leaves] as SidebarItem[]) {
      if (this.isLeaf(item) && !item.view) continue; // no tab until a view is mounted
      this.tabHeaderInnerEl.appendChild(this.buildSidebarTab(item, item === this.active));
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
    this.app.workspace.trigger("layout-change");
  }

  getView(viewType: string): View | null {
    return this.views.find((v) => v.viewType === viewType) ?? null;
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
  width?: number;
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
      width: sb.width,
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
    if (ls.pinned) leaf.setPinned(true);
  }

  private async restoreSidebar(sb: Sidebar, ps: PersistedSidebar): Promise<void> {
    for (const ls of ps.leaves) {
      if (!this.getViewFactory(ls.type)) continue; // plugin absent
      const leaf = sb.addLeaf();
      await leaf.setViewState({ type: ls.type, state: ls.state });
      if (ls.pinned) leaf.setPinned(true);
    }
    if (ps.activeType) {
      const l = sb.leaves.find((x) => x.view?.viewType === ps.activeType);
      if (l) sb.setActiveLeaf(l);
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
  async deserialize(state: PersistedWorkspace): Promise<boolean> {
    const hasContent =
      (state?.groups?.some((g) => g.leaves.length) ?? false) ||
      !!state?.left?.leaves.length ||
      !!state?.right?.leaves.length;

    // Restore sidebar chrome (width/collapsed/docked leaves) unconditionally,
    // even when there's no tab/leaf content at all — a sidebar the user
    // resized (or collapsed) should keep that state even if they never
    // opened a note, so this must not be gated behind `hasContent` below.
    if (state?.left) await this.restoreSidebar(this.leftSidebar, state.left);
    if (state?.right) await this.restoreSidebar(this.rightSidebar, state.right);

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
    const ag = this.groups[state.activeGroup] ?? this.groups[0];
    if (ag?.active) ag.setActiveLeaf(ag.active);
    return true;
  }
}
