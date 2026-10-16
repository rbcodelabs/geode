import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { BaseView } from "../../src/renderer/views/base-view";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
const state = vi.hoisted(() => ({ workspace: null as any }));
vi.mock("../../src/renderer/workspace", async original => ({ ...await original<any>(), Workspace: class { constructor() { return state.workspace; } } }));
vi.mock("../../src/renderer/api/icons", () => ({ setIcon() {} }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
class Element {
  children: Element[] = []; parentElement: Element | null = null; handlers = new Map<string, Set<(e: any) => void>>();
  className = ""; value = ""; disabled = false; inert = false; dataset: Record<string, string> = {}; textContent = "1"; innerHTML = "";
  classList = { contains: () => false, add() {}, remove() {} };
  get isConnected(): boolean { return this === document.body || !!this.parentElement?.isConnected; }
  append(...items: Element[]) { for (const item of items) this.appendChild(item); }
  appendChild(item: Element) { item.parentElement = this; this.children.push(item); return item; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.parentElement = null; }
  setAttribute() {} removeAttribute() {} select() {} scrollIntoView() {}
  closest(selector: string): Element | null { for (let e: Element | null = this; e; e = e.parentElement) { if (selector === ".base-view" && e.className === "base-view") return e; if (selector === "[inert]" && e.inert) return e; } return null; }
  querySelector(selector: string): Element | null { return this.children.flatMap(c => [c, c.querySelector(selector)]).find(c => c?.className === selector.slice(1)) ?? null; }
  addEventListener(name: string, handler: (e: any) => void) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name)!.add(handler); }
  removeEventListener(name: string, handler: (e: any) => void) { this.handlers.get(name)?.delete(handler); }
  emit(name: string, event: any = {}) { for (const handler of [...this.handlers.get(name) ?? []]) handler({ target: this, ...event }); }
  focus = vi.fn((options?: FocusOptions) => { (document as any).activeElement = this; (document as any).emit("focusin", { target: this }); });
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture() {
  const doc = new Element() as any, win = new Element(); doc.body = new Element(); doc.activeElement = doc.body; doc.createElement = () => new Element(); doc.hidden = false;
  vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
  const app = Object.create(App.prototype) as any, base = Object.create(BaseView.prototype) as any, table = Object.create(BasesTableView.prototype) as any;
  const baseRoot = new Element(); baseRoot.className = "base-view"; const body = new Element(), container = new Element(), cell = new Element(); doc.body.appendChild(baseRoot); baseRoot.appendChild(body); body.appendChild(container); container.appendChild(cell);
  const file = { path: "Source.md" }, ownerFile = { path: "Tasks.base" }; const modify = vi.fn(async () => {});
  Object.assign(base, { app, viewType: "base", file: ownerFile, containerEl: baseRoot, bodyEl: body, tableView: table, vaultSwitching: false, sourceConflictReadOnly: false, sourceEdit: null,
    persistQueue: Promise.resolve(), persistRequestedWhileSuspended: false, definitionRevision: 0, reloadOwnerGeneration: 0, nativeLifecycleGeneration: 0, reloadClosed: false,
    sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), rowFailures: new Map(), retainedNativeFailures: [], rowRefreshFailed: false, definitionWritesPending: 0 });
  base.renderOwner = new RenderOwnership().create(base); base.setSaveStatus = vi.fn();
  Object.assign(table, { containerEl: container, columns: ["note.priority"], dataRows: [{ file }], cellEls: [[cell]], readOnly: false,
    callbacks: { onEditStart: (f: any, p: string, raw: string) => base.beginSourceEdit(f,p,raw), onEditDraft: (raw: string) => { base.sourceEdit.rawText = raw; }, onEditEnd: (token: object) => base.endSourceEdit(token), onEditCell: (...args: any[]) => base.editCell(...args) } });
  // Keep actual Workspace hold/release methods while avoiding unrelated shell construction.
  const { Workspace: RealWorkspace } = await vi.importActual<typeof import("../../src/renderer/workspace")>("../../src/renderer/workspace");
  const workspace = Object.create(RealWorkspace.prototype) as any;
  const leaf = { view: base }; Object.defineProperty(workspace, "activeLeaf", { value: leaf, writable: true }); workspace.iterateLeaves = (cb: any) => cb(leaf); workspace.getLeavesOfType = (type: string) => type === "base" ? [leaf] : []; workspace.on = () => {};
  state.workspace = workspace;
  let prepare!: (token: string, path: string) => Promise<unknown>, release!: (token: string, outcome?: any) => Promise<void>;
  const load = async () => {};
  Object.assign(app, { workspace, vault: { root: "/synthetic-vault", getFileByPath: () => file, getFolderByPath: () => null, open: load, read: async () => "---\npriority: 1\n---\n", modify }, sync: { cancel: load },
    host: { config: { read: async () => null }, syncSafety: { onPrepare: (cb: any) => { prepare = cb; return () => {}; }, onRelease: (cb: any) => { release = cb; return () => {}; } } },
    commands: { loadHotkeys: load }, settings: { metadataScanCapBytes: 100 }, metadataCache: { setScanCapBytes() {}, on() {} },
    dailyNotes: { load }, templates: { load }, uniqueNotes: { load }, noteComposer: { load }, webViewer: { load }, syncUniqueNoteRibbon() {},
    comments: { holdMutations: load, releaseMutationHold() {} }, hostDisposers: new Set(), syncRefreshRecoveries: new Set(),
    createMobileNavigation() { throw Error("guard installed"); } });
  table.startEdit({ row: 0, col: 0 }); const input = cell.children[0]; input.value = "9"; input.emit("input"); input.focus.mockClear();
  await expect(app.openVaultMeasured("/synthetic-vault", new Element())).rejects.toThrow("guard installed");
  const blur = async () => { doc.activeElement = doc.body; input.emit("blur", { relatedTarget: null }); await tick(); };
  const finish = (token: string) => release(token, { changed: false });
  return { app, base, table, workspace, leaf, input, file, ownerFile, modify, doc, win, prepare, finish, release, blur };
}
it("restores only the guard-displaced draft after actual App final hold/body release without saving", async () => {
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur(); expect(f.modify).not.toHaveBeenCalled();
  await f.finish("one"); await tick(); expect(f.doc.body.inert).toBe(false); expect(f.base.vaultSwitching).toBe(false);
  expect(f.doc.activeElement).toBe(f.input); expect(f.input.focus).toHaveBeenCalledWith({ preventScroll: true }); expect(f.input.value).toBe("9"); expect(f.modify).not.toHaveBeenCalled();
});
it("keeps Linux still-focused input as a no-op", async () => { const f = await fixture(); await f.prepare("one", "Source.md"); await f.finish("one"); expect(f.doc.activeElement).toBe(f.input); expect(f.input.focus).not.toHaveBeenCalled(); });
it("nested and duplicate actual guard tokens preserve the first receipt until final release", async () => {
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.prepare("one", "Source.md"); await f.prepare("two", "Source.md"); await f.blur();
  await f.finish("missing"); await f.finish("one"); expect(f.doc.body.inert).toBe(true); expect(f.input.focus).not.toHaveBeenCalled();
  await f.finish("two"); await tick(); expect(f.doc.activeElement).toBe(f.input); expect(f.input.focus).toHaveBeenCalledTimes(1);
  await f.finish("two"); expect(f.input.focus).toHaveBeenCalledTimes(1);
});
it.each(["new-focus", "programmatic-focus", "active-leaf", "input-removed", "input-value", "session", "session-token", "table-identity", "cell-identity", "table-root", "vault", "vault-root", "base-path", "source-path", "source-identity", "draft-value", "row-failure", "definition", "owner-generation", "read-only", "disabled", "retained-failure", "frozen-owner", "window-blur", "hidden"])("does not reclaim a draft after %s supersedes its captured authority", async cause => {
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur();
  if (cause === "new-focus" || cause === "programmatic-focus") { const other = new Element(); f.doc.body.appendChild(other); other.focus(); f.doc.activeElement = f.doc.body; }
  if (cause === "active-leaf") f.workspace.activeLeaf = { view: f.base };
  if (cause === "input-removed") f.input.remove();
  if (cause === "input-value") f.input.value = "10";
  if (cause === "session") f.table.editSession = { ...f.table.editSession };
  if (cause === "session-token") f.table.editSession.token = {};
  if (cause === "table-identity") f.base.tableView = Object.create(f.table);
  if (cause === "cell-identity") f.table.cellEls[0][0] = new Element();
  if (cause === "table-root") f.table.containerEl = new Element();
  if (cause === "vault") f.app.vault = { ...f.app.vault };
  if (cause === "vault-root") f.app.vault.root = "/another-vault";
  if (cause === "base-path") f.ownerFile.path = "Other.base";
  if (cause === "source-path") f.file.path = "Other.md";
  if (cause === "source-identity") f.base.sourceEdit = { ...f.base.sourceEdit };
  if (cause === "draft-value") f.base.sourceEdit.rawText = "10";
  if (cause === "row-failure") f.base.rowFailures.set("row", {});
  if (cause === "definition") f.base.definitionRevision++;
  if (cause === "owner-generation") f.base.reloadOwnerGeneration++;
  if (cause === "read-only") f.base.sourceConflictReadOnly = true;
  if (cause === "disabled") f.input.disabled = true;
  if (cause === "retained-failure") f.base.retainedNativeFailures = [{ key: "save", error: Error("retained") }];
  if (cause === "frozen-owner") f.base.renderOwner.freezeAdmission();
  if (cause === "window-blur") f.win.emit("blur");
  if (cause === "hidden") { f.doc.hidden = true; f.doc.emit("visibilitychange"); }
  await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
});
it("a genuine rejected blur write cannot acquire a paused-guard repair", async () => {
  const f = await fixture(); f.table.callbacks.onEditCell = vi.fn(async () => { throw Error("genuine write failure"); });
  await f.prepare("one", "Source.md"); await f.blur(); await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled();
});
it("host disposal cannot restore an old guard draft", async () => {
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur(); for (const dispose of f.app.hostDisposers) dispose(); await tick();
  expect(f.input.focus).not.toHaveBeenCalled(); expect(f.doc.body.inert).toBe(false);
});
it("an expired focus receipt does not change guard holds or later restore", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur();
  await vi.advanceTimersByTimeAsync(4001); expect(f.doc.body.inert).toBe(true); await f.finish("one"); expect(f.input.focus).not.toHaveBeenCalled();
});

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
it.each(["unchanged", "new-focus", "new-guard", "expired"])("exact paused attempt released before Table catch settlement restores only when %s remains eligible", async change => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = await fixture(); await f.prepare("one", "Source.md");
  f.doc.activeElement = f.doc.body; f.input.emit("blur", { relatedTarget: null });
  // Release synchronously before the actual rejected native Promise reaches Table's catch.
  const finishing = f.finish("one"); expect(f.input.focus).not.toHaveBeenCalled();
  if (change === "new-focus") { const other = new Element(); f.doc.body.appendChild(other); other.focus(); f.doc.activeElement = f.doc.body; }
  const newer = change === "new-guard" ? f.prepare("two", "Source.md") : undefined;
  if (change === "expired") vi.advanceTimersByTime(4001);
  await finishing; await newer; await tick();
  expect(f.input.focus).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0); expect(f.modify).not.toHaveBeenCalled();
  if (change === "new-guard") await f.finish("two");
});
it("a wrapper losing the exact paused Promise witness never gains pending repair authority", async () => {
  const f = await fixture(), gate = deferred();
  f.table.callbacks.onEditCell = (...args: any[]) => f.base.editCell(...args).catch(async (error: unknown) => { await gate.promise; throw error; });
  await f.prepare("one", "Source.md"); await f.blur(); await f.finish("one"); gate.resolve(); await tick(); expect(f.input.focus).not.toHaveBeenCalled();
});
it("stale refresh discards the receipt even when its later recovery releases the hold", async () => {
  const f = await fixture(); f.app.successfulReconciles = 0; f.app.performReconcile = vi.fn(async () => { throw Error("stale refresh"); });
  await f.prepare("one", "Source.md"); await f.blur();
  await expect(f.release("one", { changed: true, kind: "write", path: "Source.md" })).rejects.toThrow("stale refresh");
  expect(f.doc.body.inert).toBe(false); expect(f.input.focus).not.toHaveBeenCalled();
  for (const recover of f.app.syncRefreshRecoveries) recover(); await tick(); expect(f.input.focus).not.toHaveBeenCalled();
});

it.each(["prior-inert", "no-focused-input", "already-paused", "pending-write"])("does not capture an ineligible %s editor", async cause => {
  const f = await fixture();
  if (cause === "prior-inert") f.doc.body.inert = true;
  if (cause === "no-focused-input") f.doc.activeElement = f.doc.body;
  if (cause === "already-paused") f.base.vaultSwitching = true;
  if (cause === "pending-write") f.base.sourcePersistsInFlight.add(new Promise(() => {}));
  await f.prepare("one", "Source.md"); await f.blur(); await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
});
it("an unbranded identical paused error message does not authorize focus repair", async () => {
  const f = await fixture(); f.table.callbacks.onEditCell = vi.fn(async () => { throw Error("Base edits are paused during a workspace operation."); });
  await f.prepare("one", "Source.md"); await f.blur(); await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled();
});

it.each(["pointerdown", "keydown"])("newer %s destination intent supersedes the receipt without successful focus", async eventName => {
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur();
  const destination = new Element(); f.doc.body.appendChild(destination);
  f.doc.emit(eventName, { target: destination, key: "Tab" }); f.doc.activeElement = f.doc.body;
  await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
});
it("consumption removes all receipt observers and expiration timer without late revival", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur(); await f.finish("one"); await tick();
  expect(f.input.focus).toHaveBeenCalledTimes(1);
  expect([...f.doc.handlers.values(), ...f.win.handlers.values()].reduce((n, set) => n + set.size, 0)).toBe(0); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5000); await f.finish("one"); expect(f.input.focus).toHaveBeenCalledTimes(1);
});
it("discard removes observers and timer while preserving the actual guard until release", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur();
  expect([...f.doc.handlers.values(), ...f.win.handlers.values()].some(set => set.size > 0)).toBe(true);
  f.win.emit("blur");
  expect([...f.doc.handlers.values(), ...f.win.handlers.values()].reduce((n, set) => n + set.size, 0)).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(f.doc.body.inert).toBe(true);
  await vi.advanceTimersByTimeAsync(5000); await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
});

it("actual Base owner resume invalidates focus even while its draft defers rerender and retains all identities", async () => {
  const f = await fixture(); f.base.def = {};
  f.base.renderOwner = new RenderOwnership().create(f.base, f.base.nativeRenderOptions());
  await f.prepare("one", "Source.md"); await f.blur();
  const edit = f.base.sourceEdit, session = f.table.editIdentity, input = f.input;
  f.base.renderOwner.freezeAdmission(); f.base.renderOwner.resume();
  expect(f.base.sourceEdit).toBe(edit); expect(f.table.editIdentity).toBe(session); expect(input.isConnected).toBe(true);
  expect(f.base.projectionRefreshPending).toBe(true);
  await f.finish("one"); await tick(); expect(f.input.focus).not.toHaveBeenCalled(); expect(f.modify).not.toHaveBeenCalled();
});

it("duplicate prepare preserves the original dirty-writer refusal instead of returning permission", async () => {
  const f = await fixture(); expect(await f.prepare("one", "Source.md")).toMatch(/Unsaved Base/);
  expect(await f.prepare("one", "Source.md")).toMatch(/Unsaved Base/);
  await f.finish("one");
});
it("workspace replacement discards observers immediately when its final old token releases", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = await fixture(); await f.prepare("one", "Source.md"); await f.blur(); f.app.workspace = {};
  await f.finish("one");
  expect([...f.doc.handlers.values(), ...f.win.handlers.values()].reduce((n, set) => n + set.size, 0)).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(f.input.focus).not.toHaveBeenCalled();
});

it("non-transforming side observers preserve the exact paused Promise used by the real blur", async () => {
  const f = await fixture(), original = f.table.callbacks.onEditCell;
  let actual: Promise<void> | undefined, returned: Promise<void> | undefined;
  f.table.callbacks.onEditCell = (...args: any[]) => {
    const attempt = Reflect.apply(original, f.table.callbacks, args) as Promise<void>; actual = attempt;
    void attempt.then(() => {}, () => {}); returned = attempt; return attempt;
  };
  await f.prepare("one", "Source.md"); await f.blur(); expect(returned).toBe(actual);
  await f.finish("one"); await tick(); expect(f.input.focus).toHaveBeenCalledTimes(1); expect(f.modify).not.toHaveBeenCalled();
});
