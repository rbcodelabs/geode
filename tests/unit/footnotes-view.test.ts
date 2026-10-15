import { afterEach, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
const api = await import("../../src/renderer/views/footnotes-view").catch(() => ({})) as typeof import("../../src/renderer/views/footnotes-view");
class Element {
  className = ""; textContent = ""; isConnected = true; hiddenHost = false; disabled = false; children: Element[] = [];
  events = new Map<string, (event?: any) => void>();
  append(...children: Element[]) { this.children.push(...children); } appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; this.textContent = ""; }
  closest() { return this.hiddenHost ? {} : null; } setAttribute() {} removeAttribute() {}
  addEventListener(name: string, callback: (event?: any) => void) { this.events.set(name, callback); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  text(): string { return this.textContent + this.children.map(child => child.text()).join(" "); }
}
const original = globalThis.document;
afterEach(() => Object.defineProperty(globalThis, "document", { configurable: true, value: original }));
function setup() {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  const file = { path: "Note.md", extension: "md" };
  let text = "Body[^a]\n\n[^a]: Footnote text";
  const workspace = new Events() as Events & Record<string, any>; workspace.getActiveFile = () => file;
  const metadataCache = new Events();
  const editor = { file, mode: "live", getText: () => text, isConflictReadOnly: () => false,
    scrollToOffset: vi.fn(), toggleSource: vi.fn(() => { editor.mode = "source"; }),
    editor: { dispatch: vi.fn(), focus: vi.fn() } };
  const app = { workspace, metadataCache, getActiveMarkdownView: () => editor,
    vault: { root: "synthetic", getFileByPath: () => file, read: vi.fn(async () => "stale disk") }, notify: vi.fn() };
  return { app, workspace, editor, file, setText: (next: string) => { text = next; } };
}
it("clicking a footnote selects current live source for normal editor editing", async () => {
  expect(api.FootnotesView).toBeTypeOf("function");
  const { app, editor } = setup(); const view = new api.FootnotesView(app as any); view.onOpen(); await view.render();
  const button = (view.containerEl as unknown as Element).all().find(element => element.className === "footnotes-edit")!;
  expect(button).toBeDefined(); button.events.get("click")!();
  expect(editor.toggleSource).toHaveBeenCalled();
  expect(editor.editor.dispatch).toHaveBeenCalledWith({ selection: { anchor: 16, head: 29 }, scrollIntoView: true });
  expect(app.vault.read).not.toHaveBeenCalled(); view.onClose();
});
it("rejects a stale row and disables unavailable/read-only edits", async () => {
  const { app, editor, setText } = setup(); const view = new api.FootnotesView(app as any); view.onOpen(); await view.render();
  const button = (view.containerEl as unknown as Element).all().find(element => element.className === "footnotes-edit")!;
  setText("changed Body[^a]\n\n[^a]: Footnote text"); button.events.get("click")!();
  expect(editor.editor.dispatch).not.toHaveBeenCalled();
  editor.isConflictReadOnly = () => true; await view.render();
  expect((view.containerEl as unknown as Element).all().find(element => element.className === "footnotes-edit")!.disabled).toBe(true);
  view.onClose();
});
it("clears fileless state, catches reads, and removes subscriptions on close", async () => {
  const { app, workspace } = setup(); app.getActiveMarkdownView = () => null as any;
  app.vault.read = vi.fn(async () => { throw new Error("unavailable"); });
  const view = new api.FootnotesView(app as any); view.onOpen(); await view.render();
  expect((view.containerEl as unknown as Element).text()).toContain("Could not load footnotes");
  workspace.getActiveFile = () => null; workspace.trigger("active-leaf-change"); await view.render();
  expect((view.containerEl as unknown as Element).text()).toContain("No file is open");
  view.onClose(); const before = app.vault.read.mock.calls.length;
  workspace.getActiveFile = () => ({ path: "Other.md", extension: "md" }); workspace.trigger("file-open");
  await new Promise(resolve => setTimeout(resolve, 5)); expect(app.vault.read.mock.calls.length).toBe(before);
});

it("does no hidden scans and cancels pending reads before stale paint", async () => {
  const { app, workspace } = setup(); app.getActiveMarkdownView = () => null as any;
  let resolve!: (value: string) => void;
  app.vault.read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const view = new api.FootnotesView(app as any); view.onOpen(); await Promise.resolve();
  (view.containerEl as unknown as Element).hiddenHost = true; workspace.trigger("layout-change");
  resolve("[^a]: stale"); await new Promise(done => setTimeout(done, 5));
  expect((view.containerEl as unknown as Element).all().some(element => element.className === "footnotes-edit")).toBe(false);
  workspace.trigger("editor-change"); await new Promise(done => setTimeout(done, 5));
  expect(app.vault.read).toHaveBeenCalledTimes(1); view.onClose();
});
