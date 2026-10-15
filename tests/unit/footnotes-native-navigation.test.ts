import { afterEach, expect, it, vi } from "vitest";
import { FootnotesView } from "../../src/renderer/views/footnotes-view";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
const source = "Body[^a]\n\n[^a]: Footnote text";
const item = { key: "definition:a", label: "1", text: "Footnote text", references: 1, missing: false, from: 10, to: 29, editFrom: 16, editTo: 29, editable: true };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("document", { body: {}, activeElement: null });
  const file = { path: "Note.md", extension: "md" }, leaf = {}; let active = leaf; let snapshot = source;
  const vault = { root: "synthetic", getFileByPath: () => file };
  const editor = { state: { doc: { toString: () => snapshot, length: source.length } }, dispatch: vi.fn(), focus: vi.fn() };
  const app = { vault, workspace: { getActiveFile: () => file, getActiveLeaf: () => active, findLeafForView: () => leaf }, getActiveMarkdownView: () => view, markdownRenderer: { dispose: vi.fn() }, notify: vi.fn() } as any;
  const view = Object.assign(Object.create(MarkdownView.prototype), { app, file, editor, mode: "reading", lastEditingMode: "live", transitionTail: Promise.resolve(), transitionGeneration: 0, transitionClosing: false, readingRenderGeneration: 0, bodyEl: { inert: false, contains: () => false }, pagePreview: { hide() {} }, editingCompartment: { reconfigure: () => ({}) }, editorHostEl: { style: {} }, readingEl: { style: {}, innerHTML: "Reading" }, flush: vi.fn(async () => {}) }) as any;
  view.renderOwner = new RenderOwnership().create(view);
  const toggle = view.toggleSource.bind(view);
  view.toggleSource = vi.fn((...args: unknown[]) => { const pending = toggle(...args); void pending.catch(() => {}); return pending; });
  const pane = Object.assign(Object.create(FootnotesView.prototype), { app, root: vault.root, closed: false, navigationGeneration: 0, generation: 0, containerEl: { isConnected: true, closest: () => null }, status: { textContent: "" }, schedule: vi.fn() }) as any;
  return { pane, view, app, editor, file, leaf, setActive: (next: object) => { active = next; }, setText: (next: string) => { snapshot = next; } };
}
it("awaits real Reading reveal and source-mode replacement before selecting the editable definition", async () => {
  const { pane, view, editor, file } = fixture();
  await pane.navigate(file, source, item, true); await new Promise(resolve => setImmediate(resolve));
  expect(view.mode).toBe("source"); expect(editor.dispatch).toHaveBeenLastCalledWith({ selection: { anchor: 16, head: 29 }, scrollIntoView: true }); expect(editor.focus).toHaveBeenCalledOnce();
});
it.each(["active leaf", "view", "file", "path", "vault", "root", "snapshot", "read-only", "closed", "hidden"])("does not select or focus a stale footnote after awaited reveal changes %s", async change => {
  const f = fixture(); let finish!: () => void; f.view.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const navigating = f.pane.navigate(f.file, source, item, true); await new Promise(resolve => setImmediate(resolve));
  if (change === "active leaf") f.setActive({});
  if (change === "view") f.app.getActiveMarkdownView = () => null;
  if (change === "file") f.app.workspace.getActiveFile = () => ({ path: "Other.md" });
  if (change === "path") f.file.path = "Moved.md";
  if (change === "vault") f.app.vault = { ...f.app.vault };
  if (change === "root") f.app.vault.root = "other";
  if (change === "snapshot") f.setText("changed source");
  if (change === "read-only") f.view.conflictReadOnly = true;
  if (change === "closed") f.pane.closed = true;
  if (change === "hidden") f.pane.containerEl.closest = () => ({});
  f.editor.focus.mockClear(); f.editor.dispatch.mockClear(); finish();
  await navigating; await new Promise(resolve => setImmediate(resolve));
  expect(f.editor.dispatch.mock.calls.filter(([spec]: any[]) => spec.selection?.head === item.editTo)).toHaveLength(0);
  expect(f.view.toggleSource).not.toHaveBeenCalled();
  // Native reveal may place its own cursor, but the pane must not add a
  // final stale edit selection or focus after that await.
  expect(f.editor.focus).not.toHaveBeenCalled();
});
it("reports an actual native preparation error without selecting the definition", async () => {
  const { pane, view, editor, file } = fixture(); view.flush = vi.fn(async () => { throw Error("native save failed"); });
  await pane.navigate(file, source, item, true); await new Promise(resolve => setImmediate(resolve));
  expect(pane.status.textContent).toContain("native save failed"); expect(editor.dispatch).not.toHaveBeenCalled(); expect(editor.focus).not.toHaveBeenCalled();
});
it("Jump leaves Reading through the native reveal without forcing source mode or selecting editable text", async () => {
  const { pane, view, editor, file } = fixture(); await pane.navigate(file, source, item, false); await new Promise(resolve => setImmediate(resolve));
  expect(view.mode).toBe("live"); expect(view.toggleSource).not.toHaveBeenCalled(); expect(editor.dispatch).toHaveBeenLastCalledWith({ selection: { anchor: 10, head: 10 }, scrollIntoView: true });
});

it.each(["active leaf", "snapshot"])("rechecks %s after the second awaited mode transition", async change => {
  const f = fixture(); let finish!: () => void; let calls = 0;
  f.view.flush = () => ++calls === 2 ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve();
  const navigating = f.pane.navigate(f.file, source, item, true); await new Promise(resolve => setImmediate(resolve));
  expect(calls).toBe(2); f.editor.dispatch.mockClear(); f.editor.focus.mockClear();
  if (change === "active leaf") f.setActive({}); else f.setText("changed during source transition");
  finish(); await navigating;
  expect(f.editor.dispatch.mock.calls.filter(([spec]: any[]) => spec.selection?.head === item.editTo)).toHaveLength(0);
  expect(f.editor.focus).not.toHaveBeenCalled();
});
it("keeps a refusing actual native subtree connected without source selection or focus", async () => {
  const f = fixture(); const close = vi.fn(async () => {});
  f.view.readingProjection = f.view.renderOwner.child({ preflightClose: () => { throw Error("Finish nested Base draft"); }, close });
  await f.pane.navigate(f.file, source, item, true);
  expect(f.pane.status.textContent).toContain("Finish nested Base draft"); expect(f.editor.dispatch).not.toHaveBeenCalled(); expect(f.editor.focus).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(f.view.mode).toBe("reading");
});
it("does not reuse a row after its indexed source file is replaced at the same path", async () => {
  const f = fixture(); let finish!: () => void; f.view.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const navigating = f.pane.navigate(f.file, source, item, true); await new Promise(resolve => setImmediate(resolve));
  f.app.vault.getFileByPath = () => ({ ...f.file }); f.editor.dispatch.mockClear(); finish(); await navigating;
  expect(f.view.toggleSource).not.toHaveBeenCalled(); expect(f.editor.dispatch.mock.calls.filter(([spec]: any[]) => spec.selection?.head === item.editTo)).toHaveLength(0);
});

it.each(["closed", "hidden"])("does not let native reveal focus steal focus after the Footnotes pane becomes %s", async state => {
  const f = fixture(); let finish!: () => void; f.view.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const navigating = f.pane.navigate(f.file, source, item, true); await new Promise(resolve => setImmediate(resolve));
  if (state === "closed") f.pane.closed = true; else f.pane.containerEl.closest = () => ({});
  finish(); await navigating;
  expect(f.editor.focus).not.toHaveBeenCalled(); expect(f.view.toggleSource).not.toHaveBeenCalled();
});

it("keeps the default native reveal and source-toggle focus behavior for other callers", async () => {
  const f = fixture(); await f.view.scrollToOffsetAsync(10);
  expect(f.view.mode).toBe("live"); expect(f.editor.focus).toHaveBeenCalledTimes(2);
  f.editor.focus.mockClear(); await f.view.toggleSource();
  expect(f.view.mode).toBe("source"); expect(f.editor.focus).toHaveBeenCalledOnce();
});
