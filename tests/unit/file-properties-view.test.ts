import { PropertyTypes } from "../../src/renderer/properties/property-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
import { FilePropertiesView } from "../../src/renderer/views/file-properties-view";

class Element {
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
  return { view, owner, setOwner: (next: typeof owner) => { activeOwner = next; }, workspace, metadataCache, vault, file, input, enter, getText: () => text, switchFile: (file: any) => { currentFile = file; }, setReadonly: (value = true) => { readonly = value; } };
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


describe("rejected property drafts on the nonnative live-buffer adapter", () => {
  function rejected(source = "---\nstatus: old\ncount: 4\ndone: false\n---\nUnsaved body", types?: PropertyTypes) {
    const state = setup(source, types);
    const failed = state.input("Value: status"); failed.focus(); state.setReadonly(); state.enter(failed, "rejected"); state.setReadonly(false);
    return { ...state, failed };
  }
  it("retains a refused draft after blur and metadata refresh, then retries only its field", () => {
    const state = rejected();
    (document as any).activeElement = document.body; state.failed.events.get("blur")!({});
    state.metadataCache.trigger("changed", state.file);
    expect(state.input("Value: status")).toBe(state.failed); expect(state.failed.value).toBe("rejected");
    expect(state.owner.applySourceEdit).not.toHaveBeenCalled();
    state.enter(state.failed, "accepted"); expect(state.getText()).toContain("status: accepted"); expect(state.getText()).toContain("Unsaved body"); state.view.onClose();
  });
  it("discards a refused draft only through that field's explicit Escape", () => {
    const state = rejected(); state.failed.events.get("keydown")!({ key: "Escape", preventDefault() {} });
    expect(state.input("Value: status").value).toBe("old"); expect(state.owner.applySourceEdit).not.toHaveBeenCalled(); state.view.onClose();
  });
  it.each(["4", "5"])("does not resolve a refused status draft via sibling count Enter=%s", value => {
    const state = rejected(); const sibling = state.input("Value: count"); sibling.focus(); state.enter(sibling, value);
    expect(state.input("Value: status")).toBe(state.failed); expect(state.failed.value).toBe("rejected");
    expect(state.getText()).toContain("count: 4"); expect(state.owner.applySourceEdit).not.toHaveBeenCalled(); state.view.onClose();
  });
  it.each(["remove", "checkbox", "type", "add", "other Escape"])("blocks unrelated %s while the exact refused field survives", action => {
    const types = new PropertyTypes(), state = rejected(undefined, types);
    if (action === "remove") state.input("Remove property: count").events.get("click")!({});
    if (action === "checkbox") { const field = state.input("Value: done"); field.checked = true; field.events.get("change")!({}); expect(field.checked).toBe(false); }
    if (action === "type") { const field = state.input("Type: count"); field.value = "text"; field.events.get("change")!({}); }
    if (action === "add") state.input("Add property").events.get("click")!({});
    if (action === "other Escape") state.input("Value: count").events.get("keydown")!({ key: "Escape", preventDefault() {} });
    expect(state.input("Value: status")).toBe(state.failed); expect(state.failed.value).toBe("rejected");
    expect((state.view.containerEl as unknown as Element).text()).toContain("Return to the rejected field");
    expect(state.owner.applySourceEdit).not.toHaveBeenCalled(); expect(types.getPropertyInfo("count")).toBe(null); state.view.onClose();
  });
  it("restores an unrelated blocked checkbox's unset presentation", () => {
    const types = new PropertyTypes(); types.setType("done", "checkbox");
    const state = rejected("---\nstatus: old\ndone: null\n---\nUnsaved body", types);
    const checkbox = state.input("Value: done"); checkbox.checked = true; (checkbox as any).indeterminate = false; checkbox.events.get("change")!({});
    expect(checkbox.checked).toBe(false); expect((checkbox as any).indeterminate).toBe(true); expect(state.owner.applySourceEdit).not.toHaveBeenCalled(); state.view.onClose();
  });
  it("allows a failed checkbox's own retry without promising text-field keys", () => {
    const state = setup("---\ndone: false\n---\nUnsaved body"), checkbox = state.input("Value: done");
    state.setReadonly(); checkbox.checked = true; checkbox.events.get("change")!({});
    expect((state.view.containerEl as unknown as Element).text()).toContain("read-only"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("Press Enter");
    state.setReadonly(false); checkbox.events.get("change")!({}); expect(state.getText()).toContain("done: true"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("read-only"); state.view.onClose();
  });
  it("clears a generic type-picker error through its own successful retry", () => {
    const types = new PropertyTypes(), state = setup(undefined, types), picker = state.input("Type: status");
    state.setReadonly(); picker.value = "number"; picker.events.get("change")!({});
    expect((state.view.containerEl as unknown as Element).text()).toContain("read-only"); expect((state.view.containerEl as unknown as Element).text()).not.toContain("Press Enter");
    state.setReadonly(false); picker.events.get("change")!({}); expect(types.getPropertyInfo("status")?.type).toBe("number");
    expect((state.view.containerEl as unknown as Element).text()).not.toContain("read-only"); state.view.onClose();
  });
});
