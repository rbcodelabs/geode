import { BasesCardsView } from "../../src/renderer/views/bases/cards-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindSourceLinkNavigation, SourceOwnedNavigation } from "../../src/renderer/markdown/source-owned-navigation";

// Event-order contract model; actual pointer/default-focus behavior remains Electron acceptance.
class Target {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(name: string, listener: (event: any) => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener); }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: any) { for (const listener of [...this.listeners.get(name) ?? []]) { listener(event); if (event.stopped) break; } }
  count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
class Document extends Target {
  defaultView = new Target(); hit: Node | null = null;
  elementFromPoint() { return this.hit; }
  createElement() { return new Node(this); }
}
class Node extends Target {
  dataset: Record<string, string> = {}; isConnected = true; parent: Node | null = null; children: Node[] = []; textContent = "";
  setAttribute() {}
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node: Node) { this.append(node); return node; }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  constructor(public ownerDocument: Document) { super(); }
  contains(node: Node): boolean { for (let current: Node | null = node; current; current = current.parent) if (current === this) return true; return false; }
  closest() { return this.dataset.href ? this : this.parent?.closest() ?? null; }
}
class Pointer {
  isTrusted = true; button = 0; pointerId = 1; detail = 1; metaKey = false; ctrlKey = false; shiftKey = false; altKey = false;
  clientX = 10; clientY = 10; stopped = false; defaultPrevented = false;
  constructor(public target: Node) {}
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}
function fixture(dirty = false) {
  const document = new Document(), root = new Node(document), anchor = new Node(document); anchor.parent = root; anchor.dataset.href = "Other";
  const effects: string[] = [];
  const navigation = new SourceOwnedNavigation({ capture: () => () => {}, preflight: () => { if (dirty) throw new Error("Dirty"); }, execute: async () => { effects.push("open"); }, notify: () => {} });
  const prepare = vi.spyOn(navigation, "prepareNavigation");
  const cleanup = bindSourceLinkNavigation(root as any, navigation, "Host.md");
  const down = () => root.emit("pointerdown", new Pointer(anchor));
  const click = () => root.emit("click", new Pointer(anchor));
  return { document, root, anchor, navigation, effects, prepare, cleanup, down, click };
}
beforeEach(() => { vi.stubGlobal("Element", Node); vi.stubGlobal("PointerEvent", Pointer); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("private native navigation gesture ownership", () => {
  it("keeps a matching pointerup staged until one real click dispatch", async () => {
    const state = fixture(); state.down(); const intent = state.prepare.mock.results[0].value;
    state.document.hit = state.anchor; state.document.emit("pointerup", new Pointer(state.anchor));
    expect(state.effects).toEqual([]); state.click();
    expect(await intent.completion).toEqual({ status: "completed" }); expect(state.effects).toEqual(["open"]);
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.document.count()).toBe(0); state.cleanup();
  });
  it("consumes the matching click of a synchronous refusal without preparing again", async () => {
    const state = fixture(true); state.down(); state.click();
    expect(await state.prepare.mock.results[0].value.completion).toEqual({ status: "refused" });
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.effects).toEqual([]); state.cleanup();
  });
  it("cancels pointerup outside the actual control and ignores a late click", async () => {
    const state = fixture(); state.down(); const intent = state.prepare.mock.results[0].value;
    state.document.hit = new Node(state.document); state.document.emit("pointerup", new Pointer(state.anchor)); state.click();
    expect(await intent.completion).toEqual({ status: "cancelled" }); expect(state.effects).toEqual([]);
    expect(state.document.count()).toBe(0); expect(state.document.defaultView.count()).toBe(0); state.cleanup();
  });
  for (const reason of ["blur", "dragstart", "dispose"] as const) it(`cancels abandoned ${reason} gestures and releases window listeners`, async () => {
    const state = fixture(); state.down(); const intent = state.prepare.mock.results[0].value;
    if (reason === "blur") state.document.defaultView.emit("blur", {});
    else if (reason === "dragstart") state.document.emit("dragstart", {});
    else state.cleanup();
    expect(await intent.completion).toEqual({ status: "cancelled" }); expect(state.effects).toEqual([]);
    expect(state.document.count()).toBe(0); expect(state.document.defaultView.count()).toBe(0); state.cleanup();
  });
  it("rejects a changed link target instead of dispatching its stale pointer intent", async () => {
    const state = fixture(); state.down(); const intent = state.prepare.mock.results[0].value;
    state.anchor.dataset.href = "Changed"; state.click();
    expect(await intent.completion).toEqual({ status: "cancelled" }); expect(state.effects).toEqual([]); state.cleanup();
  });
  for (const change of ["removed", "retargeted"] as const) it(`refuses a ${change} control after dispatch while its source queue waits`, async () => {
    const document = new Document(), root = new Node(document), anchor = new Node(document);
    anchor.parent = root; anchor.dataset.href = "Other";
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; }), effects: string[] = [];
    const navigation = new SourceOwnedNavigation({ capture: () => () => {}, preflight: () => {},
      execute: async (_request, validate) => { await gate; validate(); effects.push("open"); }, notify: () => {} });
    const prepare = vi.spyOn(navigation, "prepareNavigation"), cleanup = bindSourceLinkNavigation(root as any, navigation, "Host.md");
    root.emit("pointerdown", new Pointer(anchor)); root.emit("click", new Pointer(anchor));
    if (change === "removed") anchor.remove(); else anchor.dataset.href = "Changed";
    release();
    expect(await prepare.mock.results[0].value.completion).toEqual({ status: "refused" });
    expect(effects).toEqual([]); cleanup();
  });
  it("gives a keyboard click a fresh intent without reusing a pointer gesture", async () => {
    const state = fixture(); state.down(); const previous = state.prepare.mock.results[0].value;
    const keyboard = new Pointer(state.anchor); keyboard.detail = 0; state.root.emit("click", keyboard);
    expect(await previous.completion).toEqual({ status: "cancelled" });
    expect(await state.prepare.mock.results[1].value.completion).toEqual({ status: "completed" });
    expect(state.effects).toEqual(["open"]); state.cleanup();
  });
  it("prevents a nested Reading listener from preparing a second intent", async () => {
    const state = fixture(), outer = new Node(state.document); state.root.parent = outer;
    const cleanupOuter = bindSourceLinkNavigation(outer as any, state.navigation, "Outer.md");
    for (const name of ["pointerdown", "click"]) { const event = new Pointer(state.anchor); state.root.emit(name, event); if (!event.stopped) outer.emit(name, event); }
    expect(await state.prepare.mock.results[0].value.completion).toEqual({ status: "completed" });
    expect(state.prepare).toHaveBeenCalledOnce(); expect(state.effects).toEqual(["open"]); state.cleanup(); cleanupOuter();
  });
});


describe("actual Base mobile card action registration", () => {
  for (const label of ["Open", "Edit note"]) for (const keyboard of [false, true]) for (const dirty of [false, true]) {
    it(`${label} ${keyboard ? "keyboard" : "pointer"} prepares exactly one ${dirty ? "refused" : "completed"} intent`, async () => {
      const state = fixture(dirty); vi.stubGlobal("document", state.document);
      const selectedFile = { path: "Other.md" } as any;
      const view = Object.create(BasesCardsView.prototype) as any;
      Object.assign(view, { selectedFile, containerEl: new Node(state.document), navigation: state.navigation, mobileNavigationCleanups: [],
        callbacks: { onOpenFile: () => { void state.navigation.prepareNavigation({ kind: "file", file: selectedFile, newTab: false }).dispatch(); } } });
      view.renderMobileActions();
      const button = view.mobileActionsEl.children.find((node: Node) => node.textContent === label) as Node;
      expect(button).toBeDefined();
      if (!keyboard) button.emit("pointerdown", new Pointer(button));
      const click = new Pointer(button); if (keyboard) click.detail = 0; button.emit("click", click);
      expect(state.prepare).toHaveBeenCalledOnce();
      expect(await state.prepare.mock.results[0].value.completion).toEqual({ status: dirty ? "refused" : "completed" });
      expect(state.effects).toHaveLength(dirty ? 0 : 1);
      view.mobileNavigationCleanups.splice(0).forEach((cleanup: () => void) => cleanup()); state.cleanup();
    });
  }
  it("keeps the original callback when no owned navigation context is supplied", () => {
    const document = new Document(); vi.stubGlobal("document", document);
    const open = vi.fn(), view = Object.create(BasesCardsView.prototype) as any;
    Object.assign(view, { selectedFile: { path: "Other.md" }, containerEl: new Node(document), mobileNavigationCleanups: [], callbacks: { onOpenFile: open } });
    view.renderMobileActions(); const button = view.mobileActionsEl.children[0]; button.emit("click", new Pointer(button));
    expect(open).toHaveBeenCalledOnce();
  });
});
