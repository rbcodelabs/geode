import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { parseBaseFile } from "../../src/renderer/bases/base-file";

afterEach(() => vi.unstubAllGlobals());
const text = (property: string) => `views:\n  - type: table\n    name: Table\n    sort:\n      - property: ${property}\n        direction: ASC\n`;
const definition = (source: string) => {
  const parsed = parseBaseFile(source);
  if ("error" in parsed) throw Error(parsed.error);
  return parsed.def;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
  const source = text("file.name"), file = { path: "Tasks.base" };
  const vault = { read: vi.fn(async () => source), modify: vi.fn(async () => {}), getCachedContent: vi.fn((): string | undefined => undefined), off: vi.fn(), root: "/synthetic-vault" };
  const view = Object.create(BaseView.prototype) as any;
  Object.assign(view, {
    file, def: definition(source), currentViewName: "Table", lastKnownText: source, pendingKnownText: null,
    persistQueue: Promise.resolve(), sourcePersistsInFlight: new Set(), vaultSwitching: false, inlinePersist: null,
    definitionRevision: 0, reloadOwnerGeneration: 0, reloadRequestGeneration: 0, reloadHandledGeneration: 0, reloadInFlight: null, reloadClosed: false,
    app: { vault, notify: vi.fn(), metadataCache: { off: vi.fn() } }, runAndRender: vi.fn(),
    cardsView: { destroy: vi.fn() }, pluginViewHost: { destroy: vi.fn() }, mobileCleanups: [],
  });
  return { view, vault, file };
}
it("does not apply an earlier own-write read after a newer acknowledged sort save", async () => {
  const { view, vault } = fixture(); const gate = deferred<string>(); vault.read.mockImplementationOnce(() => gate.promise);
  const reload = view.reloadIfChangedExternally(); await tick(); expect(vault.read).toHaveBeenCalledOnce();
  view.def.views[0].sort = [{ property: "note.priority", direction: "ASC" }];
  await view.persist(); const acknowledged = view.def, known = view.lastKnownText;
  vault.read.mockResolvedValue(known); view.runAndRender.mockClear();
  gate.resolve(text("file.name")); await reload;
  expect(view.def).toBe(acknowledged);
  expect(view.def.views[0].sort).toEqual([{ property: "note.priority", direction: "ASC" }]);
  expect(view.lastKnownText).toBe(known); expect(view.runAndRender).not.toHaveBeenCalled();
});
it.each(["file", "path", "vault", "root", "inline", "close"])("refuses an old read after its %s changes", async change => {
  const { view, vault, file } = fixture(); const gate = deferred<string>(); vault.read.mockImplementationOnce(() => gate.promise);
  const reload = view.reloadIfChangedExternally(); await tick(); const original = view.def;
  if (change === "file") view.file = { path: "Other.base" };
  if (change === "path") file.path = "Moved.base";
  if (change === "vault") view.app.vault = { ...vault };
  if (change === "root") vault.root = "/other-synthetic-vault";
  if (change === "inline") view.inlinePersist = async () => {};
  if (change === "close") await view.onClose();
  gate.resolve(text("note.status")); await reload;
  expect(view.def).toBe(original); expect(view.runAndRender).not.toHaveBeenCalled();
});
it("coalesces superseding external notifications and rereads the actual latest external bytes", async () => {
  const { view, vault } = fixture(); const old = deferred<string>();
  vault.read.mockImplementationOnce(() => old.promise).mockResolvedValue(text("note.status"));
  const first = view.reloadIfChangedExternally(); await tick();
  const second = view.reloadIfChangedExternally(); const third = view.reloadIfChangedExternally();
  old.resolve(text("note.priority")); await Promise.all([first, second, third]);
  expect(vault.read).toHaveBeenCalledTimes(2);
  expect(view.def.views[0].sort).toEqual([{ property: "note.status", direction: "ASC" }]);
  expect(view.runAndRender).toHaveBeenCalledOnce();
});
it("waits for a pending own write before reading and applies a genuine later external change", async () => {
  const { view, vault } = fixture(); const write = deferred<void>(); vault.modify.mockImplementationOnce(() => write.promise);
  view.def.views[0].sort = [{ property: "note.priority", direction: "ASC" }];
  const saving = view.persist(); await tick(); vault.read.mockResolvedValue(text("note.status"));
  const reload = view.reloadIfChangedExternally(); await tick(); expect(vault.read).not.toHaveBeenCalled();
  write.resolve(); await Promise.all([saving, reload]);
  expect(view.def.views[0].sort).toEqual([{ property: "note.status", direction: "ASC" }]);
  expect(vault.read).toHaveBeenCalledOnce();
});
it("returns an original failed own persist without reading or discarding its draft and permits a later explicit reload", async () => {
  const { view, vault } = fixture(); const failed = Error("own write failed"); const own = Promise.reject(failed); void own.catch(() => {});
  view.persistQueue = own; const original = view.def;
  await expect(view.reloadIfChangedExternally()).rejects.toBe(failed);
  expect(view.def).toBe(original); expect(vault.read).not.toHaveBeenCalled();
  await expect(view.reloadIfChangedExternally()).rejects.toBe(failed);
  expect(vault.read).not.toHaveBeenCalled();
  await view.persist(); vault.read.mockResolvedValue(text("note.status"));
  await view.reloadIfChangedExternally(); expect(view.def.views[0].sort[0].property).toBe("note.status");
});
it("preserves the original read error and admits a later valid notification", async () => {
  const { view, vault } = fixture(); const failed = Error("read failed"); vault.read.mockRejectedValueOnce(failed).mockResolvedValue(text("note.status"));
  await expect(view.reloadIfChangedExternally()).rejects.toBe(failed);
  await view.reloadIfChangedExternally(); expect(view.def.views[0].sort[0].property).toBe("note.status");
});
it("keeps unchanged own bytes as a no-op", async () => {
  const { view, vault } = fixture(); const original = view.def;
  await view.reloadIfChangedExternally(); expect(vault.read).toHaveBeenCalledOnce(); expect(view.def).toBe(original); expect(view.runAndRender).not.toHaveBeenCalled();
});

it("waits for a newer write tail admitted during the captured tail wait without polling reads", async () => {
  const { view, vault } = fixture(); const first = deferred<void>(), second = deferred<void>();
  vault.modify.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const savingFirst = view.persist(); await tick();
  const reload = view.reloadIfChangedExternally(); await tick();
  view.def.views[0].sort = [{ property: "note.priority", direction: "ASC" }];
  const savingSecond = view.persist(); first.resolve(); await savingFirst; await tick();
  expect(vault.read).not.toHaveBeenCalled();
  vault.read.mockResolvedValue(text("note.status")); second.resolve();
  await Promise.all([savingSecond, reload]); expect(vault.read).toHaveBeenCalledOnce();
  expect(view.def.views[0].sort[0].property).toBe("note.status");
});
it("shares a pending write rejection across coalesced requests without automatic reads or retry", async () => {
  const { view, vault } = fixture(); const failed = Error("pending write rejected");
  let reject!: (error: Error) => void;
  view.persistQueue = new Promise<void>((_resolve: unknown, fail: (error: Error) => void) => { reject = fail; });
  const first = view.reloadIfChangedExternally(), second = view.reloadIfChangedExternally();
  const expectations = [expect(first).rejects.toBe(failed), expect(second).rejects.toBe(failed)];
  reject(failed); await Promise.all(expectations); await tick();
  expect(vault.read).not.toHaveBeenCalled(); expect(view.reloadInFlight).toBeNull();
});
it("does not self-wait when its own synchronous modify echo requests a reload", async () => {
  const { view, vault } = fixture(); let echo!: Promise<void>;
  vault.modify.mockImplementationOnce(async (_file: unknown, value: string) => {
    vault.read.mockResolvedValue(value); echo = view.reloadIfChangedExternally();
  });
  view.def.views[0].sort = [{ property: "note.priority", direction: "ASC" }];
  await view.persist(); await echo;
  expect(vault.modify).toHaveBeenCalledOnce(); expect(vault.read).toHaveBeenCalledOnce();
  expect(view.def.views[0].sort[0].property).toBe("note.priority");
});
it("includes the final notification arriving between a current no-op check and drain cleanup", async () => {
  const { view, vault } = fixture(); let later!: Promise<void>;
  vault.getCachedContent.mockImplementationOnce(() => {
    queueMicrotask(() => { later = view.reloadIfChangedExternally(); });
    return view.lastKnownText;
  });
  vault.read.mockResolvedValue(text("note.status"));
  await view.reloadIfChangedExternally(); await later;
  expect(vault.read).toHaveBeenCalledOnce(); expect(view.def.views[0].sort[0].property).toBe("note.status");
});
