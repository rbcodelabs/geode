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
    expect(migrated.version).toBe(2);
    expect(migrated.left).toMatchObject({ collapsed: true, width: 333 });
    expect(migrated.left.root).toMatchObject({ type: "tabs", active: 0, leaves: [{ type: "file-explorer" }] });
    expect(migrated.center.root).toMatchObject({
      type: "split",
      direction: "horizontal",
      children: [{ type: "tabs" }, { type: "tabs" }],
    });
    expect(migrated.center.activeGroup).toBe(1);
  });
});
