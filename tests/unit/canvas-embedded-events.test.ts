import { afterEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";

afterEach(() => vi.unstubAllGlobals());
function element(): any {
  return { dataset: {}, style: {}, handlers: {} as Record<string, (event: any) => void>, classList: { toggle() {}, contains: () => false }, appendChild() {}, setAttribute() {}, addEventListener(name: string, handler: (event: any) => void) { this.handlers[name] = handler; } };
}

it("lets embedded native controls handle double clicks while keeping ordinary Canvas text editing", () => {
  vi.stubGlobal("document", { createElement: element, body: element() });
  const view = Object.create(CanvasView.prototype) as any; const container = element(); const base = element();
  const node = { id: "a", type: "text", text: "![[Tasks.base]]", x: 0, y: 0, width: 300, height: 300 };
  Object.assign(view, { containerEl: container, selectedIds: new Set(), document: { nodes: [node] }, markdownContentEls: new Set(), editTextNode: vi.fn(), app: { markdownRenderer: { render: async () => {} } } });
  const wrapper = view.renderNode(node, 1); const stopPropagation = vi.fn();
  wrapper.handlers.dblclick({ target: { closest: (selector: string) => selector.includes(".base-view") ? base : container }, stopPropagation });
  expect(view.editTextNode).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled();
  wrapper.handlers.dblclick({ target: { closest: () => container }, stopPropagation });
  expect(view.editTextNode).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
});
it("does not move Canvas focus or start a node drag from an embedded native control", () => {
  const view = Object.create(CanvasView.prototype) as any; const container = element(); const base = element(); const focus = vi.fn();
  Object.assign(view, { recoveryError: null, containerEl: container, surfaceEl: { focus } });
  const stopPropagation = vi.fn();
  view.beginNodeDrag({ button: 0, pointerType: "mouse", target: { closest: (selector: string) => selector.includes(".base-view") ? base : null }, stopPropagation }, { id: "a", type: "text" });
  expect(focus).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled();
});

it("lets an embedded Base keep file-card double clicks and context menus", () => {
  vi.stubGlobal("document", { createElement: element, body: element() });
  const view = Object.create(CanvasView.prototype) as any; const container = element(); const base = element(); const openFile = vi.fn(); const showMenu = vi.fn();
  const node = { id: "a", type: "file", file: "Host.md", x: 0, y: 0, width: 300, height: 300 };
  Object.assign(view, { recoveryError: null, containerEl: container, selectedIds: new Set(), document: { nodes: [node] }, renderFileNode() {}, sourceNavigation: { prepareNavigation: () => ({ dispatch: () => openFile() }) }, app: { openFile, showMenu, vault: { getFileByPath: () => ({ path: "Host.md" }) } } });
  const wrapper = view.renderNode(node, 1); const stopPropagation = vi.fn(); const preventDefault = vi.fn();
  const event = { target: { closest: () => base }, stopPropagation, preventDefault };
  wrapper.handlers.dblclick(event); wrapper.handlers.contextmenu(event);
  expect(openFile).not.toHaveBeenCalled(); expect(showMenu).not.toHaveBeenCalled(); expect(view.selectedIds.size).toBe(0);
  expect(stopPropagation).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
  wrapper.handlers.dblclick({ target: { closest: () => container } }); expect(openFile).toHaveBeenCalledOnce();
});

it("does not admit a new touch gesture while native card retirement is preparing", () => {
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} }); vi.stubGlobal("window", {});
  const view = Object.create(CanvasView.prototype) as any; const surface = element(); const container = element(); const down = vi.fn();
  Object.assign(view, { recoveryError: null, presentationChangeInProgress: true, containerEl: container, surfaceEl: surface, touchGesture: { down }, capturedTouchPointers: new Set(), touchCleanups: [] });
  view.installTouchControls();
  surface.handlers.pointerdown({ pointerType: "touch", pointerId: 1, clientX: 0, clientY: 0, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
  expect(down).not.toHaveBeenCalled(); expect(view.capturedTouchPointers.size).toBe(0);
});
