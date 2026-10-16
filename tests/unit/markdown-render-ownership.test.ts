import { afterEach, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "../../src/renderer/markdown/render";
import { nativeRenderOwnership, type RenderScope } from "../../src/renderer/workspaces/render-ownership";
const state = vi.hoisted(() => ({ gate: Promise.resolve(), closed: 0, ordinary: 0, implicit: 0, constructed: [] as unknown[] }));
vi.mock("../../src/renderer/views/canvas-view", () => ({ CanvasView: class {
  readonly containerEl = {}; readonly renderOwner: RenderScope;
  constructor(_app: object, parent: RenderScope) { this.renderOwner = parent.child({ writer: this, close: async () => { state.closed++; } }); state.constructed.push(this); }
  markEmbedded() {} onOpen() {} onClose() { state.ordinary++; return this.renderOwner.close(); }
  closeImplicitly() { state.implicit++; return this.renderOwner.close(); }
  setFile() { return this.renderOwner.run(async token => { await state.gate; token.check(); }); }
} }));
vi.mock("../../src/renderer/views/base-view", () => ({ BaseView: class {
  readonly containerEl = {}; readonly renderOwner: RenderScope;
  constructor(_app: object, parent: RenderScope) { this.renderOwner = parent.child({ writer: this, close: async () => { state.closed++; } }); state.constructed.push(this); }
  markEmbedded() {} onOpen() {} onClose() { return this.renderOwner.close(); } selectView() {}
  setFile() { return this.renderOwner.run(async token => { await state.gate; token.check(); }); }
  mountInline() { return this.setFile(); }
} }));
afterEach(() => { vi.unstubAllGlobals(); state.gate = Promise.resolve(); state.closed = 0; state.ordinary = 0; state.implicit = 0; state.constructed = []; });
function setup() {
  const app = { vault: { getFileByPath: (path: string) => ({ path, basename: path }), cachedRead: vi.fn(async () => "# nested") } };
  const renderer = new MarkdownRenderer(app as never); const root = nativeRenderOwnership(app).create({});
  return { app, renderer: renderer as any, root };
}
it("does not publish a transcluded note whose owner was frozen during its read", async () => {
  const { app, renderer, root } = setup(); let finish!: (text: string) => void;
  app.vault.cachedRead.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const content = { innerHTML: "original" }; renderer.parseDocument = vi.fn(async () => "new"); renderer.postProcess = vi.fn();
  const rendering = renderer.renderNoteEmbed({ path: "Child.md" }, "", "Parent.md", content, undefined, root);
  await Promise.resolve(); await Promise.resolve();
  const draining = root.freezeAndDrain(); finish("changed"); await draining; await rendering;
  expect(content.innerHTML).toBe("original"); expect(renderer.postProcess).not.toHaveBeenCalled();
});
it.each(["canvas", "base"])("registers a pending %s before initialization and closes a canceled allocation once", async kind => {
  const { renderer, root } = setup(); let finish!: () => void; state.gate = new Promise(resolve => { finish = resolve; });
  const mount = { dataset: { canvasPath: "Board.canvas", basePath: "Roster.base" }, parentElement: null, replaceWith: vi.fn() };
  const element = { querySelectorAll: (selector: string) => selector.includes(`${kind}s-embed-mount`) || selector === ".canvas-embed-mount" && kind === "canvas" ? [mount] : [] };
  const pending = root.run(token => kind === "canvas" ? renderer.mountCanvases(element, "Parent.md", root, token) : renderer.mountBases(element, "Parent.md", root, token));
  await Promise.resolve(); await Promise.resolve();
  expect(root.writers()).toHaveLength(1); const draining = root.freezeAndDrain(); finish(); await draining;
  await expect(pending).rejects.toThrow(/owner changed/); expect(mount.replaceWith).not.toHaveBeenCalled(); expect(state.closed).toBe(1);
  if (kind === "canvas") { expect(state.implicit).toBe(1); expect(state.ordinary).toBe(0); }
  await root.close(); expect(state.closed).toBe(1);
});
it("awaits old embedded writers before a replacement render publishes its HTML", async () => {
  const { renderer, root } = setup(); const content = { innerHTML: "original" }; let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }); let renders = 0;
  renderer.parseDocument = async (source: string) => source;
  renderer.postProcess = async (_el: unknown, _path: string, _leaf: unknown, scope: RenderScope) => { if (++renders === 1) scope.child({ writer: {}, close: async () => { await gate; state.closed++; } }); };
  await renderer.render("first", content, "Parent.md", undefined, root);
  const second = renderer.render("second", content, "Parent.md", undefined, root);
  await Promise.resolve(); await Promise.resolve(); expect(content.innerHTML).toBe("first");
  finish(); await second; expect(content.innerHTML).toBe("second"); expect(state.closed).toBe(1);
  renderer.dispose(content); await root.freezeAndDrain(); await root.close(); expect(state.closed).toBe(1);
});
it("does not keep completed standalone read-only render roots strongly registered", async () => {
  const { app, renderer } = setup(); renderer.parseDocument = async () => "readonly"; renderer.postProcess = async () => {};
  const registry = nativeRenderOwnership(app); const before = registry.select(new Set()).length;
  await renderer.render("readonly", { innerHTML: "" }, "Note.md");
  expect(registry.select(new Set()).length).toBe(before);
});

it("keeps rejected disposal discoverable and prepares all containers before any child closes", async () => {
  const { renderer, root } = setup(); const a = { innerHTML: "" }; const b = { innerHTML: "" };
  let refuse = true; const close = vi.fn(async () => {});
  renderer.parseDocument = async (source: string) => source;
  renderer.postProcess = async (el: unknown, _path: string, _leaf: unknown, scope: RenderScope) => {
    scope.child({ writer: {}, close, preflightClose: () => { if (el === b && refuse) throw new Error("Finish draft"); } });
  };
  await renderer.render("first", a, "Parent.md", undefined, root);
  await renderer.render("second", b, "Parent.md", undefined, root);
  await expect(renderer.prepareDisposal([a, b])).rejects.toThrow("Finish draft");
  expect(close).not.toHaveBeenCalled(); expect(root.writers()).toHaveLength(2);
  renderer.dispose(b); await renderer.renderScopes.get(b).close().catch(() => {});
  expect(renderer.renderScopes.has(b)).toBe(true);
  refuse = false; const retirement = await renderer.prepareDisposal([a, b]);
  expect(close).not.toHaveBeenCalled(); await retirement.commit();
  expect(close).toHaveBeenCalledTimes(2); expect(renderer.renderScopes.has(a)).toBe(false); expect(renderer.renderScopes.has(b)).toBe(false);
});

it("renderer legacy Canvas disposal uses strict cleanup without ordinary close intent", () => {
  const { renderer } = setup(), content = {};
  const ordinary = vi.fn(), strict = vi.fn(); renderer.mountedCanvases.set(content, [{ onClose: ordinary, closeImplicitly: strict }]);
  renderer.disposeCanvases(content); expect(strict).toHaveBeenCalledOnce(); expect(ordinary).not.toHaveBeenCalled();
});
