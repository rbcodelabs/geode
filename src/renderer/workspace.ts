import { Events } from "./events";
import type { App } from "./app";
import type { TFile } from "./types";
import { setIcon } from "./api/icons";
import { markStart, markEnd } from "./perf-instrumentation";
import { DeferredView, isDeferredView } from "./views/deferred-view";
import {
  COLLECTION_COLORS,
  classifyMemberDrop,
  collectionBlocks,
  moveCollectionBlock,
  nextCollectionColor,
  normalizeCollectionName,
  normalizeSerializedCollectionSubset,
  normalizeTabCollections,
  runAllSettled,
  selectNearestSurvivor,
  tabStripNavigationIndex,
  type TabCollection,
  uniqueCollectionId,
} from "./tab-collections";

export interface View {
  readonly viewType: string;
  containerEl: HTMLElement;
  getDisplayText(): string;
  getIcon(): string;
  onOpen(): void | Promise<void>;
  onClose(): void | Promise<void>;
  /** Suspend new vault-backed writes and await any buffered/in-flight writes. */
  prepareVaultSwitch?(): Promise<void>;
  /** Resume a suspended writer when the switch transaction aborts. */
  cancelVaultSwitch?(): void;
  /** Pause new autosaves without flushing dirty text, for provider reconciliation. */
  pauseAutosave?(): Promise<void>;
  /** Resume autosave after reconciliation reaches a complete or recoverable state. */
  resumeAutosave?(): void;
  /** Serialized state for WorkspaceLeaf.getViewState(). */
  getState?(): unknown;
  /** Optional visibility callback; unlike onOpen, may run whenever a tab is revealed. */
  onReveal?(): void;
  /** Views showing a file implement this. */
  getFile?(): TFile | null;
}

/**
 * A view whose content can be reloaded in place: the Web Viewer and Artifact
 * views today. Implementing this is what makes the `web.reload` action (and
 * so Cmd+R, the toolbar button and the tab context menu) apply to a view.
 *
 * Compile-time only. Nothing dispatches on this structurally: callers resolve
 * it with `instanceof` against the concrete Geode view classes, because a
 * `typeof view.reload === "function"` guard would happily bind Cmd+R to an
 * arbitrary plugin view that happens to expose a `reload` method.
 */
export interface ReloadableView {
  /**
   * User-initiated reload. Distinct from a raw guest `reload()`: it also
   * resets crash-recovery guards and respawns a dead guest, so the user's
   * attempt gets a clean budget.
   */
  reload(): void;
  /** Menu and command label, e.g. "Reload page" vs "Reload artifact". */
  readonly reloadLabel: string;
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
let draggingCollection: { group: TabGroup; id: string } | null = null;

/** A leaf is one tab (or one docked sidebar pane): a container hosting a single view. */
export class WorkspaceLeaf {
  id = `leaf-${++leafIdCounter}`;
  view: View | null = null;
  tabEl: HTMLElement;
  /** Obsidian's `.workspace-leaf` wrapper: hosts `contentEl` when mounted into a tab group. */
  leafEl: HTMLElement;
  contentEl: HTMLElement;
  pinned = false;
  /** Split-local Phase 1 collection membership. Never carried across containers. */
  collectionId?: string;
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

  /**
   * Obsidian's `WorkspaceLeaf.isDeferred` (1.7+). Deliberate divergence:
   * Obsidian's deferred leaf is lazy-but-always-loadable — it just hasn't been
   * rendered yet. Geode's means "the provider for this view type isn't
   * currently loaded", which a `loadIfDeferred()` cannot always resolve.
   * Plugin authors should therefore `instanceof`-check rather than cast
   * `getLeavesOfType(type)[0].view` to their own view class.
   */
  get isDeferred(): boolean {
    return isDeferredView(this.view);
  }

  /**
   * Obsidian's `WorkspaceLeaf.loadIfDeferred()`. Resolves silently when the
   * leaf isn't deferred, and also when no factory is registered for its type —
   * plugins call this speculatively and an unavailable provider is a normal
   * state in Geode, not an error. Contrast `setViewState`, which throws.
   */
  async loadIfDeferred(): Promise<void> {
    await this.app.workspace.hydrateLeaf(this);
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
 * `.workspace-tab-header-inner` > icon, title, `.workspace-tab-header-status-container`
 * (pin icon), then the close button. Shared by `TabGroup`
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

  const status = document.createElement("div");
  status.className = "workspace-tab-header-status-container";
  if (leaf.pinned) {
    const pin = document.createElement("div");
    pin.className = "workspace-tab-header-status-icon mod-pinned";
    setIcon(pin, "pin");
    status.appendChild(pin);
  }

  // Status sits INSIDE `inner`, immediately before the close button — the same
  // child order real Obsidian builds. As a sibling of `inner` it was laid out
  // by the tab's own flex box, so a pinned tab shrank `inner` by the pin's
  // width: the pin escaped `inner`'s trailing padding, and the inactive-tab
  // divider (`inner::after`, pinned to `inner`'s end edge) was drawn that far
  // inside the tab's real edge instead of on it.
  inner.append(icon, title, status, close);

  tab.append(inner);
  return tab;
}

/** A group of tabs sharing one content area. */
export class TabGroup implements LeafContainer {
  readonly isSidebar: boolean;
  leaves: WorkspaceLeaf[] = [];
  active: WorkspaceLeaf | null = null;
  collections: TabCollection[] = [];
  containerEl: HTMLElement;
  /** `.workspace-tab-header-container` — the whole header bar (scrollable inner row + tab-list/new-tab). */
  tabBarEl: HTMLElement;
  /** `.workspace-tab-header-container-inner` — the scrollable row that actually holds the tab headers. */
  tabHeaderInnerEl: HTMLElement;
  contentHostEl: HTMLElement;
  /** Left-sidebar toggle button, first child of `tabBarEl` (only meaningful/visible on the leftmost group). */
  leftToggleEl: HTMLButtonElement;
  /** Right-sidebar toggle button, last child of `tabBarEl` (only meaningful/visible on the rightmost group). */
  rightToggleEl: HTMLButtonElement;
  private bodyDropEdge: "left" | "right" | "top" | "bottom" | null = null;
  private collectionCounter = 0;
  private dropMarkerEl: HTMLElement | null = null;

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
    this.leftToggleEl = document.createElement("button");
    this.leftToggleEl.type = "button";
    this.leftToggleEl.className = "clickable-icon sidebar-toggle-button mod-left";
    setIcon(this.leftToggleEl, "panel-left");
    this.leftToggleEl.addEventListener("click", () => this.workspace.toggleSidebar("left", this.leftToggleEl));
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
      const items: Array<{ title: string; icon?: string | null; checked?: boolean; disabled?: boolean; section: string; action?: () => void; submenu?: Array<{ title: string; icon?: string | null; checked?: boolean; action: () => void }> }> = [];
      const seenCollections = new Set<string>();
      for (const leaf of this.leaves) {
        const collection = this.collectionForLeaf(leaf);
        if (collection && !seenCollections.has(collection.id)) {
          seenCollections.add(collection.id);
          items.push({
            title: `${collection.collapsed ? "▸" : "▾"} ${collection.name} (${collection.color})`,
            section: "tabs",
            submenu: this.leaves.filter((member) => member.collectionId === collection.id).map((member) => ({
              title: member.getDisplayText(),
              icon: member.view?.getIcon() ?? "file",
              checked: member === this.active,
              action: () => this.setActiveLeaf(member),
            })),
          });
        }
        if (!collection) items.push({
          title: collection ? `  ${leaf.getDisplayText()}` : leaf.getDisplayText(),
          icon: leaf.view?.getIcon() ?? "file",
          checked: leaf === this.active,
          section: "tabs",
          action: () => this.setActiveLeaf(leaf),
        });
      }
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
    this.rightToggleEl = document.createElement("button");
    this.rightToggleEl.type = "button";
    this.rightToggleEl.className = "clickable-icon sidebar-toggle-button mod-right";
    setIcon(this.rightToggleEl, "panel-right");
    this.rightToggleEl.addEventListener("click", () => this.workspace.toggleSidebar("right", this.rightToggleEl));
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
      if (!draggingLeaf && !draggingCollection) return;
      e.preventDefault();
      el.classList.add("drag-over");
    };
    const leave = (el: HTMLElement) => el.classList.remove("drag-over");
    this.tabBarEl.addEventListener("dragover", (e) => over(e, this.tabBarEl));
    this.tabBarEl.addEventListener("dragleave", () => leave(this.tabBarEl));
    this.tabBarEl.addEventListener("drop", (e) => {
      leave(this.tabBarEl);
      if (draggingCollection?.group === this) {
        e.preventDefault();
        this.moveCollectionToIndex(draggingCollection.id, this.leaves.length);
        return;
      }
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
    leaf.collectionId = undefined;
    if (this.active === leaf) {
      this.active = this.leaves[Math.min(i, this.leaves.length - 1)] ?? null;
      this.contentHostEl.innerHTML = "";
      if (this.active) this.contentHostEl.appendChild(this.active.leafEl);
    }
    this.normalizeCollections();
    this.renderTabs();
  }

  /** Adopt an existing leaf (from another container) at `index` (default: end). */
  insertLeaf(leaf: WorkspaceLeaf, index?: number) {
    leaf.group = this;
    leaf.collectionId = undefined;
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
    if (this.active === leaf && (this.sidebar || this.workspace.activeGroup === this)) {
      // Re-selecting the current center leaf is event-idempotent, but still
      // synchronizes adaptive presentation (for example, closing a mobile
      // drawer after its selected destination is activated).
      if (!this.sidebar) {
        this.workspace.setActiveGroup(this);
        const file = leaf.view?.getFile?.();
        if (file) this.workspace.trigger("file-open", file);
      }
      return;
    }
    markStart("leaf-activate");
    try {
      const changesWorkspaceGroup = !this.sidebar && this.workspace.activeGroup !== this;
      this.active = leaf;
      this.contentHostEl.innerHTML = "";
      this.contentHostEl.appendChild(leaf.leafEl);
      void leaf.ensureOpen();
      this.renderTabs();
      if (!this.sidebar) this.workspace.setActiveGroup(this);
      // setActiveGroup emits when moving between center groups. Activating a
      // different tab inside the current group (or any sidebar tab) remains
      // this method's responsibility, so every effective change emits once.
      if (!changesWorkspaceGroup) this.workspace.trigger("active-leaf-change", leaf);
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
    this.normalizeCollections();
    this.renderTabs();
    this.workspace.trigger("layout-change");
  }

  private normalizeCollections(): void {
    const normalized = normalizeTabCollections(
      this.leaves.map((leaf) => ({ leaf, id: leaf.id, collectionId: leaf.collectionId })),
      this.collections,
    );
    this.leaves = normalized.leaves.map((entry) => {
      entry.leaf.collectionId = entry.collectionId;
      return entry.leaf;
    });
    this.collections = normalized.collections;
  }

  collectionForLeaf(leaf: WorkspaceLeaf): TabCollection | undefined {
    return leaf.collectionId ? this.collections.find((collection) => collection.id === leaf.collectionId) : undefined;
  }

  createCollection(leaf: WorkspaceLeaf): TabCollection | null {
    if (!this.leaves.includes(leaf)) return null;
    const id = uniqueCollectionId(
      new Set(this.collections.map((collection) => collection.id)),
      () => `collection-${Date.now().toString(36)}-${++this.collectionCounter}`,
    );
    const collection: TabCollection = {
      id,
      name: "New collection",
      color: nextCollectionColor(this.collections),
      collapsed: false,
    };
    this.collections.push(collection);
    leaf.collectionId = id;
    this.normalizeCollections();
    this.renderTabs();
    this.workspace.trigger("layout-change");
    queueMicrotask(() => this.beginCollectionRename(collection));
    return collection;
  }

  addLeafToCollection(leaf: WorkspaceLeaf, collectionId: string, memberIndex?: number): boolean {
    if (!this.leaves.includes(leaf) || !this.collections.some((collection) => collection.id === collectionId)) return false;
    const current = this.leaves.indexOf(leaf);
    this.leaves.splice(current, 1);
    const members = this.leaves.filter((candidate) => candidate.collectionId === collectionId);
    const at = Math.max(0, Math.min(memberIndex ?? members.length, members.length));
    const insertion = members.length
      ? this.leaves.indexOf(members[Math.min(at, members.length - 1)]) + (at === members.length ? 1 : 0)
      : this.leaves.length;
    leaf.collectionId = collectionId;
    this.leaves.splice(insertion, 0, leaf);
    this.normalizeCollections();
    this.renderTabs();
    this.announce(`${leaf.getDisplayText()} moved to ${this.collectionForLeaf(leaf)?.name}, position ${at + 1} of ${this.leaves.filter((candidate) => candidate.collectionId === collectionId).length}`);
    this.workspace.trigger("layout-change");
    return true;
  }

  removeLeafFromCollection(leaf: WorkspaceLeaf): boolean {
    const collection = this.collectionForLeaf(leaf);
    if (!collection) return false;
    leaf.collectionId = undefined;
    this.normalizeCollections();
    this.renderTabs();
    this.announce(`${leaf.getDisplayText()} removed from ${collection.name}`);
    this.workspace.trigger("layout-change");
    return true;
  }

  toggleCollection(collectionId: string): void {
    const collection = this.collections.find((candidate) => candidate.id === collectionId);
    if (!collection) return;
    collection.collapsed = !collection.collapsed;
    this.renderTabs();
    this.workspace.trigger("layout-change");
  }

  renameCollection(collectionId: string, name: string): void {
    const collection = this.collections.find((candidate) => candidate.id === collectionId);
    if (!collection) return;
    collection.name = normalizeCollectionName(name);
    this.renderTabs();
    this.workspace.trigger("layout-change");
  }

  recolorCollection(collectionId: string, color: TabCollection["color"]): void {
    const collection = this.collections.find((candidate) => candidate.id === collectionId);
    if (!collection || !COLLECTION_COLORS.includes(color)) return;
    collection.color = color;
    this.renderTabs();
    this.workspace.trigger("layout-change");
  }

  moveCollection(collectionId: string, direction: -1 | 1): boolean {
    const blocks = collectionBlocks(this.leaves.map((leaf) => ({ id: leaf.id, collectionId: leaf.collectionId })));
    const blockIndex = blocks.findIndex((block) => block.kind === "collection" && block.collectionId === collectionId);
    const targetIndex = blockIndex + direction;
    if (blockIndex < 0 || targetIndex < 0 || targetIndex >= blocks.length) return false;
    const idToLeaf = new Map(this.leaves.map((leaf) => [leaf.id, leaf]));
    const reordered = [...blocks];
    [reordered[blockIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[blockIndex]];
    this.leaves = reordered.flatMap((block) => block.leafIds.map((id) => idToLeaf.get(id)!));
    this.renderTabs();
    this.workspace.trigger("layout-change");
    return true;
  }

  moveCollectionToIndex(collectionId: string, index: number): boolean {
    if (!this.collections.some((collection) => collection.id === collectionId)) return false;
    const tagged = this.leaves.map((leaf) => ({ leaf, id: leaf.id, collectionId: leaf.collectionId }));
    const reordered = moveCollectionBlock(tagged, collectionId, index);
    this.leaves = reordered.map((entry) => entry.leaf);
    this.renderTabs();
    this.workspace.trigger("layout-change");
    return true;
  }

  moveLeafStep(leaf: WorkspaceLeaf, direction: -1 | 1): boolean {
    const index = this.leaves.indexOf(leaf);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.leaves.length) return false;
    const targetLeaf = this.leaves[target];
    if (leaf.collectionId !== targetLeaf.collectionId) leaf.collectionId = undefined;
    this.leaves.splice(index, 1);
    this.leaves.splice(target, 0, leaf);
    this.normalizeCollections();
    this.renderTabs();
    this.workspace.trigger("layout-change");
    return true;
  }

  async closeCollection(collectionId: string): Promise<void> {
    await this.closeLeaves([...this.leaves].filter((candidate) => candidate.collectionId === collectionId));
  }

  async closeLeaves(leaves: readonly WorkspaceLeaf[]): Promise<Error[]> {
    const errors = await runAllSettled(leaves, (leaf) => leaf.detach());
    this.normalizeCollections();
    this.renderTabs();
    if (errors.length) {
      console.error("Failed to close one or more tabs", errors);
      this.app.notify(`${errors.length} tab${errors.length === 1 ? "" : "s"} could not be closed`);
    }
    return errors;
  }

  private announce(message: string): void {
    let live = this.containerEl.querySelector<HTMLElement>(".tab-collection-live-region");
    if (!live) {
      live = document.createElement("div");
      live.className = "tab-collection-live-region";
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      this.containerEl.appendChild(live);
    }
    live.textContent = message;
  }

  private showDropPreview(target: HTMLElement, placement: "before" | "after" | "inside", text: string): void {
    this.clearDropPreview();
    target.classList.add(`tab-drop-${placement}`);
    this.dropMarkerEl = target;
    let preview = this.tabBarEl.querySelector<HTMLElement>(".tab-drop-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "tab-drop-preview";
      preview.setAttribute("role", "status");
      this.tabBarEl.appendChild(preview);
    }
    preview.textContent = text;
  }

  private clearDropPreview(): void {
    this.dropMarkerEl?.classList.remove("tab-drop-before", "tab-drop-after", "tab-drop-inside");
    this.dropMarkerEl = null;
    this.tabBarEl.querySelector(".tab-drop-preview")?.remove();
  }

  beginCollectionRename(collection: TabCollection): void {
    const label = this.tabHeaderInnerEl.querySelector<HTMLElement>(`[data-collection-id="${CSS.escape(collection.id)}"]`);
    if (!label) return;
    const title = label.querySelector<HTMLElement>(".tab-collection-title");
    if (!title) return;
    const input = document.createElement("input");
    input.className = "tab-collection-rename";
    input.dataset.stripFocus = `collection:${collection.id}:surface`;
    input.value = collection.name;
    input.maxLength = 160;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      this.renameCollection(collection.id, input.value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); accept(); }
    });
    input.addEventListener("blur", accept, { once: true });
    title.replaceWith(input);
    input.focus();
    input.select();
  }

  private collectionMenu(event: MouseEvent, collection: TabCollection): void {
    event.preventDefault();
    event.stopPropagation();
    this.app.showMenu(event, [
      { title: "Rename collection", section: "collection", action: () => this.beginCollectionRename(collection) },
      { title: "Collection color", section: "color", submenu: COLLECTION_COLORS.map((color) => ({
        title: color,
        checked: collection.color === color,
        action: () => this.recolorCollection(collection.id, color),
      })) },
      { title: "Move collection left", section: "move", action: () => this.moveCollection(collection.id, -1) },
      { title: "Move collection right", section: "move", action: () => this.moveCollection(collection.id, 1) },
      { title: "Close tabs to the right", section: "close", action: async () => {
        const members = this.leaves.filter((leaf) => leaf.collectionId === collection.id);
        const last = members[members.length - 1];
        await this.closeLeaves([...this.leaves].slice(this.leaves.indexOf(last) + 1).filter((candidate) => !candidate.pinned));
      } },
      { title: "Close collection", warning: true, section: "close", action: () => void this.closeCollection(collection.id) },
    ]);
  }

  renderTabs() {
    const focused = document.activeElement instanceof HTMLElement && this.tabHeaderInnerEl.contains(document.activeElement)
      ? document.activeElement.dataset.stripFocus
      : undefined;
    this.normalizeCollections();
    this.tabHeaderInnerEl.innerHTML = "";
    const renderedCollections = new Set<string>();
    for (const leaf of this.leaves) {
      const collection = this.collectionForLeaf(leaf);
      if (collection && !renderedCollections.has(collection.id)) {
        renderedCollections.add(collection.id);
        const members = this.leaves.filter((candidate) => candidate.collectionId === collection.id);
        const ownsActive = !!this.active && this.active.collectionId === collection.id;
        const label = document.createElement("div");
        label.className = "tab-collection-label";
        label.dataset.collectionId = collection.id;
        label.dataset.color = collection.color;
        label.classList.toggle("is-collapsed", collection.collapsed);
        label.classList.toggle("is-active", ownsActive);
        label.setAttribute("role", "group");

        const disclosure = document.createElement("button");
        disclosure.type = "button";
        disclosure.className = "tab-collection-disclosure";
        disclosure.dataset.stripFocus = `collection:${collection.id}:disclosure`;
        disclosure.setAttribute("aria-label", `${collection.collapsed ? "Expand" : "Collapse"} ${collection.name}`);
        disclosure.setAttribute("aria-expanded", String(!collection.collapsed));
        disclosure.setAttribute("aria-controls", members.map((member) => `${member.id}-tab`).join(" "));
        setIcon(disclosure, collection.collapsed ? "chevron-right" : "chevron-down");
        disclosure.addEventListener("click", () => this.toggleCollection(collection.id));

        const surface = document.createElement("button");
        surface.type = "button";
        surface.className = "tab-collection-surface";
        surface.dataset.stripFocus = `collection:${collection.id}:surface`;
        const activeText = ownsActive ? `, active: ${this.active!.getDisplayText()}` : "";
        surface.setAttribute("aria-label", `${collection.name}, ${collection.color}, ${collection.collapsed ? "collapsed" : "expanded"}, ${members.length} tabs${activeText}`);
        surface.title = surface.getAttribute("aria-label")!;
        const title = document.createElement("span");
        title.className = "tab-collection-title";
        title.textContent = collection.name;
        const count = document.createElement("span");
        count.className = "tab-collection-count";
        count.textContent = String(members.length);
        surface.append(title, count);
        let renaming = false;
        surface.addEventListener("mousedown", (event) => {
          if (event.detail === 2) {
            event.preventDefault();
            renaming = true;
            this.beginCollectionRename(collection);
          }
        });
        surface.addEventListener("click", () => {
          if (!renaming) this.setActiveLeaf(ownsActive ? this.active! : members[0]);
        });
        label.addEventListener("contextmenu", (event) => this.collectionMenu(event, collection));
        label.draggable = true;
        label.addEventListener("dragstart", (event) => {
          draggingCollection = { group: this, id: collection.id };
          event.dataTransfer?.setData("text/plain", collection.id);
          label.classList.add("is-dragging");
        });
        label.addEventListener("dragend", () => { draggingCollection = null; label.classList.remove("is-dragging"); this.clearDropPreview(); });
        label.addEventListener("dragover", (event) => {
          if (draggingLeaf || draggingCollection?.group === this) {
            event.preventDefault();
            const crossGroupLeaf = !!draggingLeaf && draggingLeaf.group !== this;
            this.showDropPreview(
              label,
              draggingLeaf ? (crossGroupLeaf ? "before" : "inside") : "before",
              draggingLeaf
                ? crossGroupLeaf ? `Move ungrouped before ${collection.name}` : `Move to ${collection.name}`
                : `Move collection before ${collection.name}`,
            );
          }
        });
        label.addEventListener("dragleave", () => this.clearDropPreview());
        label.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.clearDropPreview();
          if (draggingLeaf) {
            if (draggingLeaf.group === this) this.addLeafToCollection(draggingLeaf, collection.id);
            else {
              const insertion = this.leaves.findIndex((candidate) => candidate.collectionId === collection.id);
              const displayText = draggingLeaf.getDisplayText();
              this.workspace.moveLeaf(draggingLeaf, this, insertion);
              this.announce(`${displayText} moved ungrouped before ${collection.name}`);
            }
          }
          else if (draggingCollection?.group === this) {
            const first = this.leaves.findIndex((candidate) => candidate.collectionId === collection.id);
            const sourceFirst = this.leaves.findIndex((candidate) => candidate.collectionId === draggingCollection!.id);
            const targetMembers = this.leaves.filter((candidate) => candidate.collectionId === collection.id);
            const insertion = sourceFirst < first
              ? this.leaves.indexOf(targetMembers[targetMembers.length - 1]) + 1
              : first;
            this.moveCollectionToIndex(draggingCollection.id, insertion);
          }
        });
        label.append(disclosure, surface);
        this.tabHeaderInnerEl.appendChild(label);
      }
      const tab = buildTabHeader(leaf, leaf === this.active);
      tab.id = `${leaf.id}-tab`;
      tab.dataset.stripFocus = `leaf:${leaf.id}`;
      tab.hidden = !!collection?.collapsed;
      tab.tabIndex = tab.hidden ? -1 : 0;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(leaf === this.active));
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
        this.clearDropPreview();
      };
      tab.addEventListener("dragover", (event) => {
        if (draggingCollection?.group === this || draggingLeaf) {
          event.preventDefault();
          const rect = tab.getBoundingClientRect();
          const fraction = (event.clientX - rect.left) / Math.max(1, rect.width);
          if (leaf.collectionId) {
            const members = this.leaves.filter((candidate) => candidate.collectionId === leaf.collectionId);
            const drop = classifyMemberDrop(members.indexOf(leaf), members.length, fraction);
            this.showDropPreview(tab, drop.kind === "join" ? (fraction < 0.5 ? "before" : "after") : drop.kind === "ungrouped-before" ? "before" : "after", drop.kind === "join" ? `Move within ${this.collectionForLeaf(leaf)?.name}` : "Ungrouped");
          } else {
            this.showDropPreview(tab, fraction < 0.5 ? "before" : "after", "Ungrouped");
          }
        }
      });
      tab.addEventListener("dragleave", () => this.clearDropPreview());
      tab.addEventListener("drop", (event) => {
        this.clearDropPreview();
        if (draggingLeaf && leaf.collectionId && draggingLeaf !== leaf) {
          event.preventDefault();
          event.stopPropagation();
          const members = this.leaves.filter((candidate) => candidate.collectionId === leaf.collectionId);
          const rect = tab.getBoundingClientRect();
          const drop = classifyMemberDrop(members.indexOf(leaf), members.length, (event.clientX - rect.left) / Math.max(1, rect.width));
          if (drop.kind === "join") this.addLeafToCollection(draggingLeaf, leaf.collectionId, drop.memberIndex);
          else {
            draggingLeaf.collectionId = undefined;
            const edge = drop.kind === "ungrouped-before" ? this.leaves.indexOf(members[0]) : this.leaves.indexOf(members[members.length - 1]) + 1;
            this.workspace.moveLeaf(draggingLeaf, this, edge);
          }
          return;
        }
        if (draggingLeaf && !leaf.collectionId && draggingLeaf !== leaf) {
          event.preventDefault();
          event.stopPropagation();
          const rect = tab.getBoundingClientRect();
          const before = event.clientX < rect.left + rect.width / 2;
          draggingLeaf.collectionId = undefined;
          this.workspace.moveLeaf(draggingLeaf, this, this.leaves.indexOf(leaf) + (before ? 0 : 1));
          return;
        }
        if (draggingCollection?.group === this) {
          event.preventDefault();
          event.stopPropagation();
          this.moveCollectionToIndex(draggingCollection.id, this.leaves.indexOf(leaf));
        }
      });
      this.tabHeaderInnerEl.appendChild(tab);
    }
    const spacer = document.createElement("div");
    spacer.className = "workspace-tab-header-spacer";
    this.tabHeaderInnerEl.appendChild(spacer);
    this.installTabKeyboardNavigation();
    if (focused) this.tabHeaderInnerEl.querySelector<HTMLElement>(`[data-strip-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  private installTabKeyboardNavigation(): void {
    const logical: Array<{ target: HTMLElement; controls: HTMLElement[] }> = [];
    for (const child of this.tabHeaderInnerEl.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains("tab-collection-label")) {
        const surface = child.querySelector<HTMLElement>(".tab-collection-surface");
        const disclosure = child.querySelector<HTMLElement>(".tab-collection-disclosure");
        if (surface && disclosure) logical.push({ target: surface, controls: [disclosure, surface] });
      } else if (child.classList.contains("workspace-tab-header") && !child.hidden) {
        logical.push({ target: child, controls: [child] });
      }
    }
    logical.forEach((entry, logicalIndex) => {
      for (const control of entry.controls) control.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const next = tabStripNavigationIndex(event.key, logicalIndex, logical.length);
        event.preventDefault();
        logical[next]?.target.focus();
      };
    });
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
  closeDrawerEl: HTMLButtonElement;
  views: View[] = [];
  leaves: WorkspaceLeaf[] = [];
  /** Vertically stacked leaf containers; the legacy sidebar itself is the first group. */
  groups: LeafContainer[] = [this];
  groupSizes: number[] = [1];
  private groupDividers: HTMLElement[] = [];
  active: SidebarItem | null = null;
  private mobilePresented: SidebarItem | null = null;
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
    this.closeDrawerEl = document.createElement("button");
    this.closeDrawerEl.type = "button";
    this.closeDrawerEl.className = "clickable-icon mobile-drawer-close";
    this.closeDrawerEl.setAttribute(
      "aria-label",
      this.side === "left" ? "Close files drawer" : "Close details drawer"
    );
    setIcon(this.closeDrawerEl, "x");
    this.closeDrawerEl.addEventListener("click", () => this.app.workspace.closeMobileDrawers());
    this.tabHeaderContainerEl.appendChild(this.closeDrawerEl);
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
    // Compact drawers have CSS-owned presentation geometry. Preserve the
    // user's docked width verbatim so merely restoring on a phone cannot
    // rewrite the desktop/tablet layout snapshot.
    const effectiveMax = this.app.workspace?.isCompactMobile()
      ? SIDEBAR_MAX_WIDTH
      : Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth * 0.5);
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
    this.tabHeaderContainerEl.appendChild(this.closeDrawerEl);
    for (const item of this.leaves as SidebarItem[]) {
      if (this.isLeaf(item) && !item.view) continue; // no tab until a view is mounted
      this.tabHeaderInnerEl.appendChild(this.buildSidebarTab(item, item === (this.mobilePresented ?? this.active)));
    }
  }

  presentMobile(item: SidebarItem): void {
    const resolved = this.isLeaf(item) ? item : this.leaves.find((leaf) => leaf.view === item);
    if (!resolved) return;
    this.mobilePresented = resolved;
    this.contentEl.innerHTML = "";
    const { el } = this.metaOf(resolved);
    if (el) this.contentEl.appendChild(el);
    void resolved.ensureOpen();
    resolved.view?.onReveal?.();
    this.renderIcons();
  }

  restorePersistentPresentation(): void {
    if (!this.mobilePresented) return;
    this.mobilePresented = null;
    this.contentEl.innerHTML = "";
    if (this.active) {
      const { el } = this.metaOf(this.active);
      if (el) this.contentEl.appendChild(el);
    }
    this.renderIcons();
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
  /** v3 center-tab collection membership. Absent for sidebars and ungrouped tabs. */
  collectionId?: string;
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
  /** v3 center-only split-local collection registry. */
  collections?: TabCollection[];
}

export interface PersistedSplitNode {
  type: "split";
  direction: "horizontal" | "vertical";
  sizes: number[];
  children: WorkspaceTreeNode[];
}

export type WorkspaceTreeNode = PersistedTabNode | PersistedSplitNode;

export function normalizeCenterGroupSizes(sizes: readonly number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  const equal = () => Array.from({ length: count }, () => 1 / count);
  if (!sizes || sizes.length !== count || sizes.some((size) => !Number.isFinite(size) || size <= 0)) return equal();
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total) || total <= 0) return equal();
  return sizes.map((size) => size / total);
}

/** Insert after `donorIndex`, retaining `leadingRatio` in the donor pane. */
export function insertCenterGroupSize(
  sizes: readonly number[],
  donorIndex: number,
  leadingRatio = 0.5
): number[] {
  if (sizes.length === 0) return [1];
  const normalized = normalizeCenterGroupSizes(sizes, sizes.length);
  const donor = Math.max(0, Math.min(donorIndex, normalized.length - 1));
  const ratio = Number.isFinite(leadingRatio) && leadingRatio > 0 && leadingRatio < 1 ? leadingRatio : 0.5;
  const allocation = normalized[donor];
  const result = [...normalized];
  result.splice(donor, 1, allocation * ratio, allocation * (1 - ratio));
  return result;
}

export function removeCenterGroupSize(sizes: readonly number[], index: number): number[] {
  if (sizes.length <= 1) return [];
  const result = normalizeCenterGroupSizes(sizes, sizes.length).filter((_, i) => i !== index);
  return normalizeCenterGroupSizes(result, result.length);
}

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

export interface PersistedWorkspaceV3 extends Omit<PersistedWorkspaceV2, "version"> {
  version: 3;
}

export type PersistedWorkspace = PersistedWorkspaceV1 | PersistedWorkspaceV2 | PersistedWorkspaceV3;

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
export function migrateWorkspaceLayout(state: PersistedWorkspace): PersistedWorkspaceV3 {
  const normalizeNode = (node: WorkspaceTreeNode | null, center: boolean): WorkspaceTreeNode | null => {
    if (!node || (node as WorkspaceTreeNode).type !== "tabs" && (node as WorkspaceTreeNode).type !== "split") return null;
    if (node.type === "split") {
      const children = Array.isArray(node.children)
        ? node.children.map((child) => normalizeNode(child, center)).filter((child): child is WorkspaceTreeNode => !!child)
        : [];
      return { ...node, children, sizes: Array.isArray(node.sizes) ? node.sizes : children.map(() => 1 / Math.max(1, children.length)) };
    }
    const rawLeaves = Array.isArray(node.leaves) ? node.leaves : [];
    if (!center) {
      return {
        ...node,
        leaves: rawLeaves.map(({ collectionId: _ignored, ...leaf }) => leaf),
        active: Number.isInteger(node.active) && node.active >= 0 && node.active < rawLeaves.length ? node.active : 0,
      };
    }
    const activeLeaf = rawLeaves[Number.isInteger(node.active) ? node.active : 0];
    const tagged = rawLeaves.map((leaf, index) => ({ ...leaf, id: `persisted-${index}` }));
    const normalized = normalizeTabCollections(tagged, Array.isArray(node.collections) ? node.collections : []);
    const leaves = normalized.leaves.map(({ id: _ignored, ...leaf }) => leaf);
    const active = activeLeaf ? normalized.leaves.findIndex((leaf) => rawLeaves[Number(leaf.id.slice(10))] === activeLeaf) : -1;
    return { ...node, leaves, active: active >= 0 ? active : 0, collections: normalized.collections };
  };

  if (state.version === 2 || state.version === 3) {
    const stripCollections = (node: WorkspaceTreeNode | null): WorkspaceTreeNode | null => {
      if (!node) return null;
      if (node.type === "split") return { ...node, children: node.children.map(stripCollections).filter((child): child is WorkspaceTreeNode => !!child) };
      return {
        ...node,
        collections: [],
        leaves: node.leaves.map(({ collectionId: _ignored, ...leaf }) => leaf),
      };
    };
    const centerRoot = state.version === 2 ? stripCollections(state.center?.root ?? null) : state.center?.root ?? null;
    return {
      ...state,
      version: 3,
      center: { ...state.center, root: normalizeNode(centerRoot, true) },
      left: { ...state.left, root: normalizeNode(state.left?.root ?? null, false) },
      right: { ...state.right, root: normalizeNode(state.right?.root ?? null, false) },
    };
  }
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
    version: 3,
    center: { root: normalizeNode(centerRoot, true), activeGroup: state.activeGroup },
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
  mobileDrawerBackdropEl: HTMLButtonElement;
  groups: TabGroup[] = [];
  centerGroupSizes: number[] = [];
  private centerDividers: HTMLElement[] = [];
  private activeCenterResizeCleanup: (() => void) | null = null;
  activeGroup: TabGroup;
  /** viewType -> factory, populated by `Plugin.registerView` (see plugin.ts). */
  private viewFactories = new Map<string, (leaf: WorkspaceLeaf) => View>();
  /** Built-in sidebar view types, recorded by `Sidebar.addView`. Never deferred. */
  private builtinViewTypes = new Set<string>();
  private compactQuery: MediaQueryList;
  private tabletQuery: MediaQueryList;
  private drawerOpener: HTMLElement | null = null;
  private drawerSide: "left" | "right" | null = null;
  private readonly breakpointHandler = () => this.handleBreakpointChange();
  private readonly documentKeyHandler = (event: KeyboardEvent) => this.handleDrawerKeydown(event);

  constructor(public app: App, parentEl: HTMLElement) {
    super();
    this.rootEl = document.createElement("div");
    this.rootEl.className = "workspace";
    this.leftSidebar = new Sidebar("left", this.app);
    this.rightSidebar = new Sidebar("right", this.app);
    this.mobileDrawerBackdropEl = document.createElement("button");
    this.mobileDrawerBackdropEl.type = "button";
    this.mobileDrawerBackdropEl.className = "mobile-drawer-backdrop";
    this.mobileDrawerBackdropEl.setAttribute("aria-label", "Close navigation drawer");
    this.mobileDrawerBackdropEl.addEventListener("click", () => this.closeMobileDrawers());
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
    this.rootEl.appendChild(this.mobileDrawerBackdropEl);
    parentEl.appendChild(this.rootEl);
    this.compactQuery = window.matchMedia("(max-width: 700px)");
    this.tabletQuery = window.matchMedia("(max-width: 900px)");
    this.compactQuery.addEventListener("change", this.breakpointHandler);
    this.tabletQuery.addEventListener("change", this.breakpointHandler);
    document.addEventListener("keydown", this.documentKeyHandler, true);
    this.activeGroup = this.addGroup();
    this.on("file-open", () => this.closeMobileDrawers(false));
    this.syncAdaptivePresentation();
  }

  isCompactMobile(): boolean {
    return document.body.classList.contains("is-mobile") && this.compactQuery.matches;
  }

  private usesDrawer(side: "left" | "right"): boolean {
    if (!document.body.classList.contains("is-mobile")) return false;
    return this.compactQuery.matches || (side === "right" && this.tabletQuery.matches);
  }

  private setDrawerBackgroundInert(inert: boolean, target?: Sidebar): void {
    this.centerEl.inert = inert;
    const other = target === this.leftSidebar ? this.rightSidebar : this.leftSidebar;
    other.containerEl.inert = inert;
    const navigation = this.rootEl.closest(".app-shell")?.querySelector<HTMLElement>(".mobile-navigation");
    if (navigation) navigation.inert = inert;
  }

  private handleDrawerKeydown(event: KeyboardEvent): void {
    if (!this.drawerSide) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeMobileDrawers();
      return;
    }
    if (event.key !== "Tab") return;
    const target = this.drawerSide === "left" ? this.leftSidebar : this.rightSidebar;
    const focusable = [...target.containerEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hidden && getComputedStyle(element).display !== "none");
    if (!focusable.length) {
      event.preventDefault();
      target.closeDrawerEl.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private handleBreakpointChange(): void {
    this.closeMobileDrawers();
    if (!this.compactQuery.matches) this.leftSidebar.restorePersistentPresentation();
    if (!this.tabletQuery.matches) this.rightSidebar.restorePersistentPresentation();
    this.syncSidebarToggleButtons();
    this.syncAdaptivePresentation();
  }

  openMobileDrawer(side: "left" | "right", opener?: HTMLElement): void {
    if (!this.usesDrawer(side)) return;
    const target = side === "left" ? this.leftSidebar : this.rightSidebar;
    const other = side === "left" ? this.rightSidebar : this.leftSidebar;
    this.drawerOpener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.drawerSide = side;
    other.containerEl.classList.remove("is-mobile-drawer-open");
    target.containerEl.classList.add("is-mobile-drawer-open");
    target.containerEl.setAttribute("role", "dialog");
    target.containerEl.setAttribute("aria-modal", "true");
    target.containerEl.setAttribute("aria-label", side === "left" ? "Files and search" : "Details");
    this.rootEl.classList.add("mobile-drawer-active");
    this.setDrawerBackgroundInert(true, target);
    target.containerEl.inert = false;
    target.closeDrawerEl.focus();
  }

  closeMobileDrawers(restoreFocus = true): void {
    const opener = this.drawerOpener;
    this.leftSidebar.containerEl.classList.remove("is-mobile-drawer-open");
    this.rightSidebar.containerEl.classList.remove("is-mobile-drawer-open");
    for (const sidebar of [this.leftSidebar, this.rightSidebar]) {
      sidebar.containerEl.removeAttribute("role");
      sidebar.containerEl.removeAttribute("aria-modal");
      sidebar.containerEl.removeAttribute("aria-label");
      sidebar.containerEl.inert = false;
    }
    this.rootEl.classList.remove("mobile-drawer-active");
    this.centerEl.inert = false;
    const navigation = this.rootEl.closest(".app-shell")?.querySelector<HTMLElement>(".mobile-navigation");
    if (navigation) navigation.inert = false;
    this.drawerSide = null;
    this.drawerOpener = null;
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    // `overflow: hidden` made the workspace programmatically scrollable on
    // WebKit/Chromium. Moving a focused drawer offscreen could therefore leave
    // the center pane shifted left after an orientation change.
    this.rootEl.scrollLeft = 0;
  }

  toggleSidebar(side: "left" | "right", opener?: HTMLElement): void {
    const sidebar = side === "left" ? this.leftSidebar : this.rightSidebar;
    if (!this.usesDrawer(side)) {
      sidebar.toggle();
      return;
    }
    if (sidebar.containerEl.classList.contains("is-mobile-drawer-open")) this.closeMobileDrawers();
    else this.openMobileDrawer(side, opener);
  }

  presentMobileSidebarLeaf(side: "left" | "right", leaf: WorkspaceLeaf, opener: HTMLElement): void {
    const sidebar = side === "left" ? this.leftSidebar : this.rightSidebar;
    if (!this.usesDrawer(side)) {
      this.revealLeaf(leaf);
      return;
    }
    sidebar.presentMobile(leaf);
    this.openMobileDrawer(side, opener);
  }

  presentCurrentMobileSidebar(side: "left" | "right", opener: HTMLElement): void {
    const sidebar = side === "left" ? this.leftSidebar : this.rightSidebar;
    if (sidebar.active) sidebar.presentMobile(sidebar.active);
    this.openMobileDrawer(side, opener);
  }

  syncAdaptivePresentation(): void {
    const compact = this.isCompactMobile();
    for (const group of this.groups) {
      group.containerEl.classList.toggle("is-mobile-center-active", compact && group === this.activeGroup);
    }
  }

  dispose(): void {
    this.activeCenterResizeCleanup?.();
    this.compactQuery.removeEventListener("change", this.breakpointHandler);
    this.tabletQuery.removeEventListener("change", this.breakpointHandler);
    document.removeEventListener("keydown", this.documentKeyHandler, true);
    this.closeMobileDrawers(false);
  }

  async prepareVaultSwitch(): Promise<void> {
    const views: View[] = [];
    this.iterateLeaves((leaf) => { if (leaf.view) views.push(leaf.view); });
    try {
      for (const view of views) await view.prepareVaultSwitch?.();
    } catch (error) {
      for (const view of views) view.cancelVaultSwitch?.();
      throw error;
    }
  }

  cancelVaultSwitch(): void {
    this.iterateLeaves((leaf) => leaf.view?.cancelVaultSwitch?.());
  }

  async pauseAutosave(): Promise<void> {
    const views: View[] = [];
    this.iterateLeaves((leaf) => { if (leaf.view) views.push(leaf.view); });
    const paused: View[] = [];
    try {
      for (const view of views) {
        paused.push(view);
        await view.pauseAutosave?.();
      }
    } catch (error) {
      for (const view of paused.reverse()) view.resumeAutosave?.();
      throw error;
    }
  }

  resumeAutosave(): void {
    this.iterateLeaves((leaf) => leaf.view?.resumeAutosave?.());
  }

  async closeAllLeaves(): Promise<void> {
    const leaves: WorkspaceLeaf[] = [];
    this.iterateLeaves((leaf) => leaves.push(leaf));
    for (const leaf of leaves) await leaf.detach();
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

  addGroup(after?: TabGroup, leadingRatio = 0.5): TabGroup {
    const group = new TabGroup(this, this.app);
    const donorIndex = after ? this.groups.indexOf(after) : Math.max(0, this.groups.length - 1);
    this.centerGroupSizes = insertCenterGroupSize(this.centerGroupSizes, donorIndex, leadingRatio);
    if (after) {
      const i = this.groups.indexOf(after);
      this.groups.splice(i + 1, 0, group);
      after.containerEl.after(group.containerEl);
    } else {
      this.groups.push(group);
      this.centerEl.appendChild(group.containerEl);
    }
    this.layoutCenterGroups();
    this.syncSidebarToggleButtons();
    this.syncAdaptivePresentation();
    this.trigger("layout-change");
    return group;
  }

  private layoutCenterGroups(): void {
    this.centerGroupSizes = normalizeCenterGroupSizes(this.centerGroupSizes, this.groups.length);
    while (this.centerDividers.length < Math.max(0, this.groups.length - 1)) {
      const divider = document.createElement("div");
      divider.className = "workspace-split-resize-handle workspace-center-resize-handle";
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-orientation", "vertical");
      divider.setAttribute("aria-valuemin", "0");
      divider.setAttribute("aria-valuemax", "100");
      divider.tabIndex = 0;
      this.centerEl.appendChild(divider);
      this.centerDividers.push(divider);
      this.attachCenterResize(divider);
    }
    while (this.centerDividers.length > Math.max(0, this.groups.length - 1)) {
      this.centerDividers.pop()?.remove();
    }
    this.groups.forEach((group, index) => {
      group.containerEl.style.order = `${index * 2}`;
      group.containerEl.style.flex = `1 1 ${this.centerGroupSizes[index] * 100}%`;
    });
    this.centerDividers.forEach((divider, index) => {
      divider.style.order = `${index * 2 + 1}`;
      const pairShare = this.centerGroupSizes[index] + this.centerGroupSizes[index + 1];
      const value = pairShare > 0 ? Math.round(this.centerGroupSizes[index] / pairShare * 100) : 50;
      divider.setAttribute("aria-valuenow", `${value}`);
      divider.setAttribute("aria-label", `Resize panes (${value}% / ${100 - value}%)`);
    });
  }

  private resizeCenterPair(dividerIndex: number, leadingShare: number): void {
    const leading = this.groups[dividerIndex]?.containerEl;
    const trailing = this.groups[dividerIndex + 1]?.containerEl;
    if (!leading || !trailing) return;
    const pairShare = this.centerGroupSizes[dividerIndex] + this.centerGroupSizes[dividerIndex + 1];
    const total = leading.getBoundingClientRect().width + trailing.getBoundingClientRect().width;
    const minimumShare = total > 0 ? pairShare * Math.min(240, total / 2) / total : 0;
    const clamped = Math.max(minimumShare, Math.min(pairShare - minimumShare, leadingShare));
    this.centerGroupSizes[dividerIndex] = clamped;
    this.centerGroupSizes[dividerIndex + 1] = pairShare - clamped;
    this.layoutCenterGroups();
  }

  private attachCenterResize(handle: HTMLElement): void {
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const dividerIndex = this.centerDividers.indexOf(handle);
      const pairShare = this.centerGroupSizes[dividerIndex] + this.centerGroupSizes[dividerIndex + 1];
      const delta = pairShare * 0.05 * (event.key === "ArrowRight" ? 1 : -1);
      this.resizeCenterPair(dividerIndex, this.centerGroupSizes[dividerIndex] + delta);
      this.trigger("layout-change");
    });
    handle.addEventListener("pointerdown", (event) => {
      if (this.isCompactMobile()) return;
      event.preventDefault();
      this.activeCenterResizeCleanup?.();
      const dividerIndex = this.centerDividers.indexOf(handle);
      const leading = this.groups[dividerIndex]?.containerEl;
      const trailing = this.groups[dividerIndex + 1]?.containerEl;
      if (!leading || !trailing) return;
      const startX = event.clientX;
      const leadingStart = leading.getBoundingClientRect().width;
      const trailingStart = trailing.getBoundingClientRect().width;
      const total = leadingStart + trailingStart;
      const pairShare = this.centerGroupSizes[dividerIndex] + this.centerGroupSizes[dividerIndex + 1];
      const minimum = Math.min(240, total / 2);
      let finished = false;
      const move = (moveEvent: PointerEvent) => {
        const leadingPx = Math.max(minimum, Math.min(total - minimum, leadingStart + moveEvent.clientX - startX));
        this.resizeCenterPair(dividerIndex, pairShare * leadingPx / total);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        handle.removeEventListener("pointercancel", finish);
        handle.removeEventListener("lostpointercapture", finish);
        handle.classList.remove("is-resizing");
        if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        if (this.activeCenterResizeCleanup === finish) this.activeCenterResizeCleanup = null;
        this.trigger("layout-change");
      };
      handle.classList.add("is-resizing");
      try { handle.setPointerCapture(event.pointerId); } catch { /* Synthetic events may not own a native pointer. */ }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      this.activeCenterResizeCleanup = finish;
    });
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
      const leftLabel = this.isCompactMobile()
        ? "Open files drawer"
        : this.leftSidebar.collapsed ? "Expand sidebar" : "Collapse sidebar";
      group.leftToggleEl.setAttribute("aria-label", leftLabel);
      group.leftToggleEl.title = leftLabel;
      const rightLabel = this.isCompactMobile()
        ? "Open details drawer"
        : this.rightSidebar.collapsed ? "Expand sidebar" : "Collapse sidebar";
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
    this.centerGroupSizes = removeCenterGroupSize(this.centerGroupSizes, i);
    this.groups.splice(i, 1);
    group.containerEl.remove();
    this.layoutCenterGroups();
    this.setActiveGroup(this.groups[Math.max(0, i - 1)]);
    this.trigger("layout-change");
  }

  setActiveGroup(group: TabGroup) {
    const previousLeaf = this.getActiveLeaf();
    this.activeGroup = group;
    this.syncAdaptivePresentation();
    const nextLeaf = this.getActiveLeaf();
    if (nextLeaf !== previousLeaf) this.trigger("active-leaf-change", nextLeaf);
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

  /** Geode extension: split the active center allocation with an explicit leading/trailing ratio. */
  splitActiveLeafWithRatio(_direction: "vertical" | "horizontal", leadingRatio: number): WorkspaceLeaf {
    const group = this.addGroup(this.activeGroup, leadingRatio);
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

  /** Find the leaf hosting this exact view instance (safe when one file is open more than once). */
  findLeafForView(view: View): WorkspaceLeaf | null {
    let match: WorkspaceLeaf | null = null;
    this.iterateLeaves((leaf) => {
      if (!match && leaf.view === view) match = leaf;
    });
    return match;
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
  async unregisterViewFactory(viewType: string): Promise<void> {
    this.viewFactories.delete(viewType);
    if (!this.isDeferrableViewType(viewType)) {
      await this.detachLeavesOfType(viewType);
      return;
    }
    const teardowns: Promise<void>[] = [];
    for (const leaf of this.getLeavesOfType(viewType)) {
      if (isDeferredView(leaf.view)) continue;
      teardowns.push(leaf.setView(this.createDeferredView(this.captureLeafForDeferral(leaf, viewType))));
    }
    await Promise.all(teardowns);
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
  async detachLeavesOfType(viewType: string): Promise<void> {
    await Promise.all(this.getLeavesOfType(viewType).map((leaf) => leaf.detach()));
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
  serialize(): PersistedWorkspaceV3 {
    const activeGroup = Math.max(0, this.groups.indexOf(this.activeGroup));
    const nodeFor = (container: Sidebar | TabGroup): PersistedTabNode => {
      const leaves = container.leaves
        .map((leaf) => ({ leaf, persisted: this.serializeLeaf(leaf) }))
        .filter((item): item is { leaf: WorkspaceLeaf; persisted: PersistedLeaf } => !!item.persisted);
      const active = container.active instanceof WorkspaceLeaf
        ? Math.max(0, leaves.findIndex((item) => item.leaf === container.active))
        : 0;
      const candidateLeaves = leaves.map((item) => ({
        id: item.leaf.id,
        persisted: item.persisted,
        collectionId: container instanceof TabGroup && !container.sidebar ? item.leaf.collectionId : undefined,
      }));
      const subset = container instanceof TabGroup && !container.sidebar
        ? normalizeSerializedCollectionSubset(candidateLeaves, container.collections)
        : { leaves: candidateLeaves.map((item) => ({ ...item, collectionId: undefined })), collections: [] };
      const persistedLeaves = subset.leaves.map((item) => item.collectionId
        ? { ...item.persisted, collectionId: item.collectionId }
        : item.persisted);
      return {
        type: "tabs",
        leaves: persistedLeaves,
        active,
        ...(container instanceof TabGroup && !container.sidebar ? { collections: subset.collections.map((collection) => ({ ...collection })) } : {}),
      };
    };
    const regionRoot = (containers: (Sidebar | TabGroup)[], direction: "horizontal" | "vertical", sizes?: number[]): WorkspaceTreeNode => {
      const children = containers.map(nodeFor);
      return children.length === 1 ? children[0] : {
        type: "split", direction, sizes: sizes?.length === children.length ? sizes : children.map(() => 1 / children.length), children,
      };
    };
    return {
      version: 3,
      center: { root: regionRoot(this.groups, "horizontal", this.centerGroupSizes), activeGroup },
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
    this.centerGroupSizes = normalizeCenterGroupSizes(
      state.center.root?.type === "split" ? state.center.root.sizes : undefined,
      this.groups.length
    );
    this.layoutCenterGroups();
    for (let gi = 0; gi < this.groups.length; gi++) {
      const group = this.groups[gi];
      const gs = centerNodes[gi];
      if (gs?.type === "tabs") {
        // Do not install the registry until all leaves exist: createLeaf()
        // renders/normalizes after each addition, when no restored membership
        // has been assigned yet, and would correctly (but prematurely) prune it.
        const restoredCollections = (gs.collections ?? []).map((collection) => ({ ...collection }));
        group.collections = [];
        const restored: Array<{ leaf: WorkspaceLeaf; sourceIndex: number; collectionId?: string }> = [];
        for (let sourceIndex = 0; sourceIndex < gs.leaves.length; sourceIndex++) {
          const ls = gs.leaves[sourceIndex];
          if ((ls.type === "markdown" || ls.type === "canvas") && ls.file && !this.app.vault.getFileByPath(ls.file)) continue;
          const factory = this.getViewFactory(ls.type);
          const existingBuiltin = ls.type !== "markdown" && ls.type !== "empty" && !factory
            ? pickExistingBuiltinLeaf(this.getLeavesOfType(ls.type), preExisting)
            : undefined;
          if (existingBuiltin) {
            this.moveLeaf(existingBuiltin, group);
            if (ls.pinned) existingBuiltin.setPinned(true);
            existingBuiltin.collectionId = ls.collectionId;
            restored.push({ leaf: existingBuiltin, sourceIndex, collectionId: ls.collectionId });
          } else {
            const leaf = group.createLeaf();
            await this.restoreLeafView(leaf, ls);
            leaf.collectionId = ls.collectionId;
            restored.push({ leaf, sourceIndex, collectionId: ls.collectionId });
          }
        }
        const normalized = normalizeTabCollections(
          restored.map((entry) => ({ ...entry, id: entry.leaf.id })),
          restoredCollections,
        );
        group.collections = normalized.collections;
        const restoredByLeaf = new Map(normalized.leaves.map((entry) => [entry.leaf, entry]));
        group.leaves = normalized.leaves.map((entry) => entry.leaf);
        for (const entry of normalized.leaves) entry.leaf.collectionId = entry.collectionId;
        // Collection metadata is installed after every leaf exists so the
        // incremental createLeaf() renders cannot prune partial membership.
        // Render that completed registry explicitly: the chosen leaf may
        // already be active, and the runtime same-leaf contract is a no-op.
        group.renderTabs();
        const chosen = selectNearestSurvivor(normalized.leaves, gs.active);
        if (chosen && restoredByLeaf.has(chosen.leaf)) group.setActiveLeaf(chosen.leaf);
      }
      if (group.leaves.length === 0) {
        const leaf = group.createLeaf();
        await leaf.setView(this.app.createEmptyView());
      }
      const active = group.active || group.leaves[0];
      if (active) group.setActiveLeaf(active);
    }
    const ag = this.groups[state.center.activeGroup ?? 0] ?? this.groups[0];
    if (ag?.active) ag.setActiveLeaf(ag.active);
    return true;
  }
}
