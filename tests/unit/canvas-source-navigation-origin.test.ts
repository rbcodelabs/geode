import { afterEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { SourceOwnedNavigation } from "../../src/renderer/markdown/source-owned-navigation";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";

afterEach(() => vi.unstubAllGlobals());
function element(): any { return { dataset: {}, style: {}, handlers: {} as Record<string, (event: any) => void>, classList: { toggle() {}, contains: () => false }, appendChild() {}, setAttribute() {}, contains(other: unknown) { return other === this; }, addEventListener(name: string, handler: (event: any) => void) { this.handlers[name] = handler; } }; }
for (const change of ["retarget", "remove", "geometry"] as const) it(`a queued Canvas file-node request ${change === "geometry" ? "survives" : "rejects"} ${change}`, async () => {
  vi.stubGlobal("document", { createElement: element, body: element() });
  const view = Object.create(CanvasView.prototype) as any, container = element(), effects: string[] = [];
  const node = { id: "a", type: "file", file: "Host.md", x: 0, y: 0, width: 300, height: 300 };
  const target = { path: "Host.md" } as any;
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const navigation = new SourceOwnedNavigation({ capture: () => () => {}, preflight: () => {}, notify: () => {}, execute: async (request, validate) => { await gate; validate(); if (request.kind === "file") effects.push(request.file.path); } });
  const prepare = vi.spyOn(navigation, "prepareNavigation");
  Object.assign(view, { file: { path: "Board.canvas" }, recoveryError: null, containerEl: container, selectedIds: new Set(), document: { nodes: [node] }, renderFileNode() {}, renderOwner: new RenderOwnership().create({}), sourceNavigation: navigation,
    app: { vault: { getFileByPath: () => target } } });
  const wrapper = view.renderNode(node, 1);
  view.nodePresentations = new Map([[node.id, { node, el: wrapper, signature: view.presentationSignature(node), version: 1 }]]);
  view.viewportEl = { contains: (el: unknown) => el === wrapper && view.nodePresentations.has(node.id) };
  wrapper.handlers.dblclick({ target: { closest: () => container } });
  const intent = prepare.mock.results[0].value;
  if (change === "retarget") node.file = "Changed.md";
  else if (change === "remove") { view.document.nodes = []; view.nodePresentations.delete(node.id); }
  else { node.x += 40; node.height += 20; view.renderVersion = 99; }
  release();
  expect(await intent.completion).toEqual({ status: change === "geometry" ? "completed" : "refused" });
  expect(effects).toEqual(change === "geometry" ? ["Host.md"] : []);
});
