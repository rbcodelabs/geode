import { describe, expect, it } from "vitest";
import {
  insertCenterGroupSize,
  migrateWorkspaceLayout,
  normalizeCenterGroupSizes,
  normalizeWorkspaceNode,
  removeCenterGroupSize,
  type PersistedWorkspace,
  type WorkspaceTreeNode,
} from "../../src/renderer/workspace";

describe("workspace layout tree", () => {
  it("normalizes valid center sizes and safely rejects malformed persisted values", () => {
    expect(normalizeCenterGroupSizes([3, 1], 2)).toEqual([0.75, 0.25]);
    expect(normalizeCenterGroupSizes([0.3, Number.NaN], 2)).toEqual([0.5, 0.5]);
    expect(normalizeCenterGroupSizes([0.3, 0], 2)).toEqual([0.5, 0.5]);
    expect(normalizeCenterGroupSizes([0.3], 2)).toEqual([0.5, 0.5]);
  });

  it("splits only the donor allocation and preserves unrelated groups", () => {
    expect(insertCenterGroupSize([0.2, 0.5, 0.3], 1, 0.3)).toEqual([0.2, 0.15, 0.35, 0.3]);
    expect(insertCenterGroupSize([0.4, 0.6], 0, 0.5)).toEqual([0.2, 0.2, 0.6]);
  });

  it("redistributes a removed allocation proportionally across remaining groups", () => {
    expect(removeCenterGroupSize([0.2, 0.5, 0.3], 1)).toEqual([0.4, 0.6]);
    expect(removeCenterGroupSize([1], 0)).toEqual([]);
  });

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
    expect(migrated.version).toBe(2);
    expect(migrated.left).toMatchObject({ collapsed: true, width: 333 });
    expect(migrated.left.root).toMatchObject({ type: "tabs", active: 0, leaves: [{ type: "file-explorer" }] });
    expect(migrated.center.root).toMatchObject({
      type: "split",
      direction: "horizontal",
      sizes: [0.5, 0.5],
      children: [{ type: "tabs" }, { type: "tabs" }],
    });
    expect(migrated.center.activeGroup).toBe(1);
  });
});
