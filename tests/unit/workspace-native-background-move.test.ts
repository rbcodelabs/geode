import { expect, it, vi } from "vitest";
import { Workspace, TabGroup } from "../../src/renderer/workspace";
import { BaseView } from "../../src/renderer/views/base-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";

// Real Workspace move + real native Base readiness; container collaborators only.
function fixture(reason: "draft" | "conflict" | "pending" | "clean") {
  const base = Object.create(BaseView.prototype) as any;
  Object.assign(base, { sourceConflictReadOnly: reason === "conflict", sourceEdit: reason === "draft" ? { rawText: "9" } : null,
    persistRequestedWhileSuspended: reason === "pending", tableView: { editIdentity: null } });
  base.renderOwner = new RenderOwnership().create(base, { preflightClose: () => base.assertWorkspaceLoadReady() });
  const from = Object.create(TabGroup.prototype) as any, target = Object.create(TabGroup.prototype) as any;
  const parent = {}, leaf = { group: from, view: base, leafEl: { parentElement: parent }, companionOwner: undefined } as any;
  Object.assign(from, { leaves: [leaf], active: leaf, renderTabs: vi.fn(), extractLeaf: vi.fn(() => { from.leaves = []; leaf.leafEl.parentElement = null; }) });
  Object.assign(target, { leaves: [], active: null, insertLeaf: vi.fn(() => { leaf.group = target; target.leaves.push(leaf); }), setActiveLeaf: vi.fn(() => { target.active = leaf; }) });
  const workspace = Object.create(Workspace.prototype) as any;
  Object.assign(workspace, { trigger: vi.fn(), app: { notify: vi.fn() }, groupEmptied: vi.fn() });
  Object.defineProperty(workspace, "groups", { value: [from, target] });
  return { workspace, from, target, leaf, base, parent };
}
it.each(["draft", "conflict", "pending"] as const)("refuses cross-container native %s move before extraction or target activation", reason => {
  const f = fixture(reason);
  f.workspace.moveLeaf(f.leaf, f.target);
  expect(f.from.extractLeaf).not.toHaveBeenCalled();
  expect(f.target.insertLeaf).not.toHaveBeenCalled(); expect(f.target.setActiveLeaf).not.toHaveBeenCalled();
  expect(f.leaf.group).toBe(f.from); expect(f.leaf.leafEl.parentElement).toBe(f.parent);
  expect(f.from.active).toBe(f.leaf); expect(f.target.active).toBeNull();
});
it("retains ordinary clean cross-container move", () => {
  const f = fixture("clean"); f.workspace.moveLeaf(f.leaf, f.target);
  expect(f.from.extractLeaf).toHaveBeenCalledWith(f.leaf);
  expect(f.target.insertLeaf).toHaveBeenCalledWith(f.leaf, undefined);
  expect(f.target.setActiveLeaf).toHaveBeenCalledWith(f.leaf);
});
it("same-group dirty reorder does not invoke retirement or extract the input ancestor", () => {
  const f = fixture("draft"); const ready = vi.spyOn(f.base.renderOwner, "assertRetirementReady");
  f.workspace.moveLeaf(f.leaf, f.from, 0);
  expect(ready).not.toHaveBeenCalled(); expect(f.from.extractLeaf).not.toHaveBeenCalled();
  expect(f.leaf.leafEl.parentElement).toBe(f.parent); expect(f.from.leaves).toEqual([f.leaf]);
});
