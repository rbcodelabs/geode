import { afterEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
import type { TFile } from "../../src/renderer/types";
const api = await import("../../src/renderer/views/outgoing-links-view").catch(() => ({})) as typeof import("../../src/renderer/views/outgoing-links-view");
class Element {
  className = ""; textContent = ""; isConnected = true; hidden = false; disabled = false; title = ""; dataset = {};
  children: Element[] = []; events = new Map<string, (event: any) => void>(); hiddenHost = false;
  set innerHTML(value: string) { this.children = []; this.textContent = value; }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; this.textContent = ""; }
  setAttribute() {} removeAttribute() {}
  closest() { return this.hiddenHost ? {} : null; }
  addEventListener(name: string, callback: (event: any) => void) { this.events.set(name, callback); }
  all(): Element[] { return [this, ...this.children.flatMap(e => e.all())]; }
  text(): string { return this.textContent + this.children.map(e => e.text()).join(" "); }
}
const originalDocument = globalThis.document;
afterEach(() => Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument }));
function setup(text = "Atlas") {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  const source = { path: "Source.md", extension: "md", basename: "Source" } as TFile;
  const target = { path: "a/Atlas.md", extension: "md", basename: "Atlas" } as TFile;
  const workspace = new Events() as Events & Record<string, any>;
  workspace.getActiveFile = () => source;
  workspace.openLinkText = vi.fn(async () => {});
  const metadataCache = new Events() as Events & Record<string, any>;
  metadataCache.getFileCache = () => ({ aliases: [] });
  metadataCache.getFirstLinkpathDest = () => target;
  let liveText = text;
  const editor = { file: source, editor: {}, mode: "live", getText: () => liveText, canApplySourceEdit: () => true,
    applySourceEdit: vi.fn((snapshot, from, to, insert) => { if (snapshot !== liveText) return false; liveText = liveText.slice(0, from) + insert + liveText.slice(to); return true; }) };
  const app = { workspace, metadataCache, getActiveMarkdownView: () => editor,
    vault: { root: "vault", getMarkdownFiles: () => [source, target], getFileByPath: (path: string) => path === target.path ? target : source, read: vi.fn(async () => "stale disk") },
    excludedFiles: { ready: Promise.resolve(), matches: (_path: string) => false, onChange: (_listener: () => void) => () => {} },
    fileManager: { generateMarkdownLink: () => "[[a/Atlas|Atlas]]" }, notify: vi.fn() };
  return { app, workspace, editor, source, target, getText: () => liveText, setText: (text: string) => { liveText = text; } };
}
const drain = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };
describe("Outgoing links view", () => {
  it("uses live text and converts through one guarded buffer edit", async () => {
    expect(api.OutgoingLinksView).toBeTypeOf("function");
    const { app, editor, getText } = setup();
    const view = new api.OutgoingLinksView(app as any);
    view.onOpen(); await drain();
    const button = (view.containerEl as unknown as Element).all().find(e => e.className === "outgoing-link-convert")!;
    expect(button).toBeDefined(); expect(app.vault.read).not.toHaveBeenCalled();
    button.events.get("click")!({}); await drain();
    expect(getText()).toBe("[[a/Atlas|Atlas]]"); expect(editor.applySourceEdit).toHaveBeenCalledTimes(1);
    view.onClose();
  });
  it("refuses stale ranges and deleted targets without touching the buffer", async () => {
    const { app, editor, setText } = setup();
    const view = new api.OutgoingLinksView(app as any); view.onOpen(); await drain();
    const button = (view.containerEl as unknown as Element).all().find(e => e.className === "outgoing-link-convert")!;
    setText("changed Atlas"); button.events.get("click")!({}); await drain();
    expect(editor.applySourceEdit).not.toHaveBeenCalled();
    const next = (view.containerEl as unknown as Element).all().find(e => e.className === "outgoing-link-convert")!;
    app.vault.getFileByPath = () => null as any; next.events.get("click")!({});
    expect(editor.applySourceEdit).not.toHaveBeenCalled(); view.onClose();
  });
  it("refuses an old conversion button after its target becomes excluded", async () => {
    const { app, editor, target, getText } = setup();
    let exclusionsChanged!: () => void;
    app.excludedFiles.onChange = listener => { exclusionsChanged = listener; return () => {}; };
    const view = new api.OutgoingLinksView(app as any); view.onOpen(); await drain();
    const button = (view.containerEl as unknown as Element).all().find(e => e.className === "outgoing-link-convert")!;
    expect(button).toBeDefined();
    app.excludedFiles.matches = path => path === target.path;
    exclusionsChanged();
    // Same-subject refresh keeps the old rows until the scheduled render runs.
    button.events.get("click")!({});
    expect(editor.applySourceEdit).not.toHaveBeenCalled();
    expect(getText()).toBe("Atlas");
    await drain();
    expect((view.containerEl as unknown as Element).all().some(e => e.className === "outgoing-link-convert")).toBe(false);
    view.onClose();
  });
  it("shows read errors, fileless states, and stops subscriptions when closed", async () => {
    const { app, workspace } = setup(); app.getActiveMarkdownView = () => null as any;
    app.vault.read = vi.fn(async () => { throw new Error("read failure"); });
    const view = new api.OutgoingLinksView(app as any); view.onOpen(); await drain();
    expect((view.containerEl as unknown as Element).text()).toContain("Could not load outgoing links");
    workspace.getActiveFile = () => null; workspace.trigger("active-leaf-change"); await drain();
    expect((view.containerEl as unknown as Element).text()).toContain("No file is open");
    view.onClose(); workspace.getActiveFile = () => ({ path: "Next.md", extension: "md" }); workspace.trigger("active-leaf-change"); await drain();
    expect(app.vault.read).toHaveBeenCalledTimes(1);
  });
  it("cancels an in-flight read on hide and never paints the stale subject", async () => {
    const { app, workspace } = setup(); app.getActiveMarkdownView = () => null as any;
    let complete!: (text: string) => void;
    app.vault.read = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const view = new api.OutgoingLinksView(app as any); view.onOpen(); await drain();
    (view.containerEl as unknown as Element).hiddenHost = true; workspace.trigger("layout-change");
    complete("Atlas"); await drain();
    expect((view.containerEl as unknown as Element).all().some(e => e.className === "outgoing-link-convert")).toBe(false);
    view.onClose();
  });
});

it("announces limited suggestions instead of presenting a capped count as complete", async () => {
  const { app } = setup("Atlas ".repeat(1_000));
  const view = new api.OutgoingLinksView(app as any); view.onOpen(); await view.render();
  expect((view.containerEl as unknown as Element).text()).toContain("Showing 500 suggestions from a limited scan");
  expect((view.containerEl as unknown as Element).all().filter(e => e.className === "outgoing-link-convert")).toHaveLength(500);
  view.onClose();
});

it("refuses generated targets that would activate an external scheme", async () => {
  const { app, editor } = setup();
  app.fileManager.generateMarkdownLink = () => "[[https://example.com|Atlas]]";
  const view = new api.OutgoingLinksView(app as any); view.onOpen(); await view.render();
  const button = (view.containerEl as unknown as Element).all().find(element => element.className === "outgoing-link-convert")!;
  button.events.get("click")!({});
  expect(editor.applySourceEdit).not.toHaveBeenCalled();
  expect(app.workspace.openLinkText).not.toHaveBeenCalled();
  expect(app.notify).toHaveBeenCalledWith("Could not create an unambiguous link for this mention.");
  view.onClose();
});
