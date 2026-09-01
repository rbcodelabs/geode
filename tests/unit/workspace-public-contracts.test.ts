import { afterEach, describe, expect, it, vi } from "vitest";
import { View } from "../../src/renderer/api/obsidian";
import { TabGroup, Workspace, WorkspaceLeaf } from "../../src/renderer/workspace";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";

afterEach(() => vi.unstubAllGlobals());

function fakeWorkspace(leaves: WorkspaceLeaf[], active: WorkspaceLeaf | null): Workspace {
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    activeGroup: { active, leaves },
    groups: [{ leaves }],
    leftSidebar: { groups: [] },
    rightSidebar: { groups: [] },
  });
  return workspace;
}

describe("Workspace public query contracts", () => {
  it("returns an active view only when it is an instance of the requested type", () => {
    class FirstView {}
    class SecondView {}
    const first = new FirstView();
    const leaf = { view: first } as WorkspaceLeaf;
    const workspace = fakeWorkspace([leaf], leaf);

    expect(workspace.activeLeaf).toBe(leaf);
    expect(workspace.getActiveViewOfType(FirstView as any)).toBe(first);
    expect(workspace.getActiveViewOfType(SecondView as any)).toBeNull();
  });

  it("iterates, filters, and detaches leaves by exact view type", () => {
    const detached: string[] = [];
    const leaves = [
      { view: { viewType: "alpha" }, detach: () => void detached.push("alpha") },
      { view: { viewType: "beta" }, detach: () => void detached.push("beta") },
      { view: { viewType: "alpha" }, detach: () => void detached.push("alpha-2") },
    ] as unknown as WorkspaceLeaf[];
    const workspace = fakeWorkspace(leaves, leaves[0]);
    const visited: WorkspaceLeaf[] = [];

    workspace.iterateAllLeaves((leaf) => visited.push(leaf));
    expect(visited).toEqual(leaves);
    expect(workspace.getLeavesOfType("alpha")).toEqual([leaves[0], leaves[2]]);
    workspace.detachLeavesOfType("alpha");
    expect(detached).toEqual(["alpha", "alpha-2"]);
  });
});

describe("Workspace active leaf events", () => {
  function eventWorkspace(firstGroup: object, groups: object[]): Workspace {
    const workspace = Object.create(Workspace.prototype) as Workspace;
    Object.assign(workspace, {
      activeGroup: firstGroup,
      groups,
      syncAdaptivePresentation: vi.fn(),
      trigger: vi.fn(),
    });
    return workspace;
  }

  function eventGroup(workspace: Workspace, active: WorkspaceLeaf, leaves: WorkspaceLeaf[]): TabGroup {
    const group = Object.create(TabGroup.prototype) as TabGroup;
    Object.assign(group, {
      workspace,
      active,
      leaves,
      sidebar: null,
      contentHostEl: { innerHTML: "", appendChild: vi.fn() },
      renderTabs: vi.fn(),
    });
    for (const leaf of leaves) Object.assign(leaf, { group, leafEl: {}, ensureOpen: vi.fn() });
    return group;
  }

  it("emits once for a direct group switch and not for the already-active group", () => {
    const firstLeaf = { view: null } as unknown as WorkspaceLeaf;
    const secondLeaf = { view: null } as unknown as WorkspaceLeaf;
    const firstGroup = { active: firstLeaf } as TabGroup;
    const secondGroup = { active: secondLeaf } as TabGroup;
    const workspace = eventWorkspace(firstGroup, [firstGroup, secondGroup]);

    workspace.setActiveGroup(secondGroup);
    expect(workspace.trigger).toHaveBeenCalledTimes(1);
    expect(workspace.trigger).toHaveBeenCalledWith("active-leaf-change", secondLeaf);

    workspace.setActiveGroup(secondGroup);
    expect(workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("emits once for a current-group leaf switch and an inactive-group leaf activation", () => {
    const firstFile = { path: "first.md" };
    const firstLeaf = { view: { getFile: () => firstFile } } as unknown as WorkspaceLeaf;
    const nextLeaf = { view: null } as unknown as WorkspaceLeaf;
    const otherLeaf = { view: null } as unknown as WorkspaceLeaf;
    const placeholderGroup = {} as TabGroup;
    const workspace = eventWorkspace(placeholderGroup, []);
    const currentGroup = eventGroup(workspace, firstLeaf, [firstLeaf, nextLeaf]);
    const inactiveGroup = eventGroup(workspace, otherLeaf, [otherLeaf]);
    workspace.groups = [currentGroup, inactiveGroup];
    workspace.activeGroup = currentGroup;

    currentGroup.setActiveLeaf(currentGroup.active);
    expect((workspace as any).syncAdaptivePresentation).toHaveBeenCalledTimes(1);
    expect(workspace.trigger).not.toHaveBeenCalledWith("active-leaf-change", expect.anything());
    expect(workspace.trigger).toHaveBeenCalledOnce();
    expect(workspace.trigger).toHaveBeenCalledWith("file-open", firstFile);

    currentGroup.setActiveLeaf(nextLeaf);
    expect(workspace.trigger).toHaveBeenCalledTimes(2);
    expect(workspace.trigger).toHaveBeenLastCalledWith("active-leaf-change", nextLeaf);

    currentGroup.setActiveLeaf(nextLeaf);
    expect(workspace.trigger).toHaveBeenCalledTimes(2);

    inactiveGroup.setActiveLeaf(otherLeaf);
    expect(workspace.trigger).toHaveBeenCalledTimes(3);
    expect(workspace.trigger).toHaveBeenLastCalledWith("active-leaf-change", otherLeaf);
  });
});

describe("WorkspaceLeaf public state contracts", () => {
  it("applies falsey view state and reports the view's current serialized state", async () => {
    const setState = vi.fn(async () => {});
    const view = {
      viewType: "probe",
      onOpen: async () => {},
      getState: () => ({ current: 2 }),
      setState,
    };
    const leaf = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
    Object.assign(leaf, {
      app: { workspace: { getViewFactory: () => () => view } },
      group: { setActiveLeaf: vi.fn() },
      view: null,
      setView: async (next: unknown) => void ((leaf as any).view = next),
    });

    await leaf.setViewState({ type: "probe", state: false });
    expect(setState).toHaveBeenCalledWith(false, {});
    expect(leaf.getViewState()).toEqual({ type: "probe", state: { current: 2 } });
  });

  it("opens and returns an existing view and toggles pinned state", async () => {
    const view = { viewType: "probe" };
    const leaf = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
    Object.assign(leaf, { pinned: false, setView: vi.fn(async () => {}), setPinned: WorkspaceLeaf.prototype.setPinned });
    (leaf as any).group = { renderTabs: vi.fn() };
    (leaf as any).app = { workspace: { trigger: vi.fn() } };

    await expect(leaf.open(view as any)).resolves.toBe(view);
    expect((leaf as any).setView).toHaveBeenCalledWith(view);
    leaf.togglePinned();
    expect(leaf.pinned).toBe(true);
  });
});

describe("View state foundation", () => {
  it("provides stable default state and ephemeral state hooks", async () => {
    vi.stubGlobal("document", { createElement: () => ({ className: "" }) });
    const leaf = { app: {} } as WorkspaceLeaf;
    class ProbeView extends View {
      override getViewType(): string { return "probe"; }
      override getDisplayText(): string { return "Probe"; }
    }
    const view = new ProbeView(leaf);

    expect(view.leaf).toBe(leaf);
    expect(view.app).toBe(leaf.app);
    expect(view.containerEl).toBeDefined();
    expect(view.icon).toBe("document");
    expect(view.navigation).toBe(false);
    expect(view.scope).toBeNull();
    expect(view.getIcon()).toBe("document");
    expect(view.getViewType()).toBe("probe");
    expect(view.getDisplayText()).toBe("Probe");
    expect(view.getState()).toEqual({});
    expect(view.getEphemeralState()).toEqual({});
    view.setEphemeralState({ cursor: 3 });
    expect(view.getEphemeralState()).toEqual({ cursor: 3 });
    await expect(view.setState({ saved: true }, {})).resolves.toBeUndefined();
  });
});

describe("Workspace/View through require('obsidian')", () => {
  it("exposes constructors and query/state methods to CommonJS plugins", () => {
    const PluginClass = instantiatePluginClass(
      `
        const { View, Workspace } = require("obsidian");
        module.exports = class WorkspaceProbe {
          static results = (() => {
            const workspace = Object.create(Workspace.prototype);
            class ProbeView extends View { getViewType() { return "probe"; } }
            const view = Object.create(ProbeView.prototype);
            const leaf = { view };
            workspace.activeGroup = { active: leaf, leaves: [leaf] };
            workspace.groups = [{ leaves: [leaf] }];
            workspace.leftSidebar = { groups: [] };
            workspace.rightSidebar = { groups: [] };
            return [workspace.getActiveViewOfType(ProbeView) === view, workspace.getLeavesOfType("probe").length];
          })();
        };
      `,
      "workspace-probe",
    ) as unknown as { results: unknown[] };

    expect(PluginClass.results).toEqual([true, 1]);
  });
});
