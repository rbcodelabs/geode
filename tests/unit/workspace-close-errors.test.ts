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

it("implicit Canvas replacement calls strict cleanup and preserves a refused view", async () => {
  const leaf = Object.create(WorkspaceLeaf.prototype);
  const ordinary = vi.fn(), strict = vi.fn(async () => { throw Error("finish preview"); });
  const current = { viewType: "canvas", onClose: ordinary, closeImplicitly: strict };
  Object.assign(leaf, { opened: true, view: current });
  await expect(leaf.setView({ viewType: "empty" } as never)).rejects.toThrow("finish preview");
  expect(leaf.view).toBe(current); expect(leaf.opened).toBe(true); expect(strict).toHaveBeenCalledOnce(); expect(ordinary).not.toHaveBeenCalled();
});
it("explicit Canvas detach retains ordinary close and propagates refusal", async () => {
  const leaf = Object.create(WorkspaceLeaf.prototype);
  const ordinary = vi.fn(async () => { throw Error("finish draft"); }), strict = vi.fn();
  Object.assign(leaf, { opened: true, view: { viewType: "canvas", onClose: ordinary, closeImplicitly: strict } });
  await expect(leaf.detach()).rejects.toThrow("finish draft");
  expect(ordinary).toHaveBeenCalledOnce(); expect(strict).not.toHaveBeenCalled(); expect(leaf.opened).toBe(true);
});
