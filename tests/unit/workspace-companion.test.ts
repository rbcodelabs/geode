import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateWorkspaceLayout, normalizeWorkspaceNode, TabGroup, Workspace, WorkspaceLeaf, type PersistedWorkspaceV3, type PersistedTabNode } from "../../src/renderer/workspace";

const owner = "test-plugin:context";
beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ appendChild() {}, className: "" }) }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const workspace = Object.create(Workspace.prototype) as Workspace;
  function group() {
    const result = Object.create(TabGroup.prototype) as TabGroup;
    Object.assign(result, { workspace, app: {}, leaves: [], collections: [], isSidebar: false, renderTabs: vi.fn(),
      setActiveLeaf(leaf: WorkspaceLeaf) { result.active = leaf; workspace.trigger("active-leaf-change", leaf); } });
    return result;
  }
  const anchorGroup = group();
  Object.assign(workspace, { layoutReady: true, groups: [anchorGroup], trigger: vi.fn(),
    addGroup: vi.fn((_anchor, _ratio, companionOwner) => {
      const next = group(); next.companionOwner = companionOwner; workspace.groups.push(next);
      workspace.trigger("layout-change"); return next;
    }),
  });
  const anchor = anchorGroup.createLeaf();
  return { workspace, anchor };
}

describe("durable companion destination", () => {
  it("reuses one destination despite different anchors and pin state", () => {
    const { workspace, anchor } = setup();
    const first = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3);
    first.leaf.pinned = true;
    const secondAnchor = (anchor.group as TabGroup).createLeaf();
    expect(workspace.getOrCreateCompanionLeaf(owner, secondAnchor, 0.3)).toEqual({ leaf: first.leaf, reused: true });
    expect(first.reused).toBe(false);
    expect(workspace.addGroup).toHaveBeenCalledWith(anchor.group, 0.3, owner);
    expect(workspace.groups).toHaveLength(2);
  });

  it("replaces a closed destination inside its surviving split without evicting siblings", () => {
    const { workspace, anchor } = setup();
    const first = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3).leaf;
    const group = first.group as TabGroup;
    const sibling = group.createLeaf();
    group.leaves.splice(group.leaves.indexOf(first), 1);
    const next = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3);
    expect(next.reused).toBe(false);
    expect(next.leaf.group).toBe(group);
    expect(group.leaves).toEqual([sibling, next.leaf]);
    expect(workspace.groups).toHaveLength(2);
  });

  it("rejects unready workspaces and detached anchors before mutation", () => {
    const { workspace, anchor } = setup();
    Object.assign(workspace, { layoutReady: false });
    expect(() => workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3)).toThrow(/ready/i);
    Object.assign(workspace, { layoutReady: true });
    (anchor.group as TabGroup).leaves.length = 0;
    expect(() => workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3)).toThrow(/anchor/i);
    expect(workspace.addGroup).not.toHaveBeenCalled();
  });

  it("makes ownership visible before synchronous activation callbacks reenter", () => {
    const { workspace, anchor } = setup();
    let nested: WorkspaceLeaf | undefined;
    let reentering = false;
    workspace.trigger = vi.fn(() => {
      if (reentering) return;
      reentering = true;
      nested = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3).leaf;
      reentering = false;
    });
    const outer = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3);
    expect(nested).toBe(outer.leaf);
    expect(workspace.groups).toHaveLength(2);
    expect(workspace.groups[1].leaves).toEqual([outer.leaf]);
  });

  it("clears the designation when moving between containers", () => {
    const { workspace, anchor } = setup();
    const leaf = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3).leaf;
    const source = leaf.group as TabGroup;
    source.createLeaf();
    source.extractLeaf = vi.fn(() => source.leaves.splice(source.leaves.indexOf(leaf), 1));
    const target = anchor.group as TabGroup;
    target.insertLeaf = vi.fn(() => { target.leaves.push(leaf); leaf.group = target; });
    workspace.moveLeaf(leaf, target);
    expect(leaf.companionOwner).toBeUndefined();
    expect(source.companionOwner).toBe(owner);
  });

  it("clears the role when the last center group is emptied", () => {
    const { workspace, anchor } = setup();
    const group = anchor.group as TabGroup;
    group.companionOwner = owner;
    Object.assign(workspace, { app: { openEmptyTab: vi.fn() } });
    workspace.groupEmptied(group);
    expect(group.companionOwner).toBeUndefined();
  });

  it("retains an owned split when its only destination is dragged elsewhere", () => {
    const { workspace, anchor } = setup();
    const leaf = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3).leaf;
    const source = leaf.group as TabGroup;
    source.extractLeaf = vi.fn(() => { source.leaves.length = 0; source.active = null; });
    const target = anchor.group as TabGroup;
    target.insertLeaf = vi.fn(() => { target.leaves.push(leaf); leaf.group = target; });
    workspace.groupEmptied = vi.fn();
    workspace.moveLeaf(leaf, target);
    expect(workspace.groupEmptied).not.toHaveBeenCalled();
    expect(workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3).leaf.group).toBe(source);
  });

  it("rejects navigation during a subsequent layout restoration", () => {
    const { workspace, anchor } = setup();
    Object.assign(workspace, { restoringLayout: true });
    expect(() => workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3)).toThrow(/ready/i);
    expect(workspace.addGroup).not.toHaveBeenCalled();
  });
});

describe("companion layout metadata", () => {
  const tabs = (key: unknown = owner): PersistedTabNode => ({ type: "tabs", active: 0, companionOwner: key as string,
    leaves: [{ type: "probe", companionOwner: owner }, { type: "probe", companionOwner: owner }] });
  const layout = (children: PersistedTabNode[]): PersistedWorkspaceV3 => ({ version: 3,
    center: { root: { type: "split", direction: "horizontal", sizes: [0.5, 0.5], children } },
    left: { root: tabs() }, right: { root: null } });

  it("keeps the first group and destination and removes only duplicate or sidebar metadata", () => {
    const input = layout([tabs(), tabs()]);
    const result = migrateWorkspaceLayout(input);
    const groups = (result.center.root as any).children as PersistedTabNode[];
    expect(groups[0].companionOwner).toBe(owner);
    expect(groups[0].leaves.map(l => l.companionOwner)).toEqual([owner, undefined]);
    expect(groups[1].companionOwner).toBeUndefined();
    expect(groups[1].leaves.map(l => l.companionOwner)).toEqual([undefined, undefined]);
    expect((result.left.root as PersistedTabNode).companionOwner).toBeUndefined();
    expect(groups.flatMap(g => g.leaves)).toHaveLength(4);
    expect(input.center).not.toEqual(result.center);
  });

  it("strips malformed roles and orphaned destination designations", () => {
    const result = migrateWorkspaceLayout(layout([tabs(42)]));
    const group = (result.center.root as any).children[0] as PersistedTabNode;
    expect(group.companionOwner).toBeUndefined();
    expect(group.leaves.every(l => l.companionOwner === undefined)).toBe(true);
  });

  it("retains a surviving empty owned group through normalization", () => {
    const group = { ...tabs(), leaves: [] };
    expect(normalizeWorkspaceNode(group)).toEqual(group);
  });

  it("serializes empty owned destinations without persisting unrelated placeholders", () => {
    const { workspace, anchor } = setup();
    const owned = workspace.getOrCreateCompanionLeaf(owner, anchor, 0.3).leaf;
    const serializeLeaf = (workspace as any).serializeLeaf.bind(workspace);
    expect(serializeLeaf(owned)).toEqual({ type: "empty", companionOwner: owner, pinned: false });
    expect(serializeLeaf(anchor)).toBeNull();
  });

  it("restores group and leaf ownership before mounting deferred content", async () => {
    const { workspace, anchor } = setup();
    (anchor.group as TabGroup).leaves.length = 0;
    const mounted: Array<[string | undefined, string | undefined]> = [];
    Object.assign(workspace, { iterateLeaves() {}, restoreSidebar: async () => {}, layoutCenterGroups() {},
      app: { vault: { getFileByPath: () => null } }, getViewFactory: () => undefined, getLeavesOfType: () => [],
      restoreLeafView: async (leaf: WorkspaceLeaf) => { mounted.push([(leaf.group as TabGroup).companionOwner, leaf.companionOwner]); },
    });
    await workspace.deserialize(layout([tabs()]));
    expect(mounted).toEqual([[owner, owner], [owner, undefined]]);
    expect(workspace.getOrCreateCompanionLeaf(owner, workspace.groups[0].leaves[1], 0.3).reused).toBe(true);
  });
});
