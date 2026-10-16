import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { nativeRenderOwnership } from "../../src/renderer/workspaces/render-ownership";

const allocated = vi.hoisted(() => ({ closed: 0, failRead: true }));
vi.mock("../../src/renderer/views/markdown-view", async () => {
  const { nativeRenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  return { MarkdownView: class {
    readonly renderOwner;
    constructor(app: object) { this.renderOwner = nativeRenderOwnership(app).create(this, { writer: this, close: async () => { allocated.closed++; } }); }
    setFile() { return this.renderOwner.run(async () => { if (allocated.failRead) throw new Error("note read failed"); }); }
    onClose() { return this.renderOwner.close(); }
  } };
});

it("closes an unpublished native view after its initial read rejects", async () => {
  allocated.closed = 0; allocated.failRead = true;
  const app = Object.create(App.prototype) as any;
  const leaf = { view: null, setView: vi.fn() };
  await expect(app.mountDocumentInLeaf(leaf, { extension: "md", path: "Missing.md" }, false)).rejects.toThrow("note read failed");
  expect(leaf.setView).not.toHaveBeenCalled(); expect(allocated.closed).toBe(1);
  expect(nativeRenderOwnership(app).select(new Set())).toEqual([]);
});
it("closes the initialized replacement if the previous view refuses retirement", async () => {
  allocated.closed = 0; allocated.failRead = false;
  const app = Object.create(App.prototype) as any;
  const leaf = { view: {}, setView: vi.fn(async () => { throw new Error("old save failed"); }) };
  await expect(app.mountDocumentInLeaf(leaf, { extension: "md", path: "Note.md" }, false)).rejects.toThrow("old save failed");
  expect(allocated.closed).toBe(1); expect(nativeRenderOwnership(app).select(new Set())).toEqual([]);
});
