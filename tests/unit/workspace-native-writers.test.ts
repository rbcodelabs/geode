import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
const modal = vi.hoisted(() => ({ submit: undefined as undefined | ((value: string) => void) }));
vi.mock("../../src/renderer/modals/modals", async importOriginal => ({ ...await importOriginal<typeof import("../../src/renderer/modals/modals")>(), PromptModal: class { constructor(_app: unknown, options: { onSubmit(value: string): void }) { modal.submit = options.onSubmit; } open() {} } }));
afterEach(() => vi.unstubAllGlobals());
it("keeps the actual Base retry control usable after a pre-destructor close abort", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const element = (): any => ({ dataset: {}, children: [] as any[], handlers: {} as Record<string, () => void>, setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, action: () => void) { this.handlers[name] = action; } });
  vi.stubGlobal("document", { createElement: element });
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any; const close = vi.fn(async () => { view.sourceEdit = null; });
  const registry = new RenderOwnership(); const owner = registry.create(view, { writer: view, close });
  const modify = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
  Object.assign(view, { vaultSwitching: false, renderOwner: owner, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), sourceEdit: { file: { path: "Note.md" }, columnPath: "note.priority", rawText: "9" }, saveStatusEl: element(), app: { vault: { read: async () => "---\npriority: 2\n---\n", modify } }, runAndRender: vi.fn(), tableView: { acknowledgeEdit: vi.fn() } });
  const file = view.sourceEdit.file;
  view.app.vault.getAbstractFileByPath = (path: string) => path === file.path ? file : null;
  await expect(view.editCell(file, "note.priority", "9")).rejects.toThrow("disk unavailable");
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
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any; let finish!: (text: string) => void;
  const modify = vi.fn(); const close = vi.fn(async () => {}); const owner = new RenderOwnership().create(view, { close });
  Object.assign(view, { renderOwner: owner, vaultSwitching: false, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), sourceEdit: { file: { path: "Note.md" }, columnPath: "note.priority", rawText: "9" }, setSaveStatus: vi.fn(), app: { vault: { read: () => new Promise<string>(resolve => { finish = resolve; }), modify } } });
  const file = view.sourceEdit.file;
  view.app.vault.getAbstractFileByPath = (path: string) => path === file.path ? file : null;
  const writing = view.editCell(file, "note.priority", "9"); await new Promise(resolve => setImmediate(resolve));
  const closing = owner.close(); finish("---\npriority: 2\n---\n");
  await expect(writing).rejects.toThrow(/owner changed/); await expect(closing).rejects.toThrow(/owner changed/);
  expect(modify).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(view.sourceEdit.rawText).toBe("9");
});
it.each([["Base", BaseView], ["Canvas", CanvasView]] as const)("refuses detached persistence after %s retirement", async (_label, Type) => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.create(Type.prototype) as any; const owner = new RenderOwnership().create(view);
  const doPersist = vi.fn(async () => {});
  Object.assign(view, { renderOwner: owner, vaultSwitching: false, conflictReadOnly: false, definitionWritesPending: 0, persistQueue: Promise.resolve(), doPersist });
  await owner.close(); await view.persist(); expect(doPersist).not.toHaveBeenCalled();
});
it.each([["conversion", false], ["history", false], ["conversion", true], ["history", true]] as const)("tracks a delayed Canvas %s write (rejected: %s) until settlement", async (kind, rejected) => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.create(CanvasView.prototype) as any; const registry = new RenderOwnership(); const owner = registry.create(view, { writer: view });
  let finish!: () => void; const write = vi.fn(() => new Promise<void>((resolve, reject) => { finish = () => rejected ? reject(new Error("write rejected")) : resolve(); }));
  const text = JSON.stringify({ nodes: [], edges: [] });
  Object.assign(view, { transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, conflictGeneration: 0, geometryGestures: new Set(), nodePresentations: new Map(), markdownContentEls: new Set(), renderOwner: owner, pendingConversions: new Map(), pendingConversionNames: new Map(), persistQueue: Promise.resolve(), recoveryError: null, conflictReadOnly: false, vaultSwitching: false, file: { path: "Board.canvas", parent: "" }, document: { nodes: [{ id: "a", type: "text", text: "draft" }], edges: [] }, undoStack: [text], redoStack: [], lastKnownText: text, selectedIds: new Set(), selectedEdgeIds: new Set(), containerEl: { dataset: {} }, render: vi.fn(), doPersist: vi.fn(async () => {}), app: { markdownRenderer: { preflightDisposal() {}, prepareDisposal: async () => ({ commit: async () => {}, abort() {} }) }, notify: vi.fn(), vault: { availablePath: () => "Note.md", create: write, modify: write } } });
  const task = kind === "conversion" ? view.convertTextNodeToFile("a", "Note") : view.restoreHistory("undo");
  await new Promise(resolve => setImmediate(resolve)); expect(write).toHaveBeenCalledOnce();
  let settled = false; const held = registry.hold(new Set([view])).then(scopes => { settled = true; registry.release(scopes); });
  await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  finish(); const results = await Promise.allSettled([task, held]);
  if (rejected) {
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(view.document.nodes[0]).toMatchObject({ type: "text", text: "draft" });
    await expect(owner.close()).rejects.toThrow("write rejected");
  } else if (kind === "conversion") {
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(view.document.nodes[0].type).toBe("text"); expect(view.render).not.toHaveBeenCalled();
    await view.convertTextNodeToFile("a", "Note"); expect(write).toHaveBeenCalledOnce();
    expect(view.document.nodes[0]).toMatchObject({ type: "file", file: "Note.md" });
  } else { expect(results.every(result => result.status === "fulfilled")).toBe(true); }
});
it("refuses retired Markdown rename, bookmark and delayed autosave callbacks", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.create(MarkdownView.prototype) as any; const owner = new RenderOwnership().create(view); await owner.close();
  const renameFile = vi.fn(); const addBlockBookmark = vi.fn(); const modify = vi.fn();
  Object.assign(view, { renderOwner: owner, file: { path: "Note.md", basename: "Note" }, titleEl: { textContent: "Changed" }, editor: { state: { doc: { toString: () => "unsaved" } } }, saveTimer: null, flushInFlight: null, conflictReadOnly: false, lastSavedText: "saved", serializeText: (s: string) => s, app: { renameFile, addBlockBookmark, vault: { modify }, notify: vi.fn() } });
  await view.commitTitleRename(); expect(renameFile).not.toHaveBeenCalled(); await view.bookmarkBlockUnderCursor(); await view.flush();
  expect(renameFile).not.toHaveBeenCalled(); expect(addBlockBookmark).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled();
});
it("prepares a Markdown save before child teardown and permits explicit flush retry after rejection", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.create(MarkdownView.prototype) as any; const childClose = vi.fn(async () => {}); const destroy = vi.fn();
  const owner = new RenderOwnership().create(view, { prepareClose: () => view.prepareCloseNative(), failureKey: "markdown-save", close: () => view.closeNative() } as any); owner.child({ close: childClose });
  const modify = vi.fn().mockRejectedValueOnce(new Error("save rejected")).mockResolvedValue(undefined);
  Object.assign(view, { renderOwner: owner, file: { path: "Note.md" }, editor: { state: { doc: { toString: () => "draft" } }, destroy }, conflictReadOnly: false, lastSavedText: "saved", saveTimer: null, flushInFlight: null, serializeText: (s: string) => s, pagePreview: { destroy: vi.fn() }, clearSyncConflict: vi.fn(), readingContentEl: null, app: { vault: { modify } } });
  await expect(owner.close()).rejects.toThrow("save rejected"); expect(childClose).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
  await view.flush(); await owner.close(); expect(modify).toHaveBeenCalledTimes(2); expect(childClose).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
});
it("rejects an actual detached Base modal submission after owner retirement", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any; const owner = new RenderOwnership().create(view);
  Object.assign(view, { renderOwner: owner, def: { views: [{ name: "Original", type: "table" }] }, app: {}, persist: vi.fn() });
  view.addView(); const submit = modal.submit!; await owner.close(); submit("Detached");
  expect(view.def.views.map((item: any) => item.name)).toEqual(["Original"]); expect(view.persist).not.toHaveBeenCalled();
});
it("publishes a reachable Base retry after close cancels its queued definition write", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const element = (): any => ({ dataset: {}, children: [] as any[], handlers: {} as Record<string, () => void>, setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, action: () => void) { this.handlers[name] = action; } });
  vi.stubGlobal("document", { createElement: element });
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any; const close = vi.fn(async () => {});
  const owner = new RenderOwnership().create(view, { close, recover: (failures: unknown[]) => view.recoverNativeWrites(failures) } as any);
  Object.assign(view, { renderOwner: owner, vaultSwitching: false, definitionWritesPending: 0, persistQueue: Promise.resolve(), doPersist: vi.fn(async () => {}), saveStatusEl: element() });
  const queued = view.persist(); const closing = owner.close();
  await expect(queued).rejects.toThrow(/owner changed/); await expect(closing).rejects.toThrow(/owner changed/);
  const retry = view.saveStatusEl.children.find((child: any) => child.textContent === "Retry Base save"); expect(retry).toBeDefined();
  retry.handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(view.doPersist).toHaveBeenCalledOnce(); expect(view.saveStatusEl.children[0].textContent).toBe("Base saved");
  await owner.close(); expect(close).toHaveBeenCalledOnce();
});
it("keeps a row failure and its actual retry control after a successful definition retry", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const element = (): any => ({ dataset: {}, children: [] as any[], handlers: {} as Record<string, () => void>, setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, action: () => void) { this.handlers[name] = action; } });
  vi.stubGlobal("document", { createElement: element });
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any;
  const owner = new RenderOwnership().create(view, { recover: (failures: unknown[]) => view.recoverNativeWrites(failures) } as any);
  const file = { path: "Source.md" }; const row = vi.fn().mockRejectedValueOnce(new Error("row failed")).mockImplementation(async () => { view.sourceEdit = null; });
  Object.assign(view, { renderOwner: owner, vaultSwitching: false, sourceEdit: { file, columnPath: "note.priority", rawText: "9" }, definitionWritesPending: 0, persistQueue: Promise.resolve(), doPersist: vi.fn(async () => {}), sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), commitCellEdit: row, tableView: { acknowledgeEdit: vi.fn() }, saveStatusEl: element() });
  view.app.vault.getAbstractFileByPath = (path: string) => path === file.path ? file : null;
  await expect(view.editCell(file, "note.priority", "9")).rejects.toThrow("row failed");
  await expect(owner.run(async () => { throw new Error("definition failed"); }, "definition")).rejects.toThrow("definition failed");
  await view.persist(true);
  expect(view.saveStatusEl.children[0].textContent).toBe("Base save failed"); expect(row).toHaveBeenCalledOnce();
  await expect(owner.close()).rejects.toThrow("row failed");
  view.saveStatusEl.children.find((child: any) => child.textContent === "Retry Base save").handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(row).toHaveBeenCalledTimes(2); expect(view.tableView.acknowledgeEdit).toHaveBeenCalledOnce(); await owner.close();
});
it("lets the visible Canvas save retry finish conversion after note creation and a rejected board save", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const element = (): any => ({ dataset: {}, children: [] as any[], handlers: {} as Record<string, () => void>, setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, action: () => void) { this.handlers[name] = action; } });
  vi.stubGlobal("document", { createElement: element });
  const view = Object.create(CanvasView.prototype) as any;
  const owner = new RenderOwnership().create(view, { recover: (failures: unknown[]) => view.recoverNativeWrites(failures) } as any);
  const create = vi.fn(async () => {}); const modify = vi.fn().mockRejectedValueOnce(new Error("board save failed")).mockResolvedValue(undefined);
  const original = { nodes: [{ id: "a", type: "text", text: "original draft", x: 0, y: 0, width: 100, height: 100 }], edges: [] };
  Object.assign(view, { transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, conflictGeneration: 0, geometryGestures: new Set(), nodePresentations: new Map(), markdownContentEls: new Set(), renderOwner: owner, persistQueue: Promise.resolve(), pendingConversions: new Map(), pendingConversionNames: new Map(), recoveryError: null, conflictReadOnly: false, vaultSwitching: false, file: { path: "Board.canvas", parent: "" }, document: structuredClone(original), selectedIds: new Set(), selectedEdgeIds: new Set(), lastKnownText: JSON.stringify(original), pendingKnownText: null, containerEl: { dataset: {} }, saveStatusEl: element(), render: vi.fn(), undoStack: [], redoStack: [], app: { markdownRenderer: { preflightDisposal() {}, prepareDisposal: async () => ({ commit: async () => {}, abort() {} }) }, notify: vi.fn(), vault: { availablePath: () => "Note.md", create, modify } } });
  await expect(view.convertTextNodeToFile("a", "Note")).rejects.toThrow("board save failed");
  expect(view.document.nodes[0]).toMatchObject({ type: "file", file: "Note.md" });
  const retry = view.saveStatusEl.children.find((child: any) => child.textContent === "Retry Canvas save"); expect(retry).toBeDefined();
  retry.handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledWith("Note.md", "original draft"); expect(modify).toHaveBeenCalledTimes(2);
  await expect(owner.close()).resolves.toBeUndefined(); expect(view.pendingConversions.size).toBe(0);
});
it("republishes rolled-back Canvas history after an aborted barrier and retries its original operation", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const element = (): any => ({ dataset: {}, children: [] as any[], handlers: {} as Record<string, () => void>, setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, action: () => void) { this.handlers[name] = action; } });
  vi.stubGlobal("document", { createElement: element });
  const view = Object.create(CanvasView.prototype) as any; const registry = new RenderOwnership();
  const owner = registry.create(view, { writer: view, recover: (failures: unknown[]) => view.recoverNativeWrites(failures) } as any);
  const board = (text: string) => ({ nodes: [{ id: "a", type: "text", text, x: 0, y: 0, width: 100, height: 100 }], edges: [] });
  const original = board("saved"); const before = JSON.stringify(board("before")); let reject!: (error: Error) => void; let projection = "saved";
  const modify = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
  Object.assign(view, { transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, conflictGeneration: 0, geometryGestures: new Set(), nodePresentations: new Map(), markdownContentEls: new Set(), renderOwner: owner, persistQueue: Promise.resolve(), pendingConversions: new Map(), pendingConversionNames: new Map(), recoveryError: null, conflictReadOnly: false, vaultSwitching: false, file: { path: "Board.canvas" }, document: original, lastKnownText: JSON.stringify(original), containerEl: { dataset: {} }, saveStatusEl: element(), render: () => { projection = view.document.nodes[0].text; }, undoStack: [before], redoStack: [], selectedIds: new Set(), selectedEdgeIds: new Set(), app: { notify: vi.fn(), markdownRenderer: { preflightDisposal() {}, prepareDisposal: async () => ({ commit: async () => {}, abort() {} }) }, vault: { modify } } });
  const writing = view.restoreHistory("undo"); await new Promise(resolve => setImmediate(resolve)); expect(projection).toBe("saved"); expect(view.containerEl.inert).toBe(true);
  const holding = registry.hold(new Set([view])); reject(new Error("history save failed"));
  await expect(writing).rejects.toThrow("history save failed"); await expect(holding).rejects.toThrow("history save failed");
  expect(projection).toBe("saved"); expect(view.undoStack).toEqual([before]);
  view.saveStatusEl.children.find((child: any) => child.textContent === "Retry Canvas save").handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(projection).toBe("before"); expect(modify).toHaveBeenCalledTimes(2); await owner.close();
});
it("refuses an active Base cell draft before flushing its definition or row target", () => {
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any;
  Object.assign(view, { sourceEdit: { file: { path: "Note.md" } }, sourceConflictReadOnly: false });
  expect(() => view.assertWorkspaceLoadReady()).toThrow(/cell|draft/i);
});
it("settles both Base definition and row writes and propagates row rejection", async () => {
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any; let finish!: () => void; let settled = false;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(view, { tableView: { editIdentity: null }, sourceEdit: null, sourceConflictReadOnly: false, persistRequestedWhileSuspended: false, persistQueue: Promise.resolve(), sourcePersistsInFlight: new Set([pending]) });
  const settling = view.settleWorkspaceLoad().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false); finish(); await settling;
  const failed = Promise.reject(new Error("row write failed")); void failed.catch(() => {}); view.sourcePersistsInFlight = new Set([failed]);
  await expect(view.settleWorkspaceLoad()).rejects.toThrow("row write failed");
});
it("refuses Canvas recovery, conflict and live gestures before a pause can cancel them", () => {
  const view = Object.create(CanvasView.prototype) as any;
  Object.assign(view, { transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, conflictGeneration: 0, geometryGestures: new Set(), nodePresentations: new Map(), recoveryError: null, conflictReadOnly: false, persistRequestedWhileSuspended: false });
  expect(() => view.assertWorkspaceLoadReady()).not.toThrow();
  for (const [key, value] of [["recoveryError", "invalid canvas"], ["conflictReadOnly", true], ["transientGestureCancel", () => {}], ["touchDragSnapshot", {}]]) {
    const previous = view[key]; view[key] = value; expect(() => view.assertWorkspaceLoadReady()).toThrow(); view[key] = previous;
  }
});
it("settles the latest Canvas document after queued writes and refuses new suspended edits", async () => {
  const view = Object.create(CanvasView.prototype) as any;
  Object.assign(view, { transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, conflictGeneration: 0, geometryGestures: new Set(), nodePresentations: new Map(), recoveryError: null, conflictReadOnly: false, persistRequestedWhileSuspended: false, persistQueue: Promise.resolve(), doPersist: vi.fn(async () => {}) });
  await view.settleWorkspaceLoad(); expect(view.doPersist).toHaveBeenCalledOnce();
  view.persistRequestedWhileSuspended = true; await expect(view.settleWorkspaceLoad()).rejects.toThrow(/changed|edit/i);
});
it("refuses Markdown recovery before any workspace-controlled flush", () => {
  const view = Object.create(MarkdownView.prototype) as any; view.conflictReadOnly = true;
  expect(() => view.assertWorkspaceLoadReady()).toThrow(/conflict|recovery/i);
});
it("retains a Base row target until every concurrent write to that note settles", async () => {
  const { RenderOwnership } = await import("../../src/renderer/workspaces/render-ownership");
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any; const finishes: (() => void)[] = [];
  Object.assign(view, { vaultSwitching: false, file: { path: "Tasks.base" }, definitionWritesPending: 0, pendingKnownText: null, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), renderOwner: new RenderOwnership().create({}), commitCellEdit: () => new Promise<void>(resolve => { finishes.push(resolve); }) });
  const file = { path: "Source.md" };
  const files = new Map([[file.path, file], [view.file.path, view.file]]);
  view.app.vault.getAbstractFileByPath = (path: string) => files.get(path) ?? null;
  const first = view.editCell(file, "note.priority", "9");
  const second = view.editCell(file, "note.priority", "10"); await Promise.resolve();
  finishes[0](); await first; expect(view.workspaceWritePaths()).toEqual(["Source.md"]);
  finishes[1](); await second; expect(view.workspaceWritePaths()).toEqual([]);
});
it("observes a fire-and-forget Base definition failure while preserving it for the barrier", async () => {
  const view = Object.assign(Object.create(BaseView.prototype), { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, app: { notify: vi.fn(), vault: {} } }) as any;
  Object.assign(view, { vaultSwitching: false, definitionWritesPending: 0, persistQueue: Promise.resolve(), doPersist: async () => { throw new Error("definition write failed"); }, sourceEdit: null, tableView: { editIdentity: null }, sourceConflictReadOnly: false, persistRequestedWhileSuspended: false, sourcePersistsInFlight: new Set() });
  void view.persist(); await new Promise(resolve => setImmediate(resolve));
  await expect(view.settleWorkspaceLoad()).rejects.toThrow("definition write failed");
});
