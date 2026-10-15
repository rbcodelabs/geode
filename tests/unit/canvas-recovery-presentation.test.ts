import { afterEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";
class Element {
  className = ""; children: Element[] = []; parent: Element | null = null; dataset = {}; style = { removeProperty() {}, setProperty() {} }; namespaceURI = "svg";
  classList = { add: (name: string) => { this.className += ` ${name}`; }, remove: (name: string) => { this.className = this.className.split(" ").filter(value => value !== name).join(" "); }, toggle() {} };
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: Element) { child.parent = this; this.children.push(child); return child; }
  replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute() {} addEventListener() {}
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
afterEach(() => vi.unstubAllGlobals());
const recovered = JSON.stringify({ vendor: "preserved", nodes: [{ id: "new", type: "text", text: "Recovered", x: 0, y: 0, width: 100, height: 80 }], edges: [] });
function fixture() {
  vi.stubGlobal("document", { createElement: () => new Element(), createElementNS: () => new Element() });
  const view = Object.assign(Object.create(CanvasView.prototype), { containerEl: new Element(), viewportEl: new Element(), file: { path: "Board.canvas" }, document: { nodes: [], edges: [] }, recoveryError: null, selectedIds: new Set(), selectedEdgeIds: new Set(), nodePresentations: new Map(), markdownContentEls: new Set(), presentationUrls: new Map(), renderVersion: 0, pan: { x: 20, y: 30 }, scale: 2, undoStack: ["before"], redoStack: [], geometryGestures: new Set(), touchGesture: { pointerIds: () => [] }, disposeMarkdownContents: vi.fn(), revokeObjectUrls: vi.fn(), updateSelectionControls: vi.fn(), renderNode: vi.fn(() => new Element()), persist: vi.fn(), app: { notify: vi.fn(), markdownRenderer: { preflightDisposal() {}, prepareDisposal: async () => ({ destructionStarted: false, commit: async () => {}, abort() {} }) } } }) as any;
  return { view, errors: () => view.viewportEl.all().filter((node: Element) => node.className === "canvas-error") };
}
it("removes the old recovery alert only after valid Canvas text is accepted", () => {
  const { view, errors } = fixture();
  view.applyLoadedText('{"nodes":[', false); const alert = errors()[0]; expect(alert.parent).toBe(view.viewportEl);
  const camera = { ...view.pan, scale: view.scale };
  view.applyLoadedText(recovered, false);
  expect(view.recoveryError).toBeNull(); expect(errors()).toHaveLength(0); expect(alert.parent).toBeNull();
  expect(view.document).toMatchObject({ vendor: "preserved", nodes: [{ id: "new" }] }); expect(view.nodePresentations.has("new")).toBe(true);
  expect(view.lastKnownText).toBe(recovered); expect(view.undoStack).toEqual(["before"]); expect({ ...view.pan, scale: view.scale }).toEqual(camera); expect(view.persist).not.toHaveBeenCalled();
});
it("keeps one current alert across invalid retries without publishing recovered nodes", () => {
  const { view, errors } = fixture(); view.applyLoadedText('{"nodes":[', false);
  view.applyLoadedText('{"nodes":"invalid","edges":[]}', false);
  expect(errors()).toHaveLength(1); expect(view.recoveryError).toBeTruthy(); expect(view.nodePresentations.size).toBe(0); expect(view.persist).not.toHaveBeenCalled();
});
it("does not clear the existing recovery alert if owned replacement preparation refuses", async () => {
  const { view, errors } = fixture(); view.applyLoadedText('{"nodes":[', false); const alert = errors()[0]; const malformed = view.lastKnownText;
  view.app.markdownRenderer.preflightDisposal = () => { throw Error("Finish child draft"); };
  expect(await view.load(recovered)).toBe(false);
  expect(errors()).toEqual([alert]); expect(alert.parent).toBe(view.viewportEl); expect(view.lastKnownText).toBe(malformed); expect(view.recoveryError).toBeTruthy(); expect(view.persist).not.toHaveBeenCalled();
});
