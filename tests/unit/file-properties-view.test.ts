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
function setup() {
  const body = new Element("body");
  vi.stubGlobal("document", { body, activeElement: body, createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("HTMLInputElement", Element);
  const file = { path: "Note.md", basename: "Note", extension: "md" };
  const workspace = new Events() as Events & Record<string, any>;
  let currentFile: any = file;
  let text = "---\nstatus: old\n---\nUnsaved body";
  let readonly = false;
  workspace.getActiveFile = () => currentFile;
  const vault = new Events() as Events & Record<string, any>;
  Object.assign(vault, { root: "vault", getFileByPath: (path: string) => path === currentFile?.path ? currentFile : null, read: vi.fn(async () => text) });
  const owner = { file, mode: "live", getText: vi.fn(() => text), canApplySourceEdit: () => !readonly, applySourceEdit: vi.fn((snapshot: string, from: number, to: number, insert: string) => { if (readonly || snapshot !== text) return false; text = text.slice(0, from) + insert + text.slice(to); return true; }) };
  const metadataCache = new Events();
  let activeOwner = owner;
  const app = { workspace, vault, metadataCache, getActiveMarkdownView: () => activeOwner, actions: { execute: vi.fn() }, openFile: vi.fn() };
  const view = new FilePropertiesView(app as any); view.onOpen();
  const input = (label: string) => (view.containerEl as unknown as Element).all().find(element => element.attributes["aria-label"] === label)!;
  const enter = (element: Element, value: string) => { element.value = value; element.events.get("input")?.({}); element.events.get("keydown")?.({ key: "Enter", preventDefault() {} }); };
  return { view, owner, setOwner: (next: typeof owner) => { activeOwner = next; }, workspace, metadataCache, vault, file, input, enter, getText: () => text, switchFile: (file: any) => { currentFile = file; }, setReadonly: () => { readonly = true; } };
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
