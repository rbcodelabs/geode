import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
afterEach(() => vi.unstubAllGlobals());
it("keeps the actual Base retry control usable after a pre-destructor close abort", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const element = (): any => ({ children: [] as any[], handlers: {} as Record<string, () => void>, setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, action: () => void) { this.handlers[name] = action; } });
  vi.stubGlobal("document", { createElement: element });
  const view = Object.create(BaseView.prototype) as any; const close = vi.fn(async () => { view.sourceEdit = null; });
  const registry = new RenderOwnership(); const owner = registry.create(view, { writer: view, close });
  const modify = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
  Object.assign(view, { vaultSwitching: false, renderOwner: owner, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), sourceEdit: { rawText: "9" }, saveStatusEl: element(), app: { vault: { read: async () => "---\npriority: 2\n---\n", modify } }, runAndRender: vi.fn(), tableView: { acknowledgeEdit: vi.fn() } });
  await expect(view.editCell({ path: "Note.md" }, "note.priority", "9")).rejects.toThrow("disk unavailable");
  const retry = view.saveStatusEl.children.find((child: any) => child.textContent === "Retry Base save");
  await expect(owner.close()).rejects.toThrow("disk unavailable"); expect(close).not.toHaveBeenCalled();
  retry.handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(modify).toHaveBeenCalledTimes(2); expect(view.sourceEdit).toBeNull(); expect(view.tableView.acknowledgeEdit).toHaveBeenCalledOnce();
  await owner.close(); expect(close).toHaveBeenCalledOnce();
});
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
it("refuses a stale Base row write after an awaited read when its owner begins closing", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.create(BaseView.prototype) as any; let finish!: (text: string) => void;
  const modify = vi.fn(); const close = vi.fn(async () => {}); const owner = new RenderOwnership().create(view, { close });
  Object.assign(view, { renderOwner: owner, vaultSwitching: false, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), sourceEdit: { rawText: "9" }, setSaveStatus: vi.fn(), app: { vault: { read: () => new Promise<string>(resolve => { finish = resolve; }), modify } } });
  const writing = view.editCell({ path: "Note.md" }, "note.priority", "9"); await Promise.resolve();
  const closing = owner.close(); finish("---\npriority: 2\n---\n");
  await expect(writing).rejects.toThrow(/owner changed/); await expect(closing).rejects.toThrow(/owner changed/);
  expect(modify).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(view.sourceEdit.rawText).toBe("9");
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
