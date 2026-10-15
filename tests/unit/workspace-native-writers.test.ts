import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
afterEach(() => vi.unstubAllGlobals());
it("disposes every Canvas text render root on repeated redraws", async () => {
  const element = (): any => ({ dataset: {}, style: {}, classList: { toggle() {}, contains: () => false }, appendChild() {}, addEventListener() {}, setAttribute() {} });
  vi.stubGlobal("document", { createElement: element, body: element() });
  const dispose = vi.fn(); const render = vi.fn(async () => {});
  const view = Object.create(CanvasView.prototype) as any;
  const node = { id: "text", type: "text", text: "![[Nested.base]]", x: 0, y: 0, width: 100, height: 100 };
  Object.assign(view, { selectedIds: new Set(), document: { nodes: [node] }, markdownContentEls: new Set(), app: { markdownRenderer: { render, dispose } }, file: { path: "Board.canvas" } });
  for (let version = 1; version <= 3; version++) {
    view.renderNode(node, version);
    expect(view.markdownContentEls.size).toBe(1);
    view.disposeMarkdownContents();
    expect(view.markdownContentEls.size).toBe(0);
  }
  expect(dispose.mock.calls.map(([root]) => root)).toEqual(render.mock.calls.map(([, root]) => root));
});
it("refuses an active Base cell draft before flushing its definition or row target", () => {
  const view = Object.create(BaseView.prototype) as any;
  Object.assign(view, { sourceEdit: { file: { path: "Note.md" } }, sourceConflictReadOnly: false });
  expect(() => view.assertWorkspaceLoadReady()).toThrow(/cell|draft/i);
});
it("settles both Base definition and row writes and propagates row rejection", async () => {
  const view = Object.create(BaseView.prototype) as any; let finish!: () => void; let settled = false;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(view, { sourceEdit: null, sourceConflictReadOnly: false, persistRequestedWhileSuspended: false, persistQueue: Promise.resolve(), sourcePersistsInFlight: new Set([pending]) });
  const settling = view.settleWorkspaceLoad().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false); finish(); await settling;
  const failed = Promise.reject(new Error("row write failed")); void failed.catch(() => {}); view.sourcePersistsInFlight = new Set([failed]);
  await expect(view.settleWorkspaceLoad()).rejects.toThrow("row write failed");
});
it("refuses Canvas recovery, conflict and live gestures before a pause can cancel them", () => {
  const view = Object.create(CanvasView.prototype) as any;
  Object.assign(view, { recoveryError: null, conflictReadOnly: false, transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, persistRequestedWhileSuspended: false });
  expect(() => view.assertWorkspaceLoadReady()).not.toThrow();
  for (const [key, value] of [["recoveryError", "invalid canvas"], ["conflictReadOnly", true], ["transientGestureCancel", () => {}], ["touchDragSnapshot", {}]]) {
    const previous = view[key]; view[key] = value; expect(() => view.assertWorkspaceLoadReady()).toThrow(); view[key] = previous;
  }
});
it("settles the latest Canvas document after queued writes and refuses new suspended edits", async () => {
  const view = Object.create(CanvasView.prototype) as any;
  Object.assign(view, { recoveryError: null, conflictReadOnly: false, transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, persistRequestedWhileSuspended: false, persistQueue: Promise.resolve(), doPersist: vi.fn(async () => {}) });
  await view.settleWorkspaceLoad(); expect(view.doPersist).toHaveBeenCalledOnce();
  view.persistRequestedWhileSuspended = true; await expect(view.settleWorkspaceLoad()).rejects.toThrow(/changed|edit/i);
});
it("refuses Markdown recovery before any workspace-controlled flush", () => {
  const view = Object.create(MarkdownView.prototype) as any; view.conflictReadOnly = true;
  expect(() => view.assertWorkspaceLoadReady()).toThrow(/conflict|recovery/i);
});
it("retains a Base row target until every concurrent write to that note settles", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.create(BaseView.prototype) as any; const finishes: (() => void)[] = [];
  Object.assign(view, { vaultSwitching: false, file: { path: "Tasks.base" }, definitionWritesPending: 0, pendingKnownText: null, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), renderOwner: new RenderOwnership().create({}), commitCellEdit: () => new Promise<void>(resolve => { finishes.push(resolve); }) });
  const first = view.editCell({ path: "Source.md" }, "note.priority", "9");
  const second = view.editCell({ path: "Source.md" }, "note.priority", "10"); await Promise.resolve();
  finishes[0](); await first; expect(view.workspaceWritePaths()).toEqual(["Source.md"]);
  finishes[1](); await second; expect(view.workspaceWritePaths()).toEqual([]);
});
it("observes a fire-and-forget Base definition failure while preserving it for the barrier", async () => {
  const view = Object.create(BaseView.prototype) as any;
  Object.assign(view, { vaultSwitching: false, definitionWritesPending: 0, persistQueue: Promise.resolve(), doPersist: async () => { throw new Error("definition write failed"); }, sourceEdit: null, sourceConflictReadOnly: false, persistRequestedWhileSuspended: false, sourcePersistsInFlight: new Set() });
  void view.persist(); await new Promise(resolve => setImmediate(resolve));
  await expect(view.settleWorkspaceLoad()).rejects.toThrow("definition write failed");
});
