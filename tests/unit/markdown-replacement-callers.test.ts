import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { WorkspaceLeaf } from "../../src/renderer/workspace";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
afterEach(() => vi.unstubAllGlobals());
it("waits for the actual external replacement before reporting modify handling complete", async () => {
  const file = { path: "Note.md" }; let finish!: () => void;
  const view = Object.assign(Object.create(MarkdownView.prototype), { file, flushInFlight: null, getLastKnownText: () => "old", hasUnacknowledgedChanges: () => false, acceptExternalText: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
  const app = Object.assign(Object.create(App.prototype), { vault: {}, workspace: { findLeafForFile: () => ({ view }) } });
  let done = false; const handling = app.processExternalModify(file, "provider").then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false); finish(); await handling;
});
it("awaits the native subpath reveal before restoring background focus", async () => {
  let finish!: () => void; const prior = { isConnected: true, focus: vi.fn() }; const current = {};
  vi.stubGlobal("document", { activeElement: prior });
  const view = { viewType: "markdown", scrollToOffset: vi.fn(), scrollToOffsetAsync: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
  const leaf = Object.assign(Object.create(WorkspaceLeaf.prototype), { view, contentEl: { contains: (el: unknown) => el === current }, app: { openFileInLeaf: async () => { (document as any).activeElement = current; }, resolveSubpathOffset: async () => 12 } });
  const opening = leaf.openFile({ path: "Note.md" }, { active: false, eState: { subpath: "#Section" } });
  await new Promise(resolve => setImmediate(resolve)); expect(view.scrollToOffsetAsync).toHaveBeenCalledWith(12); expect(prior.focus).not.toHaveBeenCalled();
  finish(); await opening; expect(prior.focus).toHaveBeenCalledOnce(); expect(view.scrollToOffset).not.toHaveBeenCalled();
});
it("reveals offsets in the captured intended view even if another split becomes active", async () => {
  const file = { path: "Note.md", extension: "md" };
  const intended = Object.assign(Object.create(MarkdownView.prototype), { file, scrollToOffsetAsync: vi.fn(async () => {}) });
  const other = { scrollToOffset: vi.fn() }; const leaf = { view: intended, group: { setActiveLeaf: vi.fn() } };
  const app = Object.assign(Object.create(App.prototype), { vault: {}, workspace: { findLeafForFile: () => leaf, getLeaf: () => leaf }, openFileInLeaf: vi.fn(async () => {}), openFile: vi.fn(async () => {}), getActiveMarkdownView: () => other, notify: vi.fn() });
  app.revealOffsetInActiveMarkdownView(file, 12); await new Promise(resolve => setImmediate(resolve));
  expect(intended.scrollToOffsetAsync).toHaveBeenCalledWith(12); expect(other.scrollToOffset).not.toHaveBeenCalled();
});
it("does not reveal an old subpath into a different note loaded in the same view during lookup", async () => {
  vi.stubGlobal("document", { activeElement: null });
  const original = { path: "Note.md" }; const other = { path: "Other.md" }; let current = original;
  let finish!: (offset: number) => void;
  const view = { viewType: "markdown", getFile: () => current, scrollToOffsetAsync: vi.fn(async () => {}) };
  const leaf = Object.assign(Object.create(WorkspaceLeaf.prototype), { view, app: { openFileInLeaf: async () => {}, resolveSubpathOffset: () => new Promise<number>(resolve => { finish = resolve; }) } });
  const opening = leaf.openFile(original, { eState: { subpath: "#Section" } });
  await Promise.resolve(); current = other; finish(12); await opening;
  expect(view.scrollToOffsetAsync).not.toHaveBeenCalled();
});
