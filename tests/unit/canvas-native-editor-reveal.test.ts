import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasView } from "../../src/renderer/views/canvas-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top });
class Element {
  isConnected = true; parentElement: Element | null = null; children: Element[] = []; dataset: Record<string, string> = {};
  handlers: { name: string; callback: (event: any) => void; capture: boolean }[] = [];
  style = { overflowX: "visible", overflowY: "visible", display: "block", visibility: "visible" };
  constructor(public className: string, public rect = box(0, 0, 600, 600)) {}
  append(child: Element) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(value => value !== child); child.parentElement = this; this.children.push(child); return child; }
  contains(other: Element | null): boolean { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
  matches(selector: string): boolean { return selector.split(",").some(part => part.trim().split(".").filter(Boolean).every(name => this.className.split(" ").includes(name))); }
  closest(selector: string): Element | null { for (let node: Element | null = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return this.rect; }
  addEventListener(name: string, callback: (event: any) => void, options?: boolean | { capture?: boolean }) { this.handlers.push({ name, callback, capture: options === true || !!(options && typeof options === "object" && options.capture) }); }
  capture(event: any) { for (const handler of this.handlers) if (handler.name === event.type && handler.capture) handler.callback(event); }
  bubble(event: any) { for (const handler of this.handlers) if (handler.name === event.type && !handler.capture) handler.callback(event); }
}
let active: Element | null;
beforeEach(() => { active = null; vi.stubGlobal("HTMLElement", Element); vi.stubGlobal("Element", Element); vi.stubGlobal("document", { get activeElement() { return active; } }); vi.stubGlobal("innerWidth", 1280); vi.stubGlobal("innerHeight", 800); vi.stubGlobal("getComputedStyle", (el: Element) => el.style); });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const surface = new Element("canvas-surface", box(0, 0, 600, 360)), viewport = surface.append(new Element("canvas-viewport"));
  const nodeElement = viewport.append(new Element("canvas-node")); nodeElement.dataset.nodeId = "owned";
  const base = nodeElement.append(new Element("base-view")), table = base.append(new Element("bases-table-container")), cell = table.append(new Element("bases-cell is-active"));
  const toolbar = surface.append(new Element("canvas-toolbar", box(100, 300, 200, 40)));
  const node = { id: "owned", type: "file", file: "Host.md", x: 0, y: 0, width: 600, height: 600 };
  const owner = new RenderOwnership().create({}), writer: any = { viewType: "base", containerEl: base }; writer.renderOwner = owner.child({ writer });
  const view = Object.assign(Object.create(CanvasView.prototype), { surfaceEl: surface, viewportEl: viewport, renderOwner: owner, file: { path: "Board.canvas" }, app: { vault: { root: "/synthetic" } }, document: { nodes: [node] }, pan: { x: 31, y: 80 }, scale: 1, pendingEditorReveals: new WeakMap(), editorRevealEvents: new WeakMap(), handleKeyDown: vi.fn(), updateTransform: vi.fn(), recoveryError: null }) as any;
  view.nodePresentations = new Map([[node.id, { node, el: nodeElement, version: 1, signature: view.presentationSignature(node) }]]);
  view.installCameraControls();
  const event = (kind = "keydown", target = table) => ({ type: kind, target, key: "Enter", isTrusted: true, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  const mount = (at = cell, rect = box(120, 290, 100, 30)) => { const input = at.append(new Element("bases-cell-input", rect)); active = input; return input; };
  return { view, surface, viewport, nodeElement, node, base, writer, table, cell, toolbar, event, mount };
}
const flush = async () => { await Promise.resolve(); };
for (const kind of ["keydown", "dblclick"]) it(`reveals only the new same-cell editor created by trusted ${kind}`, async () => {
  const f = fixture(), event = f.event(kind, kind === "dblclick" ? f.cell : f.table); f.surface.capture(event); const input = f.mount(); f.surface.bubble(event); await flush();
  expect(f.view.pan).toEqual({ x: 31, y: 52 }); expect(f.view.updateTransform).toHaveBeenCalledOnce(); expect(active).toBe(input); expect(input.isConnected).toBe(true);
});
it("coalesces two queued initiations for the same new editor", async () => {
  const f = fixture(), event = f.event(); f.surface.capture(event); f.surface.capture(event); f.mount(); f.surface.bubble(event); f.surface.bubble(event); await flush(); expect(f.view.updateTransform).toHaveBeenCalledOnce();
});
it("reveals only the latest exact-cell editor when two events queue", async () => {
  const f = fixture(), other = f.table.append(new Element("bases-cell")), first = f.event("dblclick", f.cell), second = f.event("dblclick", other);
  f.surface.capture(first); const old = f.mount(); f.surface.bubble(first); old.isConnected = false; f.cell.children = [];
  f.surface.capture(second); f.mount(other, box(120, 285, 100, 30)); f.surface.bubble(second); await flush();
  expect(f.view.pan).toEqual({ x: 31, y: 57 }); expect(f.view.updateTransform).toHaveBeenCalledOnce();
});
for (const change of ["node", "input", "file", "vault root", "scope", "base scope", "camera", "table"] as const) it(`ignores a stale ${change} before the deferred reveal`, async () => {
  const f = fixture(), event = f.event(); f.surface.capture(event); const input = f.mount(); f.surface.bubble(event);
  if (change === "node") f.view.document.nodes = [{ ...f.node }];
  if (change === "input") { input.isConnected = false; f.cell.children = []; f.mount(); }
  if (change === "file") f.view.file = { path: "Other.canvas" };
  if (change === "vault root") f.view.app.vault.root = "/other";
  if (change === "scope") f.view.renderOwner.freezeAdmission();
  if (change === "base scope") f.writer.renderOwner.freezeAdmission();
  if (change === "camera") f.view.pan.y += 10;
  if (change === "table") f.table.isConnected = false;
  await flush(); expect(f.view.updateTransform).not.toHaveBeenCalled();
});
it("cancels a queued new-editor reveal when existing Enter commits then refusal refocuses", async () => {
  const f = fixture(), opening = f.event(); f.surface.capture(opening); const input = f.mount(); f.surface.bubble(opening);
  const committing = f.event("keydown", input); f.surface.capture(committing); active = f.table; f.surface.bubble(committing); active = input;
  await flush(); expect(f.view.updateTransform).not.toHaveBeenCalled(); expect(active).toBe(input);
});
for (const kind of ["existing editor", "passive focus", "mousedown", "untrusted", "unrelated", "outer Canvas"]) it(`does not pan for ${kind}`, async () => {
  const f = fixture(); let event = f.event();
  if (kind === "existing editor") { const input = f.mount(); event = f.event("keydown", input); }
  if (kind === "passive focus") event.type = "focusin";
  if (kind === "mousedown") event.type = "mousedown";
  if (kind === "untrusted") event.isTrusted = false;
  if (kind === "unrelated") event.target = f.toolbar;
  if (kind === "outer Canvas") { const nested = new Element("canvas-surface"); f.nodeElement.append(nested); nested.append(f.base); }
  f.surface.capture(event); if (kind !== "existing editor") f.mount(); f.surface.bubble(event); await flush(); expect(f.view.updateTransform).not.toHaveBeenCalled();
});
for (const kind of ["no occlusion", "horizontal clipping", "moving ancestor clipping", "too small", "no valid placement", "nonfinite"] as const) it(`does not speculate when geometry has ${kind}`, async () => {
  const f = fixture();
  if (kind === "horizontal clipping") { f.base.style.overflowX = "hidden"; f.base.rect = box(130, 0, 50, 600); }
  if (kind === "moving ancestor clipping") { f.base.style.overflowY = "hidden"; f.base.rect = box(0, 0, 600, 310); }
  if (kind === "too small") f.surface.rect = box(0, 290, 600, 20);
  if (kind === "no valid placement") f.toolbar.rect = box(100, 0, 200, 360);
  const event = f.event(); f.surface.capture(event); f.mount(f.cell, kind === "no occlusion" ? box(120, 200, 100, 30) : kind === "nonfinite" ? box(120, NaN, 100, 30) : undefined); f.surface.bubble(event); await flush(); expect(f.view.updateTransform).not.toHaveBeenCalled();
});
it("uses screen-space displacement at non-unit zoom and respects ancestor clipping", async () => {
  const f = fixture(); f.view.scale = 2; f.base.style.overflowY = "auto"; f.base.rect = box(0, 250, 600, 110);
  const event = f.event(); f.surface.capture(event); f.mount(); f.surface.bubble(event); await flush(); expect(f.view.pan).toEqual({ x: 31, y: 52 }); expect(f.view.updateTransform).toHaveBeenCalledOnce();
});

it("moves a tight inner clip with its input instead of treating it as stationary", async () => {
  const f = fixture(); f.base.style.overflowY = "hidden"; f.base.rect = box(0, 280, 600, 50);
  const event = f.event(); f.surface.capture(event); const input = f.mount(); f.surface.bubble(event);
  f.view.updateTransform.mockImplementation(() => { const dy = f.view.pan.y - 80; f.base.rect = box(0, 280 + dy, 600, 50); input.rect = box(120, 290 + dy, 100, 30); });
  await flush(); expect(f.view.pan.y).toBe(52); expect(input.rect.top - f.base.rect.top).toBe(10); expect(f.base.rect.bottom - input.rect.bottom).toBe(10);
});
it("honors a stationary outer clip while moving only the inner viewport", async () => {
  const f = fixture(), outer = new Element("outer", box(0, 250, 600, 110)); outer.style.overflowY = "hidden"; outer.append(f.surface);
  const event = f.event(); f.surface.capture(event); const input = f.mount(); f.surface.bubble(event);
  f.view.updateTransform.mockImplementation(() => { input.rect = box(120, 290 + f.view.pan.y - 80, 100, 30); });
  await flush(); expect(f.view.pan.y).toBe(52); expect(input.rect.top).toBeGreaterThanOrEqual(outer.rect.top + 8); expect(outer.rect.top).toBe(250);
});
for (const [name, rect] of [["two pixels inside the surface", box(120, 2, 100, 30)], ["seven pixels clear of the toolbar", box(120, 263, 100, 30)]] as const) it(`leaves a fully exposed input ${name} stationary`, async () => {
  const f = fixture(), event = f.event(); f.surface.capture(event); f.mount(f.cell, rect); f.surface.bubble(event);
  await flush(); expect(f.view.pan).toEqual({ x: 31, y: 80 }); expect(f.view.updateTransform).not.toHaveBeenCalled();
});
