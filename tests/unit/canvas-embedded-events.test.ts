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
