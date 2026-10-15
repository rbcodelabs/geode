import { afterEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";

afterEach(() => vi.unstubAllGlobals());
function element(): any { return { dataset: {}, style: { removeProperty() {} }, classList: { add() {}, toggle() {} }, namespaceURI: "svg", setAttribute() {}, appendChild() {}, remove() {}, contains: () => true }; }

it("retains a whole node wrapper and pending Markdown root through a geometry redraw", () => {
  vi.stubGlobal("document", { createElementNS: element });
  const view = Object.create(CanvasView.prototype) as any;
  const node = { id: "a", type: "text", text: "![[Tasks.base]]", x: 0, y: 0, width: 300, height: 300 };
  const wrapper = element(); const appendChild = vi.fn(); const dispose = vi.fn();
  Object.assign(view, { recoveryError: null, renderVersion: 0, document: { nodes: [node], edges: [] }, viewportEl: { innerHTML: "", appendChild, contains: () => true }, renderNode: vi.fn(() => wrapper), disposeMarkdownContents: dispose, revokeObjectUrls: vi.fn(), updateSelectionControls: vi.fn(), nodePresentations: new Map(), presentationUrls: new Map(), selectedIds: new Set() });
  view.render(); const firstVersion = view.renderVersion;
  node.x = 20; node.width = 350; view.render();
  expect(view.renderNode).toHaveBeenCalledOnce();
  expect(appendChild.mock.calls.filter(([child]) => child === wrapper)).toHaveLength(1);
  expect(dispose).not.toHaveBeenCalled();
  expect(view.isLiveNodeRender(firstVersion, wrapper)).toBe(true);
});

it("retains a sibling's pending generation and media URL when another card is added", () => {
  vi.stubGlobal("document", { createElementNS: element });
  const view = Object.create(CanvasView.prototype) as any;
  const node = { id: "a", type: "file", file: "Picture.png", x: 0, y: 0, width: 300, height: 300 };
  const wrapper = element(); wrapper.contains = (el: unknown) => el === wrapper;
  const other = element(); other.contains = (el: unknown) => el === other;
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  Object.assign(view, { recoveryError: null, renderVersion: 0, document: { nodes: [node], edges: [] }, viewportEl: { appendChild: vi.fn(), contains: () => true }, renderNode: vi.fn((candidate: any) => candidate === node ? wrapper : other), updateSelectionControls: vi.fn(), nodePresentations: new Map(), presentationUrls: new Map(), objectUrls: new Set(), markdownContentEls: new Set(), selectedIds: new Set() });
  view.render(); const version = view.renderVersion;
  view.retainPresentationUrl(wrapper, "blob:retained");
  view.document.nodes.push({ ...node, id: "b" }); view.render();
  expect(view.isLiveNodeRender(version, wrapper)).toBe(true);
  expect(view.presentationUrls.get(wrapper)).toEqual(new Set(["blob:retained"]));
  expect(revoke).not.toHaveBeenCalled();
  view.document.nodes.shift(); view.render();
  expect(view.isLiveNodeRender(version, wrapper)).toBe(false);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:retained");
  revoke.mockRestore();
});
