import { afterEach, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
const api = await import("../../src/renderer/views/footnotes-view");
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
  let activeFile: any = file, indexedFile: any = file;
  const workspace = new Events() as Events & Record<string, any>; workspace.getActiveFile = () => activeFile;
  const metadataCache = new Events();
  const editor = { file, mode: "live", getText: () => text, isConflictReadOnly: () => false,
    scrollToOffset: vi.fn(), toggleMode: vi.fn(async () => { editor.mode = "live"; }),
    toggleSource: vi.fn(() => { editor.mode = "source"; }),
    canApplySourceEdit: () => editor.mode !== "reading" && !editor.isConflictReadOnly(),
    editor: { dispatch: vi.fn(), focus: vi.fn() } };
  let activeView: any = editor;
  const app = { workspace, metadataCache, getActiveMarkdownView: () => activeView,
    vault: { root: "synthetic", getFileByPath: () => indexedFile, read: vi.fn(async () => "stale disk") }, notify: vi.fn() };
  return { app, workspace, editor, file, setActiveFile: (value: any) => { activeFile = value; }, setIndexedFile: (value: any) => { indexedFile = value; }, setActiveView: (value: any) => { activeView = value; }, setText: (next: string) => { text = next; } };
}
it("clicking a footnote selects current live source for normal editor editing", async () => {
  expect(api.FootnotesView).toBeTypeOf("function");
  const { app, editor } = setup(); const view = new api.FootnotesView(app as any); view.onOpen(); await view.render();
  const button = (view.containerEl as unknown as Element).all().find(element => element.className === "footnotes-edit")!;
  expect(button).toBeDefined(); await button.events.get("click")!();
  expect(editor.toggleSource).toHaveBeenCalled();
  expect(editor.editor.dispatch).toHaveBeenCalledWith({ selection: { anchor: 16, head: 29 }, scrollIntoView: true });
  expect(app.vault.read).not.toHaveBeenCalled(); view.onClose();
});
it("rejects a stale row and disables unavailable/read-only edits", async () => {
  const { app, editor, setText } = setup(); const view = new api.FootnotesView(app as any); view.onOpen(); await view.render();
  const button = (view.containerEl as unknown as Element).all().find(element => element.className === "footnotes-edit")!;
  setText("changed Body[^a]\n\n[^a]: Footnote text"); await button.events.get("click")!();
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

function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function navigationFixture() {
  const f = setup(); const pane = new api.FootnotesView(f.app as any); pane.onOpen(); await pane.render();
  const edit = (pane.containerEl as unknown as Element).all().find(element => element.className === "footnotes-edit")!;
  const jump = (pane.containerEl as unknown as Element).all().find(element => element.className === "footnotes-jump")!;
  return { ...f, pane, click: () => edit.events.get("click")!(), jump: () => jump.events.get("click")!() };
}
it("awaits Reading reveal and then Source transition before exact selection and focus", async () => {
  const f = await navigationFixture(), reveal = deferred(), source = deferred(), sourceEntered = deferred(); f.editor.mode = "reading";
  f.editor.toggleMode.mockImplementation(async () => { await reveal.promise; f.editor.mode = "live"; });
  f.editor.toggleSource.mockImplementation((async () => { sourceEntered.resolve(); await source.promise; f.editor.mode = "source"; }) as any);
  const operation = f.click();
  try {
    expect(f.editor.toggleMode).toHaveBeenCalledOnce(); expect(f.editor.toggleSource).not.toHaveBeenCalled();
    expect(f.editor.editor.dispatch).not.toHaveBeenCalled(); expect(f.editor.editor.focus).not.toHaveBeenCalled();
    reveal.resolve(); await sourceEntered.promise;
    expect(f.editor.editor.dispatch).not.toHaveBeenCalled(); expect(f.editor.editor.focus).not.toHaveBeenCalled();
    source.resolve(); await operation;
    expect(f.editor.mode).toBe("source"); expect(f.editor.scrollToOffset).not.toHaveBeenCalled();
    expect(f.editor.editor.dispatch).toHaveBeenCalledExactlyOnceWith({ selection: { anchor: 16, head: 29 }, scrollIntoView: true });
    expect(f.editor.editor.focus).toHaveBeenCalledOnce(); expect(f.app.vault.read).not.toHaveBeenCalled();
  } finally { reveal.resolve(); source.resolve(); await operation; f.pane.onClose(); }
});
it("reveals the last Source editing mode without toggling it back to Live Preview", async () => {
  const f = await navigationFixture(); f.editor.mode = "reading";
  f.editor.toggleMode.mockImplementation(async () => { f.editor.mode = "source"; });
  try {
    await f.click(); expect(f.editor.toggleMode).toHaveBeenCalledOnce(); expect(f.editor.toggleSource).not.toHaveBeenCalled();
    expect(f.editor.mode).toBe("source"); expect(f.editor.editor.dispatch).toHaveBeenCalledExactlyOnceWith({ selection: { anchor: 16, head: 29 }, scrollIntoView: true });
  } finally { f.pane.onClose(); }
});
for (const stage of ["reveal", "source"] as const) it(`observes a rejected ${stage} without final selection, focus or unhandled navigation`, async () => {
  const f = await navigationFixture(); f.editor.mode = "reading";
  const reject = () => { const failed = Promise.reject(new Error("synthetic native refusal")); void failed.catch(() => {}); return failed; };
  if (stage === "reveal") f.editor.toggleMode.mockImplementation(reject);
  else f.editor.toggleSource.mockImplementation(reject as any);
  try {
    await f.click(); expect(f.editor.editor.dispatch).not.toHaveBeenCalled(); expect(f.editor.editor.focus).not.toHaveBeenCalled();
    expect(f.app.notify).toHaveBeenCalledExactlyOnceWith("Could not edit footnote. Reopen the pane to retry.");
    expect(f.editor.scrollToOffset).not.toHaveBeenCalled(); expect(f.app.vault.read).not.toHaveBeenCalled();
  } finally { f.pane.onClose(); }
});
for (const stage of ["reveal", "source"] as const) for (const mutation of ["view", "file", "path", "index", "root", "vault", "text", "editor", "closed", "read-only"] as const) {
  it(`does not apply a stale ${mutation} row after awaited ${stage}`, async () => {
    const f = await navigationFixture(), held = deferred(), entered = deferred(); f.editor.mode = "reading";
    const target = stage === "reveal" ? f.editor.toggleMode : f.editor.toggleSource;
    target.mockImplementation((async () => { entered.resolve(); await held.promise; f.editor.mode = stage === "reveal" ? "live" : "source"; }) as any);
    const originalEditor = f.editor.editor, operation = f.click();
    try {
      if (stage === "reveal") expect(f.editor.toggleMode).toHaveBeenCalledOnce();
      await entered.promise;
      if (mutation === "view") f.setActiveView({ ...f.editor });
      if (mutation === "file") { const other = { path: "Other.md", extension: "md" }; f.setActiveFile(other); f.editor.file = other; }
      if (mutation === "path") f.file.path = "Renamed.md";
      if (mutation === "index") f.setIndexedFile({ ...f.file });
      if (mutation === "root") f.app.vault.root = "changed-root";
      if (mutation === "vault") f.app.vault = { ...f.app.vault };
      if (mutation === "text") f.setText("changed Body[^a]\n\n[^a]: Footnote text");
      if (mutation === "editor") f.editor.editor = { dispatch: vi.fn(), focus: vi.fn() };
      if (mutation === "closed") f.pane.onClose();
      if (mutation === "read-only") f.editor.isConflictReadOnly = () => true;
      held.resolve(); await operation;
      expect(originalEditor.dispatch).not.toHaveBeenCalled(); expect(originalEditor.focus).not.toHaveBeenCalled();
      expect(f.editor.editor.dispatch).not.toHaveBeenCalled(); expect(f.editor.editor.focus).not.toHaveBeenCalled();
      if (stage === "reveal") expect(f.editor.toggleSource).not.toHaveBeenCalled();
      expect(f.app.vault.read).not.toHaveBeenCalled();
    } finally { held.resolve(); await operation; f.pane.onClose(); }
  });
}
it("delegates Jump only to the public reveal adapter without a second unguarded selection", async () => {
  const f = await navigationFixture(); f.editor.mode = "reading";
  try {
    await f.jump(); expect(f.editor.scrollToOffset).toHaveBeenCalledExactlyOnceWith(10);
    expect(f.editor.toggleMode).not.toHaveBeenCalled(); expect(f.editor.toggleSource).not.toHaveBeenCalled();
    expect(f.editor.editor.dispatch).not.toHaveBeenCalled(); expect(f.editor.editor.focus).not.toHaveBeenCalled();
  } finally { f.pane.onClose(); }
});
