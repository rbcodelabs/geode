import { afterEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { RenderScope } from "../../src/renderer/workspaces/render-ownership";
vi.mock("../../src/renderer/workspace", () => ({ buildViewHeaderNavButtons: () => document.createElement("div") }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
class Element {
  className = ""; dataset: Record<string, string> = {}; style = { setProperty() {} }; namespaceURI = "svg";
  children: Element[] = []; parentElement: Element | null = null; attributes = new Map<string, string>(); inert = false;
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(" ")}`; }, remove: (...names: string[]) => { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); }, contains: (name: string) => this.className.split(" ").includes(name), toggle() {} };
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.classList.contains(selector.replace(/^\./, "")) ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener() {} removeEventListener() {} focus() {} hasPointerCapture() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
}
function fixture(kind: "reconnect" | "connection" = "reconnect") {
  const listeners = new Map<string, Set<(event: any) => void>>();
  vi.stubGlobal("window", { addEventListener(name: string, callback: (event: any) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); }, removeEventListener(name: string, callback: (event: any) => void) { listeners.get(name)?.delete(callback); } });
  vi.stubGlobal("document", { createElement: () => new Element(), createElementNS: () => new Element(), body: new Element() });
  for (const name of ["installCameraControls", "installTouchControls", "updateTransform", "updateSelectionClasses", "render", "disposeMarkdownContents", "revokeObjectUrls"]) vi.spyOn(CanvasView.prototype as any, name).mockImplementation(() => {});
  for (const name of ["buildCameraControls", "buildCanvasToolbar"]) vi.spyOn(CanvasView.prototype as any, name).mockImplementation(() => new Element());
  const modify = vi.fn(async () => {}), off = vi.fn();
  const app = { vault: { root: "/synthetic-vault", modify, off }, notify: vi.fn() };
  const view = new CanvasView(app as any) as any;
  view.file = { path: "Board.canvas" };
  view.document = { nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 100 }, { id: "b", type: "text", text: "B", x: 200, y: 0, width: 100, height: 100 }], edges: [{ id: "edge", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }] };
  const model = view.document, edge = model.edges[0], before = view.getText(); view.lastKnownText = before;
  const svg = new Element(); svg.className = "canvas-edges"; view.viewportEl.appendChild(svg);
  const event = { button: 0, pointerId: 606, pointerType: "touch", clientX: 200, clientY: 50, preventDefault() {}, stopPropagation() {} };
  if (kind === "reconnect") view.beginEdgeReconnect(event, "edge", "target"); else view.beginConnection(event, model.nodes[0], "right");
  const preview = svg.querySelector(".canvas-edge-preview")!;
  expect(preview).not.toBeNull(); expect(view.containerEl.classList.contains("is-connecting")).toBe(true);
  const lateUp = [...listeners.get("pointerup")!][0], lateCancel = [...listeners.get("pointercancel")!][0];
  vi.mocked(view.render).mockClear();
  return { view, model, edge, before, modify, preview, listeners, event, lateUp, lateCancel };
}
it.each(["reconnect", "connection"] as const)("ordinary close retires unchanged %s without render, rollback or provider write", async kind => {
  const f = fixture(kind); const root = f.view.containerEl; const undo = [...f.view.undoStack];
  await f.view.onClose();
  expect(f.preview.parentElement).toBeNull(); expect(root.classList.contains("is-connecting")).toBe(false);
  expect(f.listeners.get("pointerup")?.size).toBe(0); expect(f.listeners.get("pointercancel")?.size).toBe(0);
  expect(f.view.document).toBe(f.model); expect(f.model.edges[0]).toBe(f.edge); expect(f.view.getText()).toBe(f.before);
  expect(f.view.undoStack).toEqual(undo); expect(f.view.render).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
  f.lateUp(f.event); f.lateCancel(f.event); await f.view.onClose();
  expect(f.view.getText()).toBe(f.before); expect(f.modify).not.toHaveBeenCalled(); expect(f.view.render).not.toHaveBeenCalled();
});
it.each(["recovery", "conflict", "geometry", "touch-drag", "touch-pointers", "history", "presentation", "suspended", "text-draft"])("ordinary preview close preserves the %s refusal guard", async cause => {
  const f = fixture();
  if (cause === "recovery") f.view.recoveryError = "recover";
  if (cause === "conflict") f.view.conflictReadOnly = true;
  if (cause === "geometry") f.view.geometryGestures.add(() => {});
  if (cause === "touch-drag") f.view.touchDragSnapshot = { id: "a", x: 0, y: 0 };
  if (cause === "touch-pointers") f.view.touchGesture.down({ pointerId: 9, x: 0, y: 0 });
  if (cause === "history") f.view.historyInProgress = true;
  if (cause === "presentation") f.view.presentationChangeInProgress = true;
  if (cause === "suspended") f.view.persistRequestedWhileSuspended = true;
  if (cause === "text-draft") { const node = new Element(); const input = new Element(); input.className = "canvas-node-text-editor"; node.appendChild(input); f.view.nodePresentations.set("draft", { el: node }); }
  await expect(f.view.onClose()).rejects.toThrow();
  expect(f.preview.parentElement).not.toBeNull(); expect(f.view.renderOwner.admissionAllowed).toBe(true);
  expect(f.view.getText()).toBe(f.before); expect(f.modify).not.toHaveBeenCalled(); expect(f.view.render).not.toHaveBeenCalled();
});
it("a descendant refusal precedes cancellation of the root preview", async () => {
  const f = fixture(); const close = vi.fn(async () => {});
  f.view.renderOwner.child({ preflightClose: () => { throw Error("finish Base draft"); }, close });
  await expect(f.view.onClose()).rejects.toThrow("finish Base draft");
  expect(f.preview.parentElement).not.toBeNull(); expect(close).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
});
it("workspace and implicit retirement remain strict for the same preview", async () => {
  const f = fixture(); expect(() => f.view.assertWorkspaceLoadReady()).toThrow(/gesture/i);
  expect(() => f.view.renderOwner.assertRetirementReady()).toThrow(/gesture/i);
  await expect(RenderScope.prepareRetirement([f.view.renderOwner])).rejects.toThrow(/gesture/i);
  await expect(f.view.renderOwner.close()).rejects.toThrow(/gesture/i);
  await expect(f.view.closeImplicitly()).rejects.toThrow(/gesture/i);
  expect(f.preview.parentElement).not.toBeNull(); expect(f.modify).not.toHaveBeenCalled();
});
it("retained native write failures still prevent preview cancellation", async () => {
  const f = fixture(); await f.view.renderOwner.run(async () => { throw Error("retained save"); }, "save").catch(() => {});
  await expect(f.view.onClose()).rejects.toThrow("retained save"); expect(f.view.renderOwner.hasUnacknowledgedWrites).toBe(true);
  expect(f.preview.parentElement).not.toBeNull(); expect(f.modify).not.toHaveBeenCalled();
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
it.each(["model-bytes", "model-identity", "file-identity", "file-path", "vault-identity", "vault-root", "edge-identity", "preview-removed", "cancel-replaced"])("a held ordinary close refuses changed %s without rollback or fictional save failure", async change => {
  const f = fixture(), gate = deferred(); const destructor = vi.spyOn(f.view, "closeNative");
  const childClose = vi.fn(async () => {}); f.view.renderOwner.child({ close: childClose });
  const pending = f.view.renderOwner.run(async () => { await gate.promise; });
  await Promise.resolve(); const closing = f.view.onClose(); let settled = false; void closing.then(() => { settled = true; }, () => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false); expect(f.preview.parentElement).not.toBeNull();
    if (change === "model-bytes") f.model.nodes[0].text = "Newer model";
    if (change === "model-identity") f.view.document = structuredClone(f.model);
    if (change === "file-identity") f.view.file = { ...f.view.file };
    if (change === "file-path") f.view.file.path = "Retargeted.canvas";
    if (change === "vault-identity") f.view.app.vault = { ...f.view.app.vault };
    if (change === "vault-root") f.view.app.vault.root = "/other-synthetic-vault";
    if (change === "edge-identity") f.model.edges[0] = { ...f.edge };
    if (change === "preview-removed") f.preview.remove();
    if (change === "cancel-replaced") f.view.transientGestureCancel = () => {};
    const current = f.view.document, currentBytes = f.view.getText(), currentParent = f.preview.parentElement; gate.resolve(); await pending;
    await expect(closing).rejects.toThrow(/changed|preview/i);
    expect(f.view.document).toBe(current); expect(f.view.getText()).toBe(currentBytes); expect(f.modify).not.toHaveBeenCalled();
    expect(f.preview.parentElement).toBe(currentParent); expect(destructor).not.toHaveBeenCalled(); expect(childClose).not.toHaveBeenCalled();
    expect(f.view.render).not.toHaveBeenCalled();
    expect(f.view.renderOwner.hasUnacknowledgedWrites).toBe(false); expect(f.view.renderOwner.admissionAllowed).toBe(true);
  } finally { gate.resolve(); await pending.catch(() => {}); await closing.catch(() => {}); }
});
it("an unrelated close context never permits the Canvas preview exemption", async () => {
  const f = fixture(); await expect(Reflect.apply(f.view.renderOwner.close, f.view.renderOwner, [{}])).rejects.toThrow(/gesture|preview/i);
  expect(f.preview.parentElement).not.toBeNull(); expect(f.modify).not.toHaveBeenCalled();
});
it("an already pending strict retirement cannot be upgraded by ordinary onClose", async () => {
  const f = fixture(); f.lateCancel(f.event);
  const gate = deferred(); f.view.renderOwner.child({ prepareClose: async () => { await gate.promise; } });
  const closing = f.view.renderOwner.close(); const repeated = f.view.onClose(); gate.resolve(); await Promise.all([closing, repeated]);
  expect(f.modify).not.toHaveBeenCalled();
});
it.each(["pointerup", "pointercancel"])("a real late %s handler is inert while ordinary close is frozen before preparation", async name => {
  const f = fixture(), gate = deferred(); const pending = f.view.renderOwner.run(async () => { await gate.promise; });
  await Promise.resolve(); const closing = f.view.onClose(); void closing.catch(() => {});
  try {
    await tick(); expect(f.view.renderOwner.admissionAllowed).toBe(false);
    const parent = f.preview.parentElement;
    if (name === "pointerup") f.lateUp(f.event); else f.lateCancel(f.event);
    expect(f.preview.parentElement).toBe(parent); expect(f.view.containerEl.classList.contains("is-connecting")).toBe(true);
    expect(f.view.document).toBe(f.model); expect(f.model.edges[0]).toBe(f.edge); expect(f.view.getText()).toBe(f.before);
    expect(f.modify).not.toHaveBeenCalled(); expect(f.view.render).not.toHaveBeenCalled();
    gate.resolve(); await pending; await closing;
    expect(f.preview.parentElement).toBeNull(); expect(f.modify).not.toHaveBeenCalled();
  } finally { gate.resolve(); await pending.catch(() => {}); await closing.catch(() => {}); }
});

it.each(["prepare", "validate"] as const)("a sibling %s failure after preview retirement waits for started siblings before refusing destruction", async phase => {
  const f = fixture(), gate = deferred(); const destructor = vi.spyOn(f.view, "closeNative"), childClose = vi.fn(async () => {});
  let started = false, settled = false;
  f.view.renderOwner.child({ failureKey: "sibling-save", prepareClose: async () => { if (phase === "prepare") throw Error("sibling prepare"); }, validateClose: async () => { if (phase === "validate") throw Error("sibling validate"); }, close: childClose });
  f.view.renderOwner.child({ prepareClose: async () => { if (phase === "prepare") { started = true; await gate.promise; } }, validateClose: async () => { if (phase === "validate") { started = true; await gate.promise; } }, close: childClose });
  const closing = f.view.onClose(); void closing.then(() => { settled = true; }, () => { settled = true; });
  try {
    await tick(); expect(started).toBe(true); expect(settled).toBe(false); expect(f.preview.parentElement).toBeNull();
    expect(destructor).not.toHaveBeenCalled(); expect(childClose).not.toHaveBeenCalled();
    gate.resolve(); await expect(closing).rejects.toThrow(`sibling ${phase}`);
    expect(f.view.document).toBe(f.model); expect(f.model.edges[0]).toBe(f.edge); expect(f.view.getText()).toBe(f.before); expect(f.modify).not.toHaveBeenCalled();
    expect(destructor).not.toHaveBeenCalled(); expect(childClose).not.toHaveBeenCalled();
    expect(f.view.renderOwner.hasUnacknowledgedWrites).toBe(phase === "prepare");
  } finally { gate.resolve(); await closing.catch(() => {}); }
});
it("retained descendant write failure refuses ordinary close before preview cleanup", async () => {
  const f = fixture(); const child = f.view.renderOwner.child();
  await child.run(async () => { throw Error("descendant save"); }, "descendant-save").catch(() => {});
  await expect(f.view.onClose()).rejects.toThrow("descendant save");
  expect(f.preview.parentElement).not.toBeNull(); expect(child.hasUnacknowledgedWrites).toBe(true); expect(f.modify).not.toHaveBeenCalled();
});
