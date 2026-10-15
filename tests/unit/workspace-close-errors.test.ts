import { expect, it, vi } from "vitest";
import { closeLeafFromUI, WorkspaceLeaf } from "../../src/renderer/workspace";

it("reports a refused close without detaching the live pane or leaking its rejection", async () => {
  const removeLeaf = vi.fn(); const notify = vi.fn();
  const leaf = Object.create(WorkspaceLeaf.prototype);
  Object.assign(leaf, { opened: true, view: { onClose: async () => { throw new Error("save failed"); } }, group: { removeLeaf }, app: { notify } });
  closeLeafFromUI(leaf);
  await new Promise(resolve => setImmediate(resolve));
  expect(removeLeaf).not.toHaveBeenCalled(); expect(leaf.opened).toBe(true);
  expect(notify).toHaveBeenCalledWith("Could not close tab: save failed");
});
