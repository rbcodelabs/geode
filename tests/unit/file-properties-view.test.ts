import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import { Compartment, EditorState } from "@codemirror/state";
import { PropertyTypes } from "../../src/renderer/properties/property-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
import { FilePropertiesView } from "../../src/renderer/views/file-properties-view";

class Element {
  style: Record<string, string> = {}; inert = false;
  set innerHTML(_: string) { this.children = []; }
  className = ""; textContent = ""; isConnected = true; disabled = false; hiddenHost = false;
  value = ""; checked = false; type = "text"; inputMode = ""; placeholder = "";
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  children: Element[] = []; events = new Map<string, (event: any) => void>();
  selectionStart: number | null = 0; selectionEnd: number | null = 0;
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  constructor(readonly tag = "div") {}
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; this.textContent = ""; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  contains(element: Element) { return this.all().includes(element); }
  closest() { return this.hiddenHost ? {} : null; }
  addEventListener(name: string, callback: (event: any) => void) { this.events.set(name, callback); }
  all(): Element[] { return [this, ...this.children.flatMap(element => element.all())]; }
  querySelector(selector: string) { return this.all().find(element => element.className.split(" ").includes(selector.slice(1))) ?? null; }
  querySelectorAll(selector: string) { return this.all().filter(element => element.tag === selector); }
  remove() {} focus() { (document as any).activeElement = this; } setSelectionRange() {}
  text(): string { return this.textContent + this.children.map(element => element.text()).join(" "); }
}
afterEach(() => vi.unstubAllGlobals());
function setup(source = "---\nstatus: old\n---\nUnsaved body", propertyTypes?: PropertyTypes) {
  const body = new Element("body");
  vi.stubGlobal("document", { body, activeElement: body, createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("HTMLInputElement", Element);
  const file = { path: "Note.md", basename: "Note", extension: "md" };
  const workspace = new Events() as Events & Record<string, any>;
  let currentFile: any = file;
  let text = source;
  let readonly = false;
  workspace.getActiveFile = () => currentFile;
  const vault = new Events() as Events & Record<string, any>;
  Object.assign(vault, { root: "vault", getFileByPath: (path: string) => path === currentFile?.path ? currentFile : null, read: vi.fn(async () => text) });
  const owner = { file, mode: "live", getText: vi.fn(() => text), canApplySourceEdit: () => !readonly, applySourceEdit: vi.fn((snapshot: string, from: number, to: number, insert: string) => { if (readonly || snapshot !== text) return false; text = text.slice(0, from) + insert + text.slice(to); return true; }) };
  const metadataCache = new Events();
  let activeOwner = owner;
  const app = { propertyTypes, workspace, vault, metadataCache, getActiveMarkdownView: () => activeOwner, actions: { execute: vi.fn() }, openFile: vi.fn() };
  const view = new FilePropertiesView(app as any); view.onOpen();
  const input = (label: string) => (view.containerEl as unknown as Element).all().find(element => element.attributes["aria-label"] === label)!;
  const enter = (element: Element, value: string) => { element.value = value; element.events.get("input")?.({}); element.events.get("keydown")?.({ key: "Enter", preventDefault() {} }); };
  return { app, view, owner, setOwner: (next: typeof owner) => { activeOwner = next; }, workspace, metadataCache, vault, file, input, enter, getText: () => text, switchFile: (file: any) => { currentFile = file; }, setReadonly: () => { readonly = true; } };
}
describe("File properties buffer ownership", () => {
  it("commits through the guarded live buffer and never writes or reads disk", () => {
    const { view, owner, input, enter, vault, getText } = setup();
    enter(input("Value: status"), "new");
    expect(getText()).toContain("status: new"); expect(getText()).toContain("Unsaved body");
    expect(owner.applySourceEdit).toHaveBeenCalledOnce(); expect(vault.read).not.toHaveBeenCalled(); view.onClose();
  });
  it("preserves a dirty focused input during unrelated metadata refresh", () => {
    const { view, input, metadataCache, file } = setup();
    const field = input("Value: status"); field.focus(); field.value = "draft"; field.events.get("input")!({});
    metadataCache.trigger("changed", file);
    expect(input("Value: status")).toBe(field); expect(field.value).toBe("draft"); view.onClose();
  });
  it("rebinds controls when another split owns the same file", () => {
    const { view, owner, setOwner, workspace, input, enter } = setup();
    const replacement = { ...owner, getText: vi.fn(() => "---\nstatus: split\n---\nSecond buffer"), applySourceEdit: vi.fn(() => true) };
    setOwner(replacement); workspace.trigger("active-leaf-change");
    expect(input("Value: status").value).toBe("split");
    enter(input("Value: status"), "updated");
    expect(replacement.applySourceEdit).toHaveBeenCalledOnce(); expect(owner.applySourceEdit).not.toHaveBeenCalled(); view.onClose();
  });
  it("cannot apply a detached split input to another owner with identical properties", () => {
    const { view, owner, setOwner, workspace, input, enter } = setup();
    const oldField = input("Value: status");
    const replacement = { ...owner, applySourceEdit: vi.fn(() => true) };
    setOwner(replacement); workspace.trigger("active-leaf-change");
    enter(oldField, "wrong split");
    expect(replacement.applySourceEdit).not.toHaveBeenCalled(); expect(owner.applySourceEdit).not.toHaveBeenCalled(); view.onClose();
  });
  it("does no buffer work while hidden and refreshes on reveal", () => {
    const { view, owner, metadataCache, file } = setup();
    (view.containerEl as unknown as Element).hiddenHost = true; owner.getText.mockClear();
    metadataCache.trigger("changed", file); expect(owner.getText).not.toHaveBeenCalled();
    (view.containerEl as unknown as Element).hiddenHost = false; view.onReveal(); expect(owner.getText).toHaveBeenCalled(); view.onClose();
  });
  it("rejects a stale field after the centre note changes", () => {
    const { view, owner, workspace, switchFile, input, enter } = setup();
    const old = input("Value: status"); switchFile({ path: "Other.md", basename: "Other", extension: "md" }); workspace.trigger("active-leaf-change");
    enter(old, "lost"); expect(owner.applySourceEdit).not.toHaveBeenCalled(); view.onClose();
  });
  it("rejects read-only changes and disposes all closed-view subscriptions", () => {
    const { view, owner, workspace, metadataCache, file, setReadonly, input, enter } = setup();
    setReadonly(); enter(input("Value: status"), "lost"); expect(owner.applySourceEdit).not.toHaveBeenCalled();
    view.onClose(); owner.getText.mockClear(); workspace.trigger("editor-change", owner); metadataCache.trigger("changed", file);
    expect(owner.getText).not.toHaveBeenCalled();
  });
});


it("uses the shared picker and preserves local datetime seconds until an explicit value edit", () => {
  const types = new PropertyTypes(); types.setType("Due", "datetime");
  const state = setup('---\nDue: "2026-10-14T22:49:31"\n---\nUnsaved body', types);
  expect(state.input("Value: Due").type).toBe("datetime-local");
  expect(state.input("Value: Due").value).toBe("2026-10-14T22:49:31");
  state.enter(state.input("Value: Due"), "2026-10-15T08:30:42");
  expect(state.getText()).toContain("2026-10-15T08:30:42"); expect(state.getText()).toContain("Unsaved body"); state.view.onClose();
});
it("changes registry interpretation without rewriting source and disables unsupported values", () => {
  const types = new PropertyTypes(), state = setup(undefined, types);
  const picker = state.input("Type: status"); expect(picker).toBeDefined();
  picker.value = "date"; picker.events.get("change")!({});
  expect(types.getType("STATUS", "old")).toBe("date"); expect(state.owner.applySourceEdit).not.toHaveBeenCalled();
  expect((state.view.containerEl as unknown as Element).text()).toContain("cannot be edited as date"); state.view.onClose();
});
it("rejects stale and read-only type changes and disposes registry subscriptions", () => {
  const types = new PropertyTypes(), state = setup(undefined, types);
  const old = state.input("Type: status"); expect(old).toBeDefined(); state.setReadonly();
  old.value = "date"; old.events.get("change")!({});
  expect(types.getPropertyInfo("status")).toBe(null); state.view.onClose();
});

it("keeps tags scalar text intact, reserves its picker, and displays an unset checkbox", () => {
  const types = new PropertyTypes(); types.setType("done", "checkbox");
  const state = setup('---\ntags: "one,two"\ndone: null\n---\nBody', types);
  expect(state.input("Type: tags").disabled).toBe(true);
  expect(state.input("Value: tags item 1").value).toBe("one,two");
  expect((state.input("Value: done") as any).indeterminate).toBe(true); state.view.onClose();
});
it("refuses a stale picker after active note change", () => {
  const types = new PropertyTypes(), state = setup(undefined, types), old = state.input("Type: status");
  state.switchFile({ path: "Other.md", extension: "md", basename: "Other" }); state.workspace.trigger("file-open");
  old.value = "date"; old.events.get("change")!({});
  expect(types.getPropertyInfo("status")).toBe(null); state.view.onClose();
});
it("does not commit a dirty old field after a plugin changes its type", () => {
  const types = new PropertyTypes(), state = setup(undefined, types), old = state.input("Value: status");
  old.focus(); old.value = "dirty"; old.events.get("input")!({}); types.setType("status", "number");
  state.enter(old, "123"); expect(state.owner.applySourceEdit).not.toHaveBeenCalled();
  expect((state.view.containerEl as unknown as Element).text()).toContain("does not match"); state.view.onClose();
});
it("allows an explicit unset action for a typed boolean", () => {
  const types = new PropertyTypes(); types.setType("done", "checkbox");
  const state = setup("---\ndone: true\n---\nDirty body", types);
  const clear = state.input("Unset value: done"); expect(clear).toBeDefined(); clear.events.get("click")!({});
  expect(state.getText()).toContain("done: null"); expect(state.getText()).toContain("Dirty body"); state.view.onClose();
});

function actualNativeOwner(state: ReturnType<typeof setup>, mode = "live") {
  const compartment = new Compartment();
  const editor = { state: EditorState.create({ doc: state.getText(), extensions: [compartment.of([])] }), dispatch: vi.fn((spec: any) => { editor.state = editor.state.update(spec).state; }), focus: vi.fn(() => { (document as any).activeElement = document.body; }) };
  const owner = Object.assign(Object.create(MarkdownView.prototype), { app: state.app, editor, file: state.file, mode, lastEditingMode: "live", transitionTail: Promise.resolve(), transitionGeneration: 0, transitionClosing: false, readingRenderGeneration: 0, bodyEl: new Element(), readingEl: new Element(), editorHostEl: new Element(), editingCompartment: compartment, pagePreview: { hide() {} }, flush: vi.fn(async () => {}), ownLeaf: () => null });
  Object.assign(state.app, { markdownRenderer: { render: vi.fn(async () => {}), dispose: vi.fn() }, notify: vi.fn() });
  owner.renderOwner = new RenderOwnership().create(owner);
  state.setOwner(owner); state.view.refresh(); return { owner, editor };
}
it("retains a refused sidebar draft after delayed native Reading transition and subsequent metadata refresh", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state);
  let finish!: () => void; owner.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const changing = owner.toggleMode(); await new Promise(resolve => setImmediate(resolve));
  expect(owner.bodyEl.inert).toBe(true);
  const field = state.input("Value: status"); field.focus(); state.enter(field, "reading");
  expect(owner.getText()).toContain("status: old"); expect((state.view.containerEl as unknown as Element).text()).toContain("read-only");
  finish(); await changing; owner.flush = vi.fn(async () => {});
  (document as any).activeElement = document.body; state.metadataCache.trigger("changed", state.file);
  expect(state.input("Value: status").value).toBe("reading");
  expect(owner.getText()).toContain("status: old");
  state.enter(state.input("Value: status"), "reading");
  expect(owner.getText()).toContain("status: reading"); state.view.onClose();
});
it("publishes accepted same-turn Reading property edits rather than cancelling the only refresh", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state, "reading");
  const first = owner.getText(); expect(owner.applySourceEdit(first, first.indexOf("old"), first.indexOf("old") + 3, "one", { allowReading: true })).toBe(true);
  const second = owner.getText(); expect(owner.applySourceEdit(second, second.indexOf("one"), second.indexOf("one") + 3, "two", { allowReading: true })).toBe(true);
  await owner.readingRefreshInFlight.catch(() => {}); await new Promise(resolve => setImmediate(resolve));
  expect(owner.getText()).toContain("status: two");
  expect((state.app as any).markdownRenderer.render.mock.calls[0]?.slice(0, 6)).toEqual([expect.stringContaining("status: two"), expect.anything(), "Note.md", expect.anything(), expect.anything(), owner.sourceNavigation]); state.view.onClose();
});

it("Escape discards a rejected field explicitly without committing it after the native transition", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state);
  owner.bodyEl.inert = true; const field = state.input("Value: status"); field.focus(); state.enter(field, "rejected");
  owner.bodyEl.inert = false; field.events.get("blur")!({});
  expect(owner.getText()).toContain("status: old");
  field.events.get("keydown")!({ key: "Escape", preventDefault() {} });
  expect(state.input("Value: status").value).toBe("old"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("read-only"); state.view.onClose();
});
it("destroys a rejected control with its owner and never replays it into a same-file replacement", () => {
  const state = setup(); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const field = state.input("Value: status"); field.focus(); state.enter(field, "rejected");
  const next = { ...state.owner, applySourceEdit: vi.fn(() => true) }; state.setOwner(next); state.workspace.trigger("active-leaf-change");
  state.enter(field, "rejected"); expect(next.applySourceEdit).not.toHaveBeenCalled(); expect(state.input("Value: status")).not.toBe(field); state.view.onClose();
});
it("retains rejected text on a registry update while revalidating its explicit retry against the current type", () => {
  const types = new PropertyTypes(); const state = setup(undefined, types); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const field = state.input("Value: status"); field.focus(); state.enter(field, "rejected"); owner.bodyEl.inert = false;
  (document as any).activeElement = document.body; types.setType("status", "number");
  expect(state.input("Value: status")).toBe(field); expect(field.value).toBe("rejected");
  state.enter(field, "rejected"); expect(owner.getText()).toContain("status: old"); expect((state.view.containerEl as unknown as Element).text()).toContain("does not match"); state.view.onClose();
});
it("coalesces three accepted Reading edits queued behind an earlier operation to the latest snapshot", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state, "reading"); let release!: () => void;
  owner.transitionTail = new Promise<void>(resolve => { release = resolve; });
  for (const next of ["one", "two", "three"]) { const text = owner.getText(); const prior = text.match(/status: (.*)/)![1]; expect(owner.applySourceEdit(text, text.indexOf(prior), text.indexOf(prior) + prior.length, next, { allowReading: true })).toBe(true); await new Promise(resolve => setImmediate(resolve)); }
  let finishRender!: () => void; (state.app as any).markdownRenderer.render = vi.fn(() => new Promise<void>(resolve => { finishRender = resolve; }));
  let settled = false; const pending = owner.readingRefreshInFlight; void pending.then(() => { settled = true; }, () => { settled = true; });
  release(); await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  expect((state.app as any).markdownRenderer.render).toHaveBeenCalledOnce(); finishRender(); await pending;
  expect(settled).toBe(true); expect((state.app as any).markdownRenderer.render).toHaveBeenCalledOnce(); expect((state.app as any).markdownRenderer.render.mock.calls[0][0]).toContain("status: three"); state.view.onClose();
});
it("keeps native admission closed during an actual delayed Reading render rather than accepting a second edit", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state, "reading"); let release!: () => void;
  (state.app as any).markdownRenderer.render = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const first = owner.getText(); expect(owner.applySourceEdit(first, first.indexOf("old"), first.indexOf("old") + 3, "one", { allowReading: true })).toBe(true);
  await new Promise(resolve => setImmediate(resolve)); expect(owner.bodyEl.inert).toBe(true);
  const second = owner.getText(); expect(owner.applySourceEdit(second, second.indexOf("one"), second.indexOf("one") + 3, "two", { allowReading: true })).toBe(false);
  release(); await owner.readingRefreshInFlight; expect(owner.getText()).toContain("status: one"); expect(owner.bodyEl.inert).toBe(false); state.view.onClose();
});
it("does not retry a genuine native refusal even when newer Reading requests were coalesced", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state, "reading"); const refusing = vi.fn(() => { throw Error("Finish nested edit"); });
  owner.readingProjection = owner.renderOwner.child({ preflightClose: refusing });
  const first = owner.getText(); owner.applySourceEdit(first, first.indexOf("old"), first.indexOf("old") + 3, "one", { allowReading: true });
  const second = owner.getText(); owner.applySourceEdit(second, second.indexOf("one"), second.indexOf("one") + 3, "two", { allowReading: true });
  await expect(owner.readingRefreshInFlight).rejects.toThrow("Finish nested edit");
  expect(refusing).toHaveBeenCalledOnce(); expect((state.app as any).markdownRenderer.render).not.toHaveBeenCalled(); expect(owner.readingProjection.admissionAllowed).toBe(true); state.view.onClose();
});
it.each(["file", "editor", "mode", "vault", "root", "generation", "admission"])("does not replay a superseded Reading request after %s changes", async change => {
  const state = setup(); const { owner } = actualNativeOwner(state, "reading"); let release!: () => void; owner.transitionTail = new Promise<void>(resolve => { release = resolve; });
  const first = owner.getText(); owner.applySourceEdit(first, first.indexOf("old"), first.indexOf("old") + 3, "one", { allowReading: true }); await new Promise(resolve => setImmediate(resolve));
  const second = owner.getText(); owner.applySourceEdit(second, second.indexOf("one"), second.indexOf("one") + 3, "two", { allowReading: true });
  if (change === "file") owner.file = { ...state.file };
  if (change === "editor") owner.editor = { ...owner.editor };
  if (change === "mode") owner.mode = "source";
  if (change === "vault") state.app.vault = { ...state.app.vault };
  if (change === "root") state.app.vault.root = "changed";
  if (change === "generation") owner.transitionGeneration++;
  if (change === "admission") owner.renderOwner.freezeAdmission();
  release(); await expect(owner.readingRefreshInFlight).rejects.toThrow(); expect((state.app as any).markdownRenderer.render).not.toHaveBeenCalled(); state.view.onClose();
});

it("does not retry a snapshot cancellation without a newer Reading request", async () => {
  const state = setup(); const { owner, editor } = actualNativeOwner(state, "reading"); let release!: () => void; owner.transitionTail = new Promise<void>(resolve => { release = resolve; });
  const pending = owner.renderReading(); await new Promise(resolve => setImmediate(resolve));
  editor.dispatch({ changes: { from: editor.state.doc.length, insert: "raw external buffer mutation" } });
  release(); await expect(pending).rejects.toThrow(/owner changed/); expect((state.app as any).markdownRenderer.render).not.toHaveBeenCalled(); state.view.onClose();
});
it("propagates a real delayed flush failure without retrying newer accepted Reading requests", async () => {
  const state = setup(); const { owner } = actualNativeOwner(state, "reading"); const failure = Error("Storage unavailable"); owner.flush = vi.fn(async () => { throw failure; });
  const first = owner.getText(); owner.applySourceEdit(first, first.indexOf("old"), first.indexOf("old") + 3, "one", { allowReading: true });
  const second = owner.getText(); owner.applySourceEdit(second, second.indexOf("one"), second.indexOf("one") + 3, "two", { allowReading: true });
  await expect(owner.readingRefreshInFlight).rejects.toBe(failure); expect(owner.flush).toHaveBeenCalledOnce(); expect(owner.getText()).toContain("status: two"); expect((state.app as any).markdownRenderer.render).not.toHaveBeenCalled(); state.view.onClose();
});

it.each(["4", "5"])("does not resolve a rejected status draft through another count field's Enter=%s", next => {
  const state = setup("---\nstatus: old\ncount: 4\n---\nBody"); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const failed = state.input("Value: status"); failed.focus(); state.enter(failed, "rejected"); owner.bodyEl.inert = false;
  const other = state.input("Value: count"); other.focus(); state.enter(other, next);
  expect(state.input("Value: status")).toBe(failed); expect(failed.value).toBe("rejected");
  expect((state.view.containerEl as unknown as Element).text()).toContain("read-only");
  expect(owner.getText()).toContain("status: old"); expect(owner.getText()).toContain("count: 4"); state.view.onClose();
});

it.each(["remove", "checkbox", "type", "add", "other Escape"])("refuses unrelated %s action while an exact rejected field survives", action => {
  const types = new PropertyTypes(); const state = setup("---\nstatus: old\ncount: 4\ndone: false\n---\nBody", types); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const failed = state.input("Value: status"); failed.focus(); state.enter(failed, "rejected"); owner.bodyEl.inert = false;
  if (action === "remove") state.input("Remove property: count").events.get("click")!({});
  if (action === "checkbox") { const field = state.input("Value: done"); field.checked = true; field.events.get("change")!({}); expect(field.checked).toBe(false); expect((field as any).indeterminate).toBe(false); }
  if (action === "type") { const field = state.input("Type: count"); field.value = "text"; field.events.get("change")!({}); }
  if (action === "add") state.input("Add property").events.get("click")!({});
  if (action === "other Escape") state.input("Value: count").events.get("keydown")!({ key: "Escape", preventDefault() {} });
  expect(state.input("Value: status")).toBe(failed); expect(failed.value).toBe("rejected");
  expect((state.view.containerEl as unknown as Element).text()).toContain("Return to the rejected field");
  expect(owner.getText()).toContain("count: 4"); expect(owner.getText()).toContain("done: false"); expect(types.getPropertyInfo("count")).toBe(null); state.view.onClose();
});
it("allows a failed checkbox's own action to recover without advertising unsupported Enter/Escape keys", () => {
  const state = setup("---\ndone: false\n---\nBody"); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const field = state.input("Value: done"); field.checked = true; field.events.get("change")!({});
  expect((state.view.containerEl as unknown as Element).text()).toContain("read-only"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("Press Enter");
  owner.bodyEl.inert = false; field.events.get("change")!({}); expect(owner.getText()).toContain("done: true"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("read-only"); state.view.onClose();
});
it("allows a failed type picker's explicit action to clear its generic error", () => {
  const types = new PropertyTypes(); const state = setup(undefined, types); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const picker = state.input("Type: status"); picker.value = "number"; picker.events.get("change")!({});
  expect((state.view.containerEl as unknown as Element).text()).toContain("read-only"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("Press Enter");
  owner.bodyEl.inert = false; picker.events.get("change")!({}); expect(types.getPropertyInfo("status")?.type).toBe("number");
  expect((state.view.containerEl as unknown as Element).text()).not.toContain("read-only"); expect(owner.getText()).toContain("status: old"); state.view.onClose();
});

it("restores an unrelated blocked checkbox's original unset presentation", () => {
  const types = new PropertyTypes(); types.setType("done", "checkbox");
  const state = setup("---\nstatus: old\ndone: null\n---\nBody", types); const { owner } = actualNativeOwner(state); owner.bodyEl.inert = true;
  const failed = state.input("Value: status"); failed.focus(); state.enter(failed, "rejected"); owner.bodyEl.inert = false;
  const checkbox = state.input("Value: done"); checkbox.checked = true; (checkbox as any).indeterminate = false; checkbox.events.get("change")!({});
  expect(checkbox.checked).toBe(false); expect((checkbox as any).indeterminate).toBe(true); expect(owner.getText()).toContain("done: null"); expect(state.input("Value: status")).toBe(failed); state.view.onClose();
});
