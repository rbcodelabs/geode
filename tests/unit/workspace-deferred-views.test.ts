import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Workspace,
  WorkspaceLeaf,
  describeViewForPlaceholder,
  isDeferrableViewType,
  pickExistingBuiltinLeaf,
  type PersistedLeaf,
  type View,
} from "../../src/renderer/workspace";
import { DeferredView, isDeferredView } from "../../src/renderer/views/deferred-view";

// vitest.config.mts runs in the `node` environment (no jsdom), so DeferredView's
// constructor needs a document stub. Only the handful of members it touches.
function stubDocument(): void {
  vi.stubGlobal("document", {
    createElement: () => ({
      className: "",
      textContent: "",
      hidden: false,
      append(...children: unknown[]) {
        (this as { children?: unknown[] }).children = children;
      },
    }),
  });
}

beforeEach(stubDocument);
afterEach(() => vi.unstubAllGlobals());

/**
 * A Workspace built off the prototype with only the fields the methods under
 * test read — the pattern established in workspace-public-contracts.test.ts.
 */
function fakeWorkspace(leaves: WorkspaceLeaf[]): Workspace {
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    activeGroup: { active: leaves[0] ?? null, leaves },
    groups: [{ leaves }],
    leftSidebar: { groups: [] },
    rightSidebar: { groups: [] },
    viewFactories: new Map<string, unknown>(),
    builtinViewTypes: new Set<string>(),
  });
  return workspace;
}

/** A leaf whose view can be swapped, recording what it was asked to mount. */
function fakeLeaf(view: View | null): WorkspaceLeaf & { setViewStateCalls: unknown[] } {
  const leaf = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf & {
    setViewStateCalls: unknown[];
  };
  Object.assign(leaf, {
    view,
    pinned: false,
    setViewStateCalls: [] as unknown[],
    async setView(next: View) {
      (leaf as { view: View }).view = next;
    },
  });
  return leaf;
}

describe("DeferredView", () => {
  it("impersonates the persisted type and carries state, title and icon", () => {
    const state = { boardId: 7, scroll: 120 };
    const view = new DeferredView({
      type: "claude-threads-kanban",
      state,
      title: "Kanban",
      icon: "layout-dashboard",
    });

    expect(view.viewType).toBe("claude-threads-kanban");
    // Identity, not a structural copy: the state must survive untouched.
    expect(view.getState()).toBe(state);
    expect(view.getDisplayText()).toBe("Kanban");
    expect(view.getIcon()).toBe("layout-dashboard");
    expect(isDeferredView(view)).toBe(true);
  });

  it("falls back to the raw type and a real icon id when none was persisted", () => {
    const view = new DeferredView({ type: "some-plugin-pane" });
    expect(view.getDisplayText()).toBe("some-plugin-pane");
    // Must be a resolvable icon: sidebar tabs are icon-only, so an empty icon
    // renders a deferred pane as an invisible strip entry.
    expect(view.getIcon()).toBe("puzzle");
  });
});

describe("serializeLeaf with a deferred leaf", () => {
  const serialize = (workspace: Workspace, leaf: WorkspaceLeaf): PersistedLeaf | null =>
    (Workspace.prototype as unknown as {
      serializeLeaf(this: Workspace, leaf: WorkspaceLeaf): PersistedLeaf | null;
    }).serializeLeaf.call(workspace, leaf);

  it("round-trips a still-deferred leaf byte-for-byte", () => {
    const persisted: PersistedLeaf = {
      type: "claude-threads-kanban",
      state: { boardId: 7 },
      pinned: false,
      title: "Kanban",
      icon: "layout-dashboard",
    };
    const leaf = fakeLeaf(
      new DeferredView({
        type: persisted.type,
        state: persisted.state,
        title: persisted.title,
        icon: persisted.icon,
      })
    );
    const workspace = fakeWorkspace([leaf]);

    expect(serialize(workspace, leaf)).toEqual(persisted);
  });

  it("captures title and icon from a live view so a later placeholder can be labelled", () => {
    const leaf = fakeLeaf({
      viewType: "probe-pane",
      containerEl: null as unknown as HTMLElement,
      getDisplayText: () => "Probe Pane",
      getIcon: () => "star",
      getState: () => ({ n: 1 }),
      onOpen() {},
      onClose() {},
    });
    const workspace = fakeWorkspace([leaf]);

    expect(serialize(workspace, leaf)).toEqual({
      type: "probe-pane",
      state: { n: 1 },
      pinned: false,
      title: "Probe Pane",
      icon: "star",
    });
  });
});

describe("describeViewForPlaceholder", () => {
  it("degrades to no title/icon rather than losing the save when a view's accessor throws", () => {
    const hostile = {
      viewType: "hostile",
      getDisplayText() { throw new Error("boom"); },
      getIcon() { throw new Error("boom"); },
    } as unknown as View;

    expect(describeViewForPlaceholder(hostile)).toEqual({});
  });
});

describe("isDeferrableViewType", () => {
  const builtins = new Set([
    "file-explorer",
    "search",
    "backlinks",
    "outline",
    "tag-pane",
    "bookmarks",
  ]);

  it("refuses every sidebar built-in", () => {
    for (const type of builtins) {
      expect(isDeferrableViewType(type, builtins), type).toBe(false);
    }
  });

  it("refuses the reserved core view types", () => {
    for (const type of ["empty", "markdown", "canvas", "graph", "base"]) {
      expect(isDeferrableViewType(type, builtins), type).toBe(false);
    }
  });

  it("allows a plugin-provided type", () => {
    expect(isDeferrableViewType("claude-threads-kanban", builtins)).toBe(true);
    expect(isDeferrableViewType("probe-pane", builtins)).toBe(true);
  });

  it("consults the workspace's live built-in registry, not a hardcoded list", () => {
    const workspace = fakeWorkspace([]);
    expect(workspace.isDeferrableViewType("late-builtin")).toBe(true);
    workspace.registerBuiltinViewType("late-builtin");
    expect(workspace.isDeferrableViewType("late-builtin")).toBe(false);
  });
});

describe("pickExistingBuiltinLeaf", () => {
  it("returns the leaf that existed before the restore pass", () => {
    const preExistingLeaf = fakeLeaf(null);
    const samePassLeaf = fakeLeaf(new DeferredView({ type: "search" }));
    const preExisting = new Set<WorkspaceLeaf>([preExistingLeaf]);

    // Ordered so a naive `candidates[0]` would pick the wrong one.
    expect(pickExistingBuiltinLeaf([samePassLeaf, preExistingLeaf], preExisting)).toBe(
      preExistingLeaf
    );
  });

  it("returns undefined when only a leaf created in this same pass matches", () => {
    const samePassLeaf = fakeLeaf(new DeferredView({ type: "probe-pane" }));
    expect(pickExistingBuiltinLeaf([samePassLeaf], new Set())).toBeUndefined();
  });
});

/**
 * Install a factory without going through `registerViewFactory`, which
 * deliberately kicks off a fire-and-forget hydration pass of its own — that
 * side effect is covered by its own test below, and would otherwise race the
 * explicit `hydrateDeferredLeaves()` calls these cases are asserting on.
 */
function setFactory(workspace: Workspace, type: string): void {
  (workspace as unknown as { viewFactories: Map<string, unknown> }).viewFactories.set(
    type,
    () => ({}) as View
  );
}

function clearFactory(workspace: Workspace, type: string): void {
  (workspace as unknown as { viewFactories: Map<string, unknown> }).viewFactories.delete(type);
}

/** A leaf whose `setViewState` swaps in a stand-in view, recording its argument. */
function mountingLeaf(view: View, onMount?: () => void): WorkspaceLeaf & { seen: unknown[] } {
  const leaf = fakeLeaf(view) as WorkspaceLeaf & { seen: unknown[] };
  leaf.seen = [];
  Object.assign(leaf, {
    async setViewState(next: { type: string; state?: unknown }) {
      leaf.seen.push(next);
      onMount?.();
      (leaf as { view: View }).view = { viewType: next.type } as View;
    },
  });
  return leaf;
}

describe("WorkspaceLeaf.isDeferred / loadIfDeferred", () => {
  function leafIn(workspace: Workspace, view: View): WorkspaceLeaf & { seen: unknown[] } {
    const leaf = mountingLeaf(view);
    Object.assign(leaf, { app: { workspace } });
    return leaf;
  }

  it("reports whether the leaf is holding a placeholder", () => {
    const workspace = fakeWorkspace([]);
    const deferred = leafIn(workspace, new DeferredView({ type: "probe-pane" }));
    const live = leafIn(workspace, { viewType: "probe-pane" } as View);

    expect(deferred.isDeferred).toBe(true);
    expect(live.isDeferred).toBe(false);
  });

  it("resolves silently when no factory is registered, rather than throwing like setViewState", async () => {
    const workspace = fakeWorkspace([]);
    const deferred = new DeferredView({ type: "probe-pane", state: { cursor: 2 } });
    const leaf = leafIn(workspace, deferred);

    await expect(leaf.loadIfDeferred()).resolves.toBeUndefined();

    expect(leaf.seen).toEqual([]);
    expect(leaf.view).toBe(deferred);
    expect(leaf.isDeferred).toBe(true);
  });

  it("resolves silently on a leaf that is not deferred at all", async () => {
    const workspace = fakeWorkspace([]);
    const leaf = leafIn(workspace, { viewType: "probe-pane" } as View);
    setFactory(workspace, "probe-pane");

    await expect(leaf.loadIfDeferred()).resolves.toBeUndefined();
    expect(leaf.seen).toEqual([]);
  });

  it("loads the real view when the factory is available", async () => {
    const workspace = fakeWorkspace([]);
    const leaf = leafIn(workspace, new DeferredView({ type: "probe-pane", state: { cursor: 2 } }));
    setFactory(workspace, "probe-pane");

    await leaf.loadIfDeferred();

    expect(leaf.seen).toEqual([{ type: "probe-pane", state: { cursor: 2 } }]);
    expect(leaf.isDeferred).toBe(false);
  });
});

describe("unregisterViewFactory", () => {
  /** A leaf whose view can be swapped and which records detach attempts. */
  function detachableLeaf(view: View | null): WorkspaceLeaf & { detached: boolean } {
    const leaf = fakeLeaf(view) as WorkspaceLeaf & { detached: boolean };
    leaf.detached = false;
    Object.assign(leaf, {
      async detach() {
        leaf.detached = true;
      },
    });
    return leaf;
  }

  const liveView = (state: unknown): View => ({
    viewType: "probe-pane",
    containerEl: null as unknown as HTMLElement,
    getDisplayText: () => "Probe Pane",
    getIcon: () => "star",
    getState: () => state,
    onOpen() {},
    onClose() {},
  });

  it("converts open panes to placeholders instead of detaching them", () => {
    const state = { cursor: 3 };
    const leaf = detachableLeaf(liveView(state));
    const workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    workspace.unregisterViewFactory("probe-pane");

    expect(leaf.detached).toBe(false);
    expect(isDeferredView(leaf.view)).toBe(true);
    const deferred = leaf.view as DeferredView;
    expect(deferred.viewType).toBe("probe-pane");
    expect(deferred.getState()).toBe(state);
    // Title and icon are captured before teardown so the placeholder is
    // labelled and — for a docked pane — actually visible in the icon strip.
    expect(deferred.getDisplayText()).toBe("Probe Pane");
    expect(deferred.getIcon()).toBe("star");
  });

  it("falls back to the leaf's persisted state when the view's getState throws mid-teardown", () => {
    const hostile = {
      ...liveView(null),
      getState() {
        throw new Error("plugin already unloaded");
      },
    } as View;
    const leaf = detachableLeaf(hostile);
    (leaf as unknown as { viewState: { type: string; state?: unknown } }).viewState = {
      type: "probe-pane",
      state: { cursor: 11 },
    };
    const workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    workspace.unregisterViewFactory("probe-pane");

    expect((leaf.view as DeferredView).getState()).toEqual({ cursor: 11 });
  });

  it("leaves an already-deferred pane alone", () => {
    const deferred = new DeferredView({ type: "probe-pane", state: { cursor: 1 } });
    const leaf = detachableLeaf(deferred);
    const workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    workspace.unregisterViewFactory("probe-pane");

    expect(leaf.view).toBe(deferred);
    expect(leaf.detached).toBe(false);
  });

  it("still hard-detaches a non-deferrable type", () => {
    const leaf = detachableLeaf({ ...liveView(null), viewType: "search" } as View);
    const workspace = fakeWorkspace([leaf]);
    workspace.registerBuiltinViewType("search");
    setFactory(workspace, "search");

    workspace.unregisterViewFactory("search");

    expect(leaf.detached).toBe(true);
  });
});

describe("hydrateDeferredLeaves", () => {
  it("replaces a placeholder with the real view, handing back the persisted state", async () => {
    const state = { boardId: 7 };
    const leaf = mountingLeaf(new DeferredView({ type: "probe-pane", state }));
    const workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    await workspace.hydrateDeferredLeaves();

    expect(leaf.seen).toEqual([{ type: "probe-pane", state }]);
    expect(isDeferredView(leaf.view)).toBe(false);
  });

  it("leaves the pane deferred with its state intact when setViewState rejects, and does not reject", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = { boardId: 7 };
    const deferred = new DeferredView({ type: "probe-pane", state });
    const leaf = fakeLeaf(deferred);
    Object.assign(leaf, {
      async setViewState() {
        // Emulate `setView` having already swapped in a half-mounted view
        // before the plugin's own setState threw.
        (leaf as { view: View }).view = { viewType: "probe-pane" } as View;
        throw new Error("stale persisted state");
      },
    });
    const workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    await expect(workspace.hydrateDeferredLeaves()).resolves.toBeUndefined();

    expect(leaf.view).toBe(deferred);
    expect(isDeferredView(leaf.view)).toBe(true);
    expect((leaf.view as DeferredView).getState()).toBe(state);
  });

  it("abandons a hydration whose factory was unregistered mid-flight", async () => {
    const deferred = new DeferredView({ type: "probe-pane", state: { boardId: 7 } });
    let workspace!: Workspace;
    // The disable half of PluginManager.reload() lands during the await.
    const leaf = mountingLeaf(deferred, () => clearFactory(workspace, "probe-pane"));
    workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    await workspace.hydrateDeferredLeaves();

    // The mounted view is backed by an unloaded plugin: revert to the
    // placeholder rather than leaving a live-looking orphan.
    expect(leaf.seen).toHaveLength(1);
    expect(leaf.view).toBe(deferred);
  });

  it("abandons a hydration whose factory was swapped for a different one mid-flight", async () => {
    const deferred = new DeferredView({ type: "probe-pane", state: { boardId: 7 } });
    let workspace!: Workspace;
    const leaf = mountingLeaf(deferred, () => {
      clearFactory(workspace, "probe-pane");
      setFactory(workspace, "probe-pane"); // re-enabled: a *different* factory
    });
    workspace = fakeWorkspace([leaf]);
    setFactory(workspace, "probe-pane");

    await workspace.hydrateDeferredLeaves();

    expect(leaf.view).toBe(deferred);
  });

  it("does nothing for a type with no registered factory", async () => {
    const deferred = new DeferredView({ type: "probe-pane", state: { boardId: 7 } });
    const leaf = fakeLeaf(deferred);
    const workspace = fakeWorkspace([leaf]);
    Object.assign(leaf, {
      async setViewState() {
        throw new Error("must not be called");
      },
    });

    await expect(workspace.hydrateDeferredLeaves()).resolves.toBeUndefined();
    expect(leaf.view).toBe(deferred);
  });

  it("only hydrates the requested type when one is given", async () => {
    const kept = mountingLeaf(new DeferredView({ type: "other-pane" }));
    const target = mountingLeaf(new DeferredView({ type: "probe-pane" }));
    const workspace = fakeWorkspace([kept, target]);
    setFactory(workspace, "probe-pane");
    setFactory(workspace, "other-pane");

    await workspace.hydrateDeferredLeaves("probe-pane");

    expect(isDeferredView(target.view)).toBe(false);
    expect(isDeferredView(kept.view)).toBe(true);
  });

  it("reclaims placeholders as soon as a late plugin registers its factory", async () => {
    const leaf = mountingLeaf(new DeferredView({ type: "probe-pane", state: { boardId: 7 } }));
    const workspace = fakeWorkspace([leaf]);

    // registerViewFactory hydrates fire-and-forget, so the swap lands on a
    // microtask rather than synchronously.
    workspace.registerViewFactory("probe-pane", () => ({}) as View);
    await Promise.resolve();
    await Promise.resolve();

    expect(leaf.seen).toEqual([{ type: "probe-pane", state: { boardId: 7 } }]);
    expect(isDeferredView(leaf.view)).toBe(false);
  });
});
