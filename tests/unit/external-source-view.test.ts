import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/renderer/app";
import type { WorkspaceLeaf } from "../../src/renderer/workspace";
import { ExternalSourceView, validateExternalSourceViewState } from "../../src/renderer/views/external-source-view";

class Element {
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  children: Element[] = [];
  attributes: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  constructor(readonly tagName: string) {}
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, fn: () => void): void { this.listeners.set(name, fn); }
  removeEventListener(name: string): void { this.listeners.delete(name); }
}
const state = { version: 1 as const, ref: { rootId: "b88f5e63-5e51-4a67-a9c4-31294ef86018", relativePath: "docs/README.md" }, rootLabel: "Repository" };
function nodes(node: Element): Element[] { return [node, ...node.children.flatMap(nodes)]; }
function setup(runtime = "electron", supported = true) {
  let changed = () => {};
  const unsubscribe = vi.fn();
  const readText = vi.fn(async (_ref: unknown) => "# hello");
  const leaf = { updateHeader: vi.fn(), setPersistedState: vi.fn() };
  const app = { host: { runtime: { runtime }, ...(supported ? { externalRoots: { readText, onChange: (callback: () => void) => { changed = callback; return unsubscribe; } } } : {}) }, workspace: { trigger: vi.fn() } };
  const view = new ExternalSourceView(app as unknown as App, leaf as unknown as WorkspaceLeaf);
  const all = () => nodes(view.containerEl as unknown as Element);
  return { view, readText, leaf, all, changed: () => changed(), unsubscribe, text: () => all().map(node => node.textContent).join("\n") };
}
beforeEach(() => vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) }));
afterEach(() => vi.unstubAllGlobals());

describe("external source state", () => {
  it("copies valid versioned resource identities without extra locator fields", () => {
    const parsed = validateExternalSourceViewState({ ...state, locator: "/secret" });
    expect(parsed).toEqual(state);
    expect(parsed?.ref).not.toBe(state.ref);
  });
  it.each([null, {}, { ...state, version: 2 }, { ...state, rootLabel: 3 }, { ...state, ref: { ...state.ref, rootId: "" } }, ...["", "../a", "/a", "a//b", "a/./b", "C:/a", "a\\b", "a\0b"].map(relativePath => ({ ...state, ref: { ...state.ref, relativePath } }))])("rejects malformed state %j", value => {
    expect(validateExternalSourceViewState(value)).toBeNull();
  });
});
describe("ExternalSourceView", () => {
  it("clears old source and rechecks authority on lifecycle notification", async () => {
    const h = setup();
    await h.view.setState(state);
    h.readText.mockRejectedValueOnce(new Error("root-not-found"));
    h.changed();
    expect(h.text()).not.toContain("# hello");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.text()).toContain("Project root unavailable");
    expect(h.readText).toHaveBeenCalledTimes(2);
    h.view.onClose();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("reads source as literal text with identity, no editable/rendered content", async () => {
    const h = setup();
    const source = '<script>alert(1)</script>\n[[Vault note]] ![image](https://example.test/image)';
    h.readText.mockResolvedValue(source);
    await h.view.setState(state);
    expect(h.readText).toHaveBeenCalledWith(state.ref);
    expect(h.all().find(node => node.tagName === "code")?.textContent).toBe(source);
    expect(h.all().some(node => ["script", "img", "a", "textarea"].includes(node.tagName))).toBe(false);
    expect(h.text()).toContain("Read-only");
    expect(h.view.getDisplayText()).toContain("Repository");
    expect(h.view.getDisplayText()).toContain("README.md");
    expect(h.view.getState()).toEqual(state);
    expect(h.leaf.updateHeader).toHaveBeenCalled();
  });
  it.each(["ios", "android", "browser"])("retains unavailable %s identity without issuing a host read", async runtime => {
    const h = setup(runtime);
    await h.view.setState(state);
    expect(h.text()).toContain("Available on desktop");
    expect(h.readText).not.toHaveBeenCalled();
    expect(h.view.getState()).toEqual(state);
  });
  it("shows unsupported hosts without a fallback", async () => {
    const h = setup("electron", false);
    await h.view.setState(state);
    expect(h.text()).toContain("unavailable");
  });
  it("does not read invalid saved identities", async () => {
    const h = setup();
    await h.view.setState({ ...state, ref: { ...state.ref, relativePath: "../README.md" } });
    expect(h.readText).not.toHaveBeenCalled();
    expect(h.text()).toContain("unavailable");
  });
  it("uses structured host error codes without exposing raw messages", async () => {
    const h = setup();
    h.readText.mockRejectedValueOnce(Object.assign(new Error("External root: too-large /private/path"), { code: "too-large" }));
    await h.view.setState(state);
    expect(h.text()).toContain("2 MiB");
    expect(h.text()).not.toContain("/private/path");
  });
  it.each(["not-found", "root-not-found", "too-large", "invalid-utf8", "permission-denied"])("preserves identity on %s and recovers with explicit refresh", async code => {
    const h = setup();
    h.readText.mockRejectedValueOnce(new Error(code));
    await h.view.setState(state);
    expect(h.all().some(node => node.attributes.role === "alert")).toBe(true);
    expect(h.view.getState()).toEqual(state);
    await h.view.refresh();
    expect(h.text()).toContain("# hello");
    expect(h.readText).toHaveBeenCalledTimes(2);
  });
  it("ignores stale successful reads", async () => {
    const h = setup();
    let resolve!: (text: string) => void;
    h.readText.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const pending = h.view.setState(state);
    expect(h.text()).toContain("Loading");
    await h.view.setState({ ...state, ref: { ...state.ref, relativePath: "other.txt" } });
    resolve("stale source");
    await pending;
    expect(h.text()).not.toContain("stale source");
    expect(h.view.getDisplayText()).toContain("other.txt");
  });
  it("ignores pending failures after close and disallows refresh", async () => {
    const h = setup();
    let reject!: (error: Error) => void;
    h.readText.mockImplementationOnce(() => new Promise<string>((_done, fail) => { reject = fail; }));
    const pending = h.view.setState(state);
    h.view.onClose();
    const closedText = h.text();
    reject(new Error("not-found"));
    await pending;
    await h.view.refresh();
    expect(h.text()).toBe(closedText);
    expect(h.readText).toHaveBeenCalledTimes(1);
  });
  it("invalidating a pending identity clears old content and ignores completion", async () => {
    const h = setup();
    let resolve!: (text: string) => void;
    h.readText.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const pending = h.view.setState(state);
    await h.view.setState({ version: 2 });
    resolve("stale text");
    await pending;
    expect(h.text()).not.toContain("stale text");
    expect(h.view.getState()).toBeNull();
    expect(h.readText).toHaveBeenCalledTimes(1);
  });
  it("does not let caller mutations retarget a persisted resource", async () => {
    const h = setup();
    const input = { ...state, ref: { ...state.ref } };
    await h.view.setState(input);
    input.ref.relativePath = "changed.txt";
    const output = h.view.getState()!;
    output.ref.relativePath = "also-changed.txt";
    await h.view.refresh();
    expect(h.readText).toHaveBeenLastCalledWith(state.ref);
  });
});
