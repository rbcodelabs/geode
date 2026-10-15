import { afterEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const view = Object.create(CanvasView.prototype) as any;
  const node = { id: "a", type: "text", text: "![[Tasks.base]]", x: 0, y: 0, width: 300, height: 300 };
  const sourceRoot = { replaceWith: vi.fn() };
  const editor = { addEventListener() {}, focus: vi.fn(), select() {} };
  vi.stubGlobal("document", { createElement: () => editor });
  const wrapper = { contains: () => true, querySelector: (selector: string) => selector === ".canvas-node-text" ? sourceRoot : null, inert: false };
  const contents = {};
  Object.assign(view, { containerEl: { classList: { remove() {} } }, document: { nodes: [node], edges: [] }, file: { path: "Board.canvas" }, recoveryError: null, transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, conflictGeneration: 0, geometryGestures: new Set(), nodePresentations: new Map([["a", { node, el: wrapper }]]), markdownContentEls: new Set([contents]), selectedIds: new Set(["a"]), selectedEdgeIds: new Set(), undoStack: ["undo"], redoStack: [], lastKnownText: "original", render: vi.fn(), persist: vi.fn(), app: { notify: vi.fn(), markdownRenderer: { preflightDisposal() {}, prepareDisposal: vi.fn(async () => { throw new Error("Finish the Base cell draft first."); }) } } });
  return { view, node, wrapper, sourceRoot };
}
it("refuses deletion before changing model, selection, history or writes when an embedded draft cannot retire", async () => {
  const { view, node, wrapper } = fixture();
  await view.deleteSelection();
  expect(view.document.nodes).toEqual([node]); expect([...view.selectedIds]).toEqual(["a"]); expect(view.undoStack).toEqual(["undo"]);
  expect(view.persist).not.toHaveBeenCalled(); expect(view.render).not.toHaveBeenCalled(); expect(wrapper.inert).toBe(false);
  expect(view.app.notify).toHaveBeenCalledWith(expect.stringMatching(/draft/));
});
it("refuses reload before changing cached bytes, model or history", async () => {
  const { view, node } = fixture();
  await view.load('{"nodes":[],"edges":[]}', true);
  expect(view.document.nodes).toEqual([node]); expect(view.lastKnownText).toBe("original"); expect(view.undoStack).toEqual(["undo"]);
  expect(view.render).not.toHaveBeenCalled();
});
it("refuses entering Canvas source before replacing the embedded editor", async () => {
  const { view, node, wrapper, sourceRoot } = fixture();
  await view.editTextNode(wrapper, node);
  expect(sourceRoot.replaceWith).not.toHaveBeenCalled(); expect(view.document.nodes).toEqual([node]); expect(view.app.markdownRenderer.prepareDisposal).toHaveBeenCalled();
  expect(view.app.notify).toHaveBeenCalledWith(expect.stringMatching(/draft/));
});

it("waits for every retirement preparation before deletion and commits only once", async () => {
  const { view, node, wrapper } = fixture(); let finish!: () => void;
  const commit = vi.fn(async () => {});
  view.app.markdownRenderer.prepareDisposal.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ commit, abort: vi.fn() }); }));
  const deleting = view.deleteSelection();
  expect(view.document.nodes).toEqual([node]); expect(view.selectedIds.has("a")).toBe(true); expect(commit).not.toHaveBeenCalled();
  expect(wrapper.inert).toBe(true);
  finish(); await deleting;
  expect(commit).toHaveBeenCalledOnce(); expect(view.document.nodes).toEqual([]); expect(view.selectedIds.size).toBe(0);
  expect(view.persist).toHaveBeenCalledOnce(); expect(wrapper.inert).toBe(false);
});

it("refuses history before queuing or acknowledging a saved-write retry", async () => {
  const { view, node } = fixture(); view.queueOwnedWrite = vi.fn();
  await view.restoreHistory("undo");
  expect(view.document.nodes).toEqual([node]); expect(view.undoStack).toEqual(["undo"]); expect(view.queueOwnedWrite).not.toHaveBeenCalled();
});

it("rejects a stale prepared request without retiring or changing a newer model", async () => {
  const { view } = fixture(); let finish!: () => void;
  const commit = vi.fn(); const abort = vi.fn();
  view.app.markdownRenderer.prepareDisposal.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ commit, abort }); }));
  const deleting = view.deleteSelection();
  const replacement = { nodes: [], edges: [] }; view.document = replacement;
  finish(); await deleting;
  expect(view.document).toBe(replacement); expect(commit).not.toHaveBeenCalled(); expect(abort).toHaveBeenCalled(); expect(view.persist).not.toHaveBeenCalled();
});

it("refuses conversion before creating a note or changing its source presentation", async () => {
  const { view, node } = fixture(); view.pendingConversions = new Map(); view.pendingConversionNames = new Map();
  const create = vi.fn(); view.app.vault = { create, availablePath: () => "Note.md" };
  await view.convertTextNodeToFile("a", "Note");
  expect(create).not.toHaveBeenCalled(); expect(node).toMatchObject({ type: "text", text: "![[Tasks.base]]" });
  expect(view.pendingConversions.size).toBe(0);
});

it("keeps refused conflict controls interactive instead of blurring a nested draft", async () => {
  const { view } = fixture();
  view.surfaceEl = { inert: false }; view.containerEl = { dataset: {}, querySelector: () => null, appendChild() {} };
  vi.stubGlobal("document", { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }) });
  view.app.markdownRenderer.preflightDisposal = () => { throw new Error("Finish the Base cell draft first."); };
  view.presentConflict(null, null, true);
  await new Promise(resolve => setImmediate(resolve));
  expect(view.conflictReadOnly).toBe(true); expect(view.surfaceEl.inert).toBe(false);
  expect(view.app.notify).toHaveBeenCalledWith(expect.stringMatching(/draft/));
});


it("keeps partially retired controls disabled with a persistent error instead of resuming them", async () => {
  const { view, node, wrapper } = fixture(); view.setSaveStatus = vi.fn();
  view.app.markdownRenderer.prepareDisposal.mockResolvedValue({ commit: async () => { throw new Error("destructor failed"); }, abort: vi.fn() });
  await view.deleteSelection();
  expect(view.document.nodes).toEqual([node]); expect(view.persist).not.toHaveBeenCalled();
  expect(wrapper.inert).toBe(true); expect(view.presentationRetirementFailed).toBe(true);
  expect(view.setSaveStatus).toHaveBeenCalledWith(expect.stringMatching(/teardown failed/), true, false);
});

it("refuses native owner retirement while its own Canvas source editor still has a draft", () => {
  const { view, wrapper } = fixture();
  Object.assign(view, { conflictReadOnly: false, transientGestureCancel: null, touchDragSnapshot: null, touchGesture: { pointerIds: () => [] }, persistRequestedWhileSuspended: false });
  wrapper.querySelector = () => ({});
  expect(() => view.assertWorkspaceLoadReady()).toThrow(/text draft/);
});

it("does not let an older prepared external projection unlock or replace a newer conflict", async () => {
  const { view, node } = fixture(); let finish!: () => void;
  view.surfaceEl = { inert: false }; view.containerEl = { dataset: {}, querySelector: () => null, appendChild() {}, classList: { remove() {} } };
  vi.stubGlobal("document", { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }) });
  const commit = vi.fn(); const abort = vi.fn();
  view.app.markdownRenderer.prepareDisposal.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ commit, abort }); }));
  view.presentConflict('{"nodes":[],"edges":[]}', "Old.canvas", false);
  view.presentConflict(null, "New.canvas", true);
  finish(); await new Promise(resolve => setImmediate(resolve));
  expect(view.conflictReadOnly).toBe(true); expect(view.containerEl.dataset.canvasConflictPath).toBe("New.canvas");
  expect(view.document.nodes).toEqual([node]); expect(view.lastKnownText).toBe("original"); expect(commit).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalled();
});


it("refuses a delayed delete whose intended selection changed before retirement", async () => {
  const { view, node } = fixture(); let finish!: () => void;
  const commit = vi.fn(); const abort = vi.fn();
  view.app.markdownRenderer.prepareDisposal.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ commit, abort }); }));
  const deleting = view.deleteSelection(); view.selectedIds.clear();
  finish(); await deleting;
  expect(view.document.nodes).toEqual([node]); expect(commit).not.toHaveBeenCalled(); expect(abort).toHaveBeenCalled();
  expect(view.persist).not.toHaveBeenCalled();
});

it("keeps the current history model until its new bytes are acknowledged and blocks new drafts during the write", async () => {
  const { view, node } = fixture(); let finish!: () => void;
  view.containerEl = { dataset: {}, inert: false }; view.setSaveStatus = vi.fn();
  view.lastKnownText = JSON.stringify(view.document); view.undoStack = ['{"nodes":[],"edges":[]}']; view.persistQueue = Promise.resolve();
  view.app.markdownRenderer.prepareDisposal.mockResolvedValue({ commit: async () => {}, abort() {} });
  view.app.vault = { modify: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
  const undoing = view.restoreHistory("undo"); await new Promise(resolve => setImmediate(resolve));
  expect(view.document.nodes).toEqual([node]); expect(view.containerEl.inert).toBe(true);
  finish(); await undoing;
  expect(view.document.nodes).toEqual([]); expect(view.containerEl.inert).toBe(false); expect(view.undoStack).toEqual([]);
});

it("does not publish history into a newer conflict after its already-started write settles", async () => {
  const { view, node } = fixture(); let finish!: () => void;
  view.containerEl = { dataset: {}, inert: false, querySelector: () => null, appendChild() {} }; view.surfaceEl = { inert: false }; view.setSaveStatus = vi.fn();
  vi.stubGlobal("document", { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }) });
  view.lastKnownText = JSON.stringify(view.document); view.undoStack = ['{"nodes":[],"edges":[]}']; view.persistQueue = Promise.resolve();
  view.app.markdownRenderer.prepareDisposal.mockResolvedValue({ commit: async () => {}, abort() {} });
  view.app.vault = { modify: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
  const undoing = view.restoreHistory("undo"); await new Promise(resolve => setImmediate(resolve));
  view.presentConflict(null, "New.canvas", true); finish();
  await expect(undoing).resolves.toBeUndefined();
  expect(view.document.nodes).toEqual([node]); expect(view.conflictReadOnly).toBe(true); expect(view.undoStack).toHaveLength(1);
});


it.each(["drag", "resize", "duplicate"])("refuses native replacement during an admitted mouse %s and releases it on pointer cancellation", async kind => {
  const { view, node } = fixture(); const listeners = new Map<string, (...args: any[]) => void>();
  vi.stubGlobal("window", { addEventListener: (name: string, action: (...args: any[]) => void) => listeners.set(name, action), removeEventListener: (name: string) => listeners.delete(name) });
  Object.assign(view, { surfaceEl: { focus() {} }, scale: 1, alignmentTargets: () => ({ x: [], y: [] }), trackGestureSpaceBypass: () => ({ pressed: () => false, dispose() {} }), updateSelectionClasses() {} });
  const event = { button: 0, pointerType: "mouse", clientX: 0, clientY: 0, target: { closest: () => null }, stopPropagation() {}, preventDefault() {} };
  if (kind === "drag") view.beginNodeDrag(event, node);
  else if (kind === "resize") view.beginResize(event, node);
  else view.beginNodeDuplication(event, node);
  expect(view.geometryGestures.size).toBe(1);
  await view.deleteSelection(); expect(view.app.markdownRenderer.prepareDisposal).not.toHaveBeenCalled();
  listeners.get("pointercancel")!(); expect(view.geometryGestures.size).toBe(0); expect(listeners.size).toBe(0);
});

it("blocks ordinary selection changes during preparation while checking direct mutation before retirement", async () => {
  const { view } = fixture(); let finish!: () => void;
  view.app.markdownRenderer.prepareDisposal.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ commit: async () => {}, abort() {} }); }));
  const deleting = view.deleteSelection(); view.clearSelection();
  expect([...view.selectedIds]).toEqual(["a"]);
  finish(); await deleting; expect(view.document.nodes).toEqual([]);
});
