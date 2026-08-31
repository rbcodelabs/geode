import { describe, expect, it } from "vitest";
import {
  migrateWorkspaceLayout,
  normalizeWorkspaceNode,
  type PersistedWorkspace,
  type WorkspaceTreeNode,
} from "../../src/renderer/workspace";

describe("workspace layout tree", () => {
  it("collapses empty and single-child split branches while preserving a center group", () => {
    const tree: WorkspaceTreeNode = {
      type: "split",
      direction: "vertical",
      sizes: [0.2, 0.8],
      children: [
        { type: "tabs", leaves: [], active: 0 },
        {
          type: "split",
          direction: "vertical",
          sizes: [1],
          children: [{ type: "tabs", leaves: [{ type: "markdown", file: "A.md" }], active: 0 }],
        },
      ],
    };

    expect(normalizeWorkspaceNode(tree, true)).toEqual({
      type: "tabs",
      leaves: [{ type: "markdown", file: "A.md" }],
      active: 0,
    });
    expect(normalizeWorkspaceNode({ type: "tabs", leaves: [], active: 0 }, true)).toEqual({
      type: "tabs",
      leaves: [],
      active: 0,
    });
    expect(normalizeWorkspaceNode({ type: "tabs", leaves: [], active: 0 }, false)).toBeNull();
  });

  it("migrates v1 sidebars and center groups to a versioned recursive tree", () => {
    const v1: PersistedWorkspace = {
      version: 1,
      groups: [
        { leaves: [{ type: "markdown", file: "A.md" }], active: 0 },
        { leaves: [{ type: "webviewer", state: { url: "https://example.com" } }], active: 0 },
      ],
      activeGroup: 1,
      left: {
        leaves: [{ type: "file-explorer" }],
        activeType: "file-explorer",
        collapsed: true,
        width: 333,
      },
      right: { leaves: [{ type: "outline" }], activeType: "outline", collapsed: false, width: 280 },
    };

    const migrated = migrateWorkspaceLayout(v1);
    expect(migrated.version).toBe(3);
    expect(migrated.left).toMatchObject({ collapsed: true, width: 333 });
    expect(migrated.left.root).toMatchObject({ type: "tabs", active: 0, leaves: [{ type: "file-explorer" }] });
    expect(migrated.center.root).toMatchObject({
      type: "split",
      direction: "horizontal",
      children: [{ type: "tabs" }, { type: "tabs" }],
    });
    expect(migrated.center.activeGroup).toBe(1);
  });

  it("normalizes malformed v3 collection metadata without losing valid leaves", () => {
    const v3 = {
      version: 3,
      center: {
        activeGroup: 0,
        root: {
          type: "tabs",
          active: 1,
          collections: [
            { id: "work", name: "   ", color: "not-a-color", collapsed: true },
            { id: "work", name: "Duplicate", color: "blue", collapsed: false },
            { id: "empty", name: "Empty", color: "red", collapsed: false },
          ],
          leaves: [
            { type: "markdown", file: "A.md", collectionId: "work" },
            { type: "markdown", file: "B.md" },
            { type: "markdown", file: "C.md", collectionId: "work" },
            { type: "markdown", file: "D.md", collectionId: "missing" },
          ],
        },
      },
      left: { root: null },
      right: { root: null },
    } as unknown as PersistedWorkspace;

    const migrated = migrateWorkspaceLayout(v3) as any;
    expect(migrated.version).toBe(3);
    expect(migrated.center.root.collections).toEqual([
      { id: "work", name: "New collection", color: "gray", collapsed: true },
    ]);
    expect(migrated.center.root.leaves.map((leaf: any) => [leaf.file, leaf.collectionId])).toEqual([
      ["A.md", "work"],
      ["C.md", "work"],
      ["B.md", undefined],
      ["D.md", undefined],
    ]);
    expect(migrateWorkspaceLayout(migrated as PersistedWorkspace)).toEqual(migrated);
  });

  it("migrates v2 tabs as ungrouped v3 leaves while keeping sidebars collection-free", () => {
    const v2 = {
      version: 2,
      center: { root: { type: "tabs", active: 0, leaves: [{ type: "markdown", file: "A.md" }] }, activeGroup: 0 },
      left: { root: { type: "tabs", active: 0, leaves: [{ type: "file-explorer", collectionId: "bad" }] } },
      right: { root: null },
    } as unknown as PersistedWorkspace;
    const migrated = migrateWorkspaceLayout(v2) as any;
    expect(migrated).toMatchObject({ version: 3, center: { root: { collections: [] } } });
    expect(migrated.center.root.leaves[0].collectionId).toBeUndefined();
    expect(migrated.left.root.leaves[0].collectionId).toBeUndefined();
    expect(migrated.left.root.collections).toBeUndefined();
  });

  it("strips v3-shaped additive collection fields from every malformed v2 center tab", () => {
    const v2 = {
      version: 2,
      center: { activeGroup: 0, root: { type: "tabs", active: 0,
        collections: [{ id: "legacy", name: "Must disappear", color: "red", collapsed: true }],
        leaves: [{ type: "markdown", file: "A.md", collectionId: "legacy" }] } },
      left: { root: null }, right: { root: null },
    } as unknown as PersistedWorkspace;
    const migrated = migrateWorkspaceLayout(v2) as any;
    expect(migrated.center.root.collections).toEqual([]);
    expect(migrated.center.root.leaves[0].collectionId).toBeUndefined();
  });
});
