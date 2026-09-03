import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TabGroup,
  Workspace,
  type PersistedLeaf,
  type PersistedWorkspace,
  type WorkspaceLeaf,
} from "../../src/renderer/workspace";

/**
 * `renderTabs()` discards and rebuilds the whole tab-header row, so its real
 * cost is measurable from the DOM it touches:
 *
 * - `rebuilds` — one per *effective* `renderTabs()`; it starts by clearing the
 *   row (`tabHeaderInnerEl.innerHTML = ""`), so a cleared row is one rebuild.
 * - `appends` — every node appended to the row across all rebuilds (one per tab
 *   header, plus the trailing spacer). This is the number that goes quadratic:
 *   adding N leaves one at a time rebuilds 1, then 2, … then N headers.
 */
interface RenderCounters {
  rebuilds: number;
  appends: number;
}

const counters = (): RenderCounters => ({ rebuilds: 0, appends: 0 });

/**
 * vitest.config.mts runs the `node` environment (no jsdom), so the renderer's
 * DOM calls need a stub. This covers exactly the surface `renderTabs()`,
 * `buildTabHeader()`, `setIcon()` and the `WorkspaceLeaf` constructor touch.
 */
class FakeElement {
  private classes = new Set<string>();
  classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  textContent = "";
  title = "";
  id = "";
  type = "";
  hidden = false;
  draggable = false;
  tabIndex = 0;
  onmousedown: unknown = null;
  oncontextmenu: unknown = null;
  ondragstart: unknown = null;
  ondragend: unknown = null;
  onkeydown: unknown = null;
  private attrs: Record<string, string> = {};
  private html = "";

  constructor(private readonly counts?: RenderCounters) {}

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/).filter(Boolean)) this.classes.add(name);
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children.length = 0;
    if (this.counts && value === "") this.counts.rebuilds++;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}

  append(...kids: FakeElement[]): void {
    this.children.push(...kids);
  }

  appendChild(kid: FakeElement): FakeElement {
    this.children.push(kid);
    if (this.counts) this.counts.appends++;
    return kid;
  }

  contains(): boolean {
    return false;
  }

  /** Class selectors only, depth-first — everything else (e.g. `svg`) is absent. */
  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith(".")) return null;
    const name = selector.slice(1);
    for (const child of this.children) {
      if (child.classes.has(name)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 };
  }
}

beforeEach(() => {
  // `renderTabs()` narrows with `document.activeElement instanceof HTMLElement`
  // and `installTabKeyboardNavigation()` filters the row's children the same
  // way, so the fake element type has to *be* the global `HTMLElement`.
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", { activeElement: null, createElement: () => new FakeElement() });
});

afterEach(() => vi.unstubAllGlobals());

/** A `TabGroup` built off the prototype with only the members these paths read. */
function fakeGroup(counts: RenderCounters): TabGroup {
  const group = Object.create(TabGroup.prototype) as TabGroup;
  Object.assign(group, {
    isSidebar: false,
    sidebar: undefined,
    leaves: [] as WorkspaceLeaf[],
    active: null,
    collections: [],
    tabHeaderInnerEl: new FakeElement(counts),
    contentHostEl: new FakeElement(),
    tabBarEl: new FakeElement(),
    app: { showTabContextMenu() {} },
    workspace: { activeGroup: group, setActiveGroup() {}, trigger() {}, moveLeaf() {} },
  });
  return group;
}

describe("TabGroup render batching", () => {
  it("rebuilds the tab row once per added leaf when unbatched — quadratic in total header work", () => {
    const counts = counters();
    const group = fakeGroup(counts);

    for (let i = 0; i < 8; i++) group.createLeaf();

    // One rebuild per `createLeaf()` (via `setActiveLeaf()`), and the i-th of
    // those rebuilds i headers plus the spacer: 1+2+…+8 headers = 36, +8 spacers.
    expect(counts.rebuilds).toBe(8);
    expect(counts.appends).toBe(44);
    expect(group.leaves).toHaveLength(8);
  });

  it("collapses a batch of leaf construction to exactly one rebuild", () => {
    const counts = counters();
    const group = fakeGroup(counts);

    group.beginBatch();
    try {
      for (let i = 0; i < 8; i++) group.createLeaf();
      // Suppressed for the whole batch, not merely coalesced.
      expect(counts.rebuilds).toBe(0);
      expect(counts.appends).toBe(0);
    } finally {
      group.endBatch();
    }

    // One rebuild, one header per leaf, one spacer — linear, not triangular.
    expect(counts.rebuilds).toBe(1);
    expect(counts.appends).toBe(9);
    expect(group.leaves).toHaveLength(8);
    expect(group.tabHeaderInnerEl.children).toHaveLength(9);
  });

  it("scales linearly with leaf count while the unbatched path scales quadratically", () => {
    const totalAppends = (leafCount: number, batched: boolean): number => {
      const counts = counters();
      const group = fakeGroup(counts);
      if (batched) group.beginBatch();
      try {
        for (let i = 0; i < leafCount; i++) group.createLeaf();
      } finally {
        if (batched) group.endBatch();
      }
      return counts.appends;
    };

    // Doubling the tab count doubles the batched work but roughly quadruples
    // the unbatched work — the O(N) vs O(N^2) claim, measured.
    expect(totalAppends(20, true)).toBe(21);
    expect(totalAppends(40, true)).toBe(41);
    expect(totalAppends(20, false)).toBe(230);
    expect(totalAppends(40, false)).toBe(860);
  });

  it("restores rendering after endBatch(), including when the batch threw", () => {
    const counts = counters();
    const group = fakeGroup(counts);

    expect(() => {
      group.beginBatch();
      try {
        group.createLeaf();
        throw new Error("view failed to restore");
      } finally {
        group.endBatch();
      }
    }).toThrow("view failed to restore");

    // The partial batch rendered once, and the flag did not leak: later
    // renders still reach the DOM instead of being silently dropped forever.
    expect(counts.rebuilds).toBe(1);
    const before = counts.rebuilds;
    group.renderTabs();
    expect(counts.rebuilds).toBe(before + 1);
  });
});

/** A `Workspace` built off the prototype, restoring into `group` only. */
function fakeWorkspace(group: TabGroup, restoreLeafView: () => Promise<void>): Workspace {
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    groups: [group],
    centerGroupSizes: [1],
    leftSidebar: { groups: [] },
    rightSidebar: { groups: [] },
    app: {
      vault: { getFileByPath: (path: string) => ({ path }) },
      createEmptyView: () => null,
    },
    // Tracked for real: `TabGroup.setActiveLeaf()` short-circuits when the leaf
    // is already active *in the active group*, so a stub that never records the
    // active group would fake up extra rebuilds that never happen at runtime.
    activeGroup: group,
    iterateLeaves() {},
    addGroup() {},
    layoutCenterGroups() {},
    restoreSidebar: async () => {},
    restoreLeafView,
    getViewFactory: () => undefined,
    getLeavesOfType: () => [],
    moveLeaf() {},
    setActiveGroup(next: TabGroup) {
      Object.assign(workspace, { activeGroup: next });
    },
    trigger() {},
  });
  Object.assign(group, { workspace });
  return workspace;
}

const persisted = (leafCount: number): PersistedWorkspace => ({
  version: 3,
  center: {
    root: {
      type: "tabs",
      leaves: Array.from({ length: leafCount }, (_, i): PersistedLeaf => ({ type: "markdown", file: `Note ${i}.md` })),
      active: 0,
    },
    activeGroup: 0,
  },
  left: { root: null },
  right: { root: null },
} as unknown as PersistedWorkspace);

describe("Workspace.deserialize tab render batching", () => {
  it("restores a whole tab group with a single tab-header rebuild", async () => {
    const counts = counters();
    const group = fakeGroup(counts);
    const workspace = fakeWorkspace(group, async () => {});

    await expect(workspace.deserialize(persisted(12))).resolves.toBe(true);

    expect(group.leaves).toHaveLength(12);
    // Restoring 12 tabs used to cost 12+ rebuilds and 1+2+…+12 = 78 headers.
    expect(counts.rebuilds).toBe(1);
    expect(counts.appends).toBe(13);
  });

  it("does not leak the suppression flag when a view fails to restore", async () => {
    const counts = counters();
    const group = fakeGroup(counts);
    const workspace = fakeWorkspace(group, async () => {
      throw new Error("plugin view blew up");
    });

    await expect(workspace.deserialize(persisted(5))).rejects.toThrow("plugin view blew up");

    // `finally` still ran the single rebuild, and rendering is live again — a
    // leaked flag here would freeze every tab header for the rest of the session.
    expect(counts.rebuilds).toBe(1);
    group.renderTabs();
    expect(counts.rebuilds).toBe(2);
  });

  it("is what keeps the restore linear: without the bracket the same path goes quadratic", async () => {
    const counts = counters();
    const group = fakeGroup(counts);
    // Neutralize only the bracket, leaving `deserialize()` otherwise untouched,
    // to measure the cost the batching removes.
    Object.assign(group, { beginBatch() {}, endBatch() {} });
    const workspace = fakeWorkspace(group, async () => {});

    await workspace.deserialize(persisted(12));

    expect(counts.rebuilds).toBeGreaterThan(1);
    expect(counts.appends).toBeGreaterThan(70);
  });
});
