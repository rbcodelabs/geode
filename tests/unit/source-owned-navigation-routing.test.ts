import { SourceOwnedNavigation, SourceNavigationEffectFailure } from "../../src/renderer/markdown/source-owned-navigation";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { WorkspaceLeaf } from "../../src/renderer/workspace";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import type { TFile } from "../../src/renderer/types";

function file(path: string): TFile {
  const name = path.split("/").at(-1)!;
  return { kind: "file", path, name, basename: name.replace(/\.md$/, ""), extension: "md", parent: "", mtime: 0, ctime: 0, size: 0 };
}
function fixture() {
  const app = Object.create(App.prototype) as App;
  const source = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
  const fresh = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
  const target = file("Other.md"), files = new Map([[target.path, target]]);
  const activate = vi.fn(), allocate = vi.fn((newTab: boolean) => newTab ? fresh : source);
  Object.assign(source, { view: { getFile: () => file("Outer.md") }, group: { setActiveLeaf: activate } });
  Object.assign(fresh, { view: null, group: { setActiveLeaf: activate } });
  const create = vi.fn(async (path: string) => { const created = file(path); files.set(path, created); return created; });
  const mount = vi.fn(async (leaf: WorkspaceLeaf, target: TFile) => { leaf.view = { getFile: () => target } as any; });
  Object.assign(app, {
    vault: { root: "/synthetic", getFileByPath: (path: string) => files.get(path) ?? null, availablePath: (_folder: string, name: string) => `${name}.md`, create },
    metadataCache: { getFirstLinkpathDest: (link: string) => files.get(link.split("#")[0] + ".md") ?? null },
    workspace: { findLeafForFile: () => null, getLeaf: allocate, getActiveLeaf: () => source },
    mountDocumentInLeaf: mount,
  });
  return { app, source, fresh, target, files, create, mount, activate, allocate };
}

describe("private source navigation routing", () => {
  it("refuses before destination reuse, new tab allocation or missing file creation", async () => {
    const state = fixture();
    (state.app.workspace as any).findLeafForFile = () => state.fresh;
    const validate = () => { throw new Error("Unfinished native edit"); };
    for (const linktext of ["Other", "Missing"]) {
      await expect(state.app.navigateFromSource({ kind: "link", linktext, sourcePath: "Host.md", newTab: true }, state.source, validate)).rejects.toThrow("Unfinished native edit");
    }
    expect(state.create).not.toHaveBeenCalled(); expect(state.allocate).not.toHaveBeenCalled();
    expect(state.activate).not.toHaveBeenCalled(); expect(state.mount).not.toHaveBeenCalled();
  });
  it("uses the already serialized path for same-leaf navigation", async () => {
    const state = fixture();
    await state.app.navigateFromSource({ kind: "file", file: state.target, newTab: false }, state.source, () => {});
    expect(state.mount).toHaveBeenCalledOnce(); expect(state.mount).toHaveBeenCalledWith(state.source, state.target, true);
  });
  it("activates the explicitly routed source pane when another pane was active", async () => {
    const state = fixture(); (state.app.workspace as any).getActiveLeaf = () => state.fresh;
    await state.app.navigateFromSource({ kind: "file", file: state.target, newTab: false }, state.source, () => {});
    expect(state.activate).toHaveBeenCalledWith(state.source);
    expect(state.mount).toHaveBeenCalledWith(state.source, state.target, true);
  });
  it("allocates and loads a fresh tab while keeping the source view", async () => {
    const state = fixture(), original = state.source.view;
    await state.app.navigateFromSource({ kind: "file", file: state.target, newTab: true }, state.source, () => {});
    expect(state.allocate).toHaveBeenCalledWith(true, undefined, state.source);
    expect(state.mount).toHaveBeenCalledWith(state.fresh, state.target, true);
    expect(state.source.view).toBe(original);
  });
  it("activates a reused destination without replacing either owner", async () => {
    const state = fixture(), original = state.source.view;
    state.fresh.view = { getFile: () => state.target } as any;
    (state.app.workspace as any).findLeafForFile = () => state.fresh;
    await state.app.navigateFromSource({ kind: "file", file: state.target, newTab: false }, state.source, () => {});
    expect(state.activate).toHaveBeenCalledWith(state.fresh); expect(state.mount).not.toHaveBeenCalled();
    expect(state.source.view).toBe(original);
  });
  it("rechecks source readiness when an existing queue releases", async () => {
    const state = fixture(); let release!: () => void, valid = true;
    await Promise.resolve();
    const held = state.source.runDocumentNavigation(() => new Promise<void>(done => { release = done; }));
    await Promise.resolve();
    const navigation = state.app.navigateFromSource({ kind: "file", file: state.target, newTab: true }, state.source, () => { if (!valid) throw new Error("Owner changed"); });
    valid = false; release(); await held;
    await expect(navigation).rejects.toThrow("Owner changed"); expect(state.allocate).not.toHaveBeenCalled();
  });
  it("creates a missing destination only after source validation", async () => {
    const state = fixture(); const validate = vi.fn();
    await state.app.navigateFromSource({ kind: "link", linktext: "Missing", sourcePath: "Host.md", newTab: false }, state.source, validate);
    expect(state.create).toHaveBeenCalledWith("Missing.md", ""); expect(validate).toHaveBeenCalled();
    expect(state.mount).toHaveBeenCalledWith(state.source, state.files.get("Missing.md"), true);
  });
  it("does not report completion before the actual destination reveal settles", async () => {
    const state = fixture(); let release!: () => void, completed = false;
    const reveal = new Promise<void>(done => { release = done; });
    const view = Object.create(MarkdownView.prototype) as MarkdownView;
    Object.assign(view, { file: state.target, scrollToOffsetAsync: vi.fn(() => reveal) });
    state.fresh.view = view; (state.app.workspace as any).findLeafForFile = () => state.fresh;
    (state.app as any).resolveSubpathOffset = vi.fn(async () => 42);
    const navigation = state.app.navigateFromSource({ kind: "link", linktext: "Other#Heading", sourcePath: "Host.md", newTab: false }, state.source, () => {}).then(() => { completed = true; });
    await vi.waitFor(() => expect(view.scrollToOffsetAsync).toHaveBeenCalledWith(42));
    expect(completed).toBe(false); release(); await navigation; expect(completed).toBe(true);
  });
});


describe("navigation after an authorized effect", () => {
  it("preserves an already created note and reports failed when the source changes during creation", async () => {
    const state = fixture(); let release!: () => void, valid = true;
    const gate = new Promise<void>(done => { release = done; });
    state.create.mockImplementation(async path => { const created = file(path); state.files.set(path, created); await gate; return created; });
    const navigation = new SourceOwnedNavigation({
      capture: () => () => { if (!valid) throw new Error("Owner changed"); }, preflight: () => {}, notify: () => {},
      execute: (request, validate) => state.app.navigateFromSource(request, state.source, validate),
    });
    const intent = navigation.prepareNavigation({ kind: "link", linktext: "Missing", sourcePath: "Host.md", newTab: false });
    const completion = intent.dispatch();
    await vi.waitFor(() => expect(state.files.has("Missing.md")).toBe(true));
    const created = state.files.get("Missing.md"); valid = false; release();
    expect(await completion).toEqual({ status: "failed" }); expect(state.files.get("Missing.md")).toBe(created);
    expect(state.allocate).not.toHaveBeenCalled(); expect(state.activate).not.toHaveBeenCalled(); expect(state.mount).not.toHaveBeenCalled();
  });
  it("preserves the cause and conservatively marks a failed allocation as post-effect", async () => {
    const state = fixture(), cause = new Error("Allocation interrupted");
    state.allocate.mockImplementation(() => { throw cause; });
    const navigation = state.app.navigateFromSource({ kind: "file", file: state.target, newTab: true }, state.source, () => {});
    await expect(navigation).rejects.toBeInstanceOf(SourceNavigationEffectFailure);
    await expect(navigation).rejects.toMatchObject({ cause }); expect(state.mount).not.toHaveBeenCalled();
  });
});
