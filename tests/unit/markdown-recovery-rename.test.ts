import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { MarkdownView } from "../../src/renderer/views/markdown-view";

const storage = (files: Record<string, any>, texts: Record<string, string>) => ({
  rename: vi.fn(async (file: any, to: string) => { delete files[file.path]; file.path = to; file.basename = to.replace(/\.md$/, ""); files[to] = file; }),
  getAbstractFileByPath: (p: string) => files[p] ?? null, getFileByPath: (p: string) => files[p] ?? null,
  getFiles: () => Object.values(files), getMarkdownFiles: () => Object.values(files),
  adapter: { exists: async () => false }, createFolder: vi.fn(async () => {}),
  read: async (f: any) => texts[f.path], modify: vi.fn(async () => {}),
});
it("refuses unresolved recovery in any split before source rename or reference writes", async () => {
  const file = { path: "Old.md", basename: "Old" }; const receipt = {};
  const clean = Object.assign(Object.create(MarkdownView.prototype), { file, conflictReadOnly: false });
  const recovery = Object.assign(Object.create(MarkdownView.prototype), { file, conflictReadOnly: true, recoveryReceipt: receipt, editor: { state: { doc: { toString: () => "exact retained local" } }, contentDOM: { isConnected: true } } });
  const app = Object.assign(Object.create(App.prototype), { vault: { rename: vi.fn(async () => {}), getFileByPath: () => null, modify: vi.fn() }, workspace: { iterateLeaves: (visit: (leaf: unknown) => void) => { visit({ view: clean }); visit({ view: recovery }); } }, metadataCache: { getBacklinks: vi.fn(() => []) } });
  await expect(app.renameFileWithLinkUpdate(file, "New.md")).rejects.toThrow(/recovery/);
  expect(app.vault.rename).not.toHaveBeenCalled(); expect(app.vault.modify).not.toHaveBeenCalled();
  expect(recovery.getText()).toBe("exact retained local"); expect(recovery.editor.contentDOM.isConnected).toBe(true); expect(recovery.recoveryReceipt).toBe(receipt);
});
it("reports successful clean storage rename accurately when a child refuses the later pane refresh", async () => {
  const file: any = { kind: "file", path: "Old.md", basename: "Old", extension: "md" }; const ref: any = { kind: "file", path: "Ref.md", basename: "Ref", extension: "md" };
  const view = Object.assign(Object.create(MarkdownView.prototype), { file, conflictReadOnly: false, setFile: vi.fn(async () => { throw new Error("Finish child draft"); }) });
  const leaf = { view, group: { renderTabs: vi.fn() } };
  const app = Object.assign(Object.create(App.prototype), { notify: vi.fn(), metadataCache: { getCache: () => null }, workspace: { iterateLeaves: (visit: (leaf: unknown) => void) => visit(leaf) }, vault: storage({ "Old.md": file, "Ref.md": ref }, { "Old.md": "", "Ref.md": "[[Old]]" }) });
  await app.renameFileWithLinkUpdate(file, "New.md");
  expect(app.vault.rename).toHaveBeenCalledOnce(); expect(app.vault.modify).toHaveBeenCalledWith(ref, "[[New]]");
  expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/renamed.*could not refresh/i));
});

it("refuses an affected referencer split with unresolved recovery before any storage mutation", async () => {
  const file: any = { kind: "file", path: "Old.md", basename: "Old", extension: "md" }; const ref: any = { kind: "file", path: "Ref.md", basename: "Ref", extension: "md" }; const receipt = {};
  const recovery = Object.assign(Object.create(MarkdownView.prototype), { file: ref, conflictReadOnly: true, recoveryReceipt: receipt, editor: { state: { doc: { toString: () => "retained [[Old]]" } }, contentDOM: { isConnected: true } } });
  const app = Object.assign(Object.create(App.prototype), { vault: storage({ "Old.md": file, "Ref.md": ref }, { "Old.md": "", "Ref.md": "[[Old]]" }), workspace: { iterateLeaves: (visit: (leaf: unknown) => void) => visit({ view: recovery }) }, metadataCache: { getCache: () => null } });
  await expect(app.renameFileWithLinkUpdate(file, "New.md")).rejects.toThrow(/recovery/);
  expect(app.vault.rename).not.toHaveBeenCalled(); expect(app.vault.modify).not.toHaveBeenCalled(); expect(recovery.recoveryReceipt).toBe(receipt);
  expect(recovery.getText()).toBe("retained [[Old]]"); expect(recovery.editor.contentDOM.isConnected).toBe(true);
});
