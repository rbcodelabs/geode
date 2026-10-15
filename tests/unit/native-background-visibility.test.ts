import { afterEach, expect, it, vi } from "vitest";
import { BackgroundVisibility, nativeBackgroundVisibility } from "../../src/renderer/workspaces/background-visibility";
import { BaseView } from "../../src/renderer/views/base-view";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
afterEach(() => vi.unstubAllGlobals());
class Element {
  parentElement: Element | null = null; children: Element[] = []; handlers = new Map<string, Set<(event: any) => void>>();
  value = "2"; disabled = false; textContent = "2"; innerHTML = ""; dataset = {}; className = "";
  active = true; classList = { contains: (name: string) => name === "mod-active" && this.active };
  get isConnected(): boolean { return this === document.body || !!this.parentElement?.isConnected; }
  append(...items: Element[]) { items.forEach(item => this.appendChild(item)); }
  appendChild(item: Element) { item.parentElement = this; this.children.push(item); return item; }
  remove() { this.parentElement = null; } closest() { return null; } setAttribute() {} select() {} scrollIntoView() {}
  addEventListener(name: string, fn: (event: any) => void) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name)!.add(fn); }
  removeEventListener(name: string, fn: (event: any) => void) { this.handlers.get(name)?.delete(fn); }
  emit(name: string, event: any = {}) { for (const fn of [...this.handlers.get(name) ?? []]) fn({ target: this, ...event }); }
  focus = vi.fn(() => { (document as any).activeElement = this; });
}
function fixture() {
  const doc = new Element() as any; doc.body = new Element(); doc.activeElement = doc.body; doc.hidden = false; doc.createElement = () => new Element();
  vi.stubGlobal("document", doc); vi.stubGlobal("window", new Element());
  const base = Object.create(BaseView.prototype) as any, table = Object.create(BasesTableView.prototype) as any;
  const host = new Element(), root = new Element(), grid = new Element(), cell = new Element(); doc.body.append(host); host.append(root); root.append(grid); grid.append(cell);
  const file = { path: "Tasks.base" }, source = { path: "Source.md" }, vault = { root: "/synthetic", read: async () => "---\npriority: 2\n---\n" };
  Object.assign(base, { file, app: { vault }, tableView: table, containerEl: root, bodyEl: grid, sourceEdit: null, vaultSwitching: false, sourceConflictReadOnly: false,
    sourcePersistsInFlight: new Set(), rowFailures: new Map(), retainedNativeFailures: [], definitionWritesPending: 0, rowRefreshFailed: false,
    reloadOwnerGeneration: 0, nativeLifecycleGeneration: 0, definitionRevision: 0, reloadClosed: false });
  base.renderOwner = new RenderOwnership().create(base);
  let ownerCurrent = true;
  const visibility = new BackgroundVisibility(() => () => ownerCurrent); base.backgroundVisibility = visibility;
  visibility.register(() => base.captureBackgroundEdit());
  const save = vi.fn(async () => {}), end = vi.fn();
  Object.assign(table, { containerEl: grid, columns: ["note.priority"], dataRows: [{ file: source }], cellEls: [[cell]], readOnly: false,
    callbacks: { preserveBackgroundBlur: (input: HTMLInputElement) => visibility.preserves(input), onEditStart: (f: any, column: string, raw: string) => base.beginSourceEdit(f, column, raw),
      onEditDraft: (raw: string) => { base.sourceEdit.rawText = raw; }, onEditEnd: end, onEditCell: save } });
  table.startEdit({ row: 0, col: 0 }); const input = cell.children[0]; input.value = "9"; input.emit("input"); input.focus.mockClear();
  const hide = () => { const finish = visibility.beginHide(host as any); host.active = false; doc.activeElement = doc.body; input.emit("blur", { relatedTarget: null }); finish(); };
  return { base, table, host, root, grid, cell, file, source, vault, visibility, input, doc, save, end, hide, stale: () => { ownerCurrent = false; } };
}
it("actual Base/Table hide blur leaves the exact unfinished session enabled without attempting a save", () => {
  const f = fixture(), session = f.table.editIdentity; f.hide();
  expect(f.save).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled(); expect(f.table.editIdentity).toBe(session); expect(f.input.disabled).toBe(false); expect(f.input.focus).not.toHaveBeenCalled();
});
it.each(["session", "token", "cell", "position", "read-only", "grid", "source", "source-path", "source-draft", "file", "file-path", "vault", "root", "owner", "lifecycle", "definition", "value", "disabled", "detached", "pending", "conflict"])("stale %s loses visibility authority before actual blur handling", cause => {
  const f = fixture(); const finish = f.visibility.beginHide(f.host as any); f.host.active = false; finish();
  if (cause === "session") f.table.editSession = { ...f.table.editSession };
  if (cause === "token") f.table.editSession.token = {};
  if (cause === "position") f.table.editSession.pos.row++;
  if (cause === "read-only") f.table.readOnly = true;
  if (cause === "cell") f.table.cellEls[0][0] = new Element();
  if (cause === "grid") f.table.containerEl = new Element();
  if (cause === "source") f.base.sourceEdit.file = { ...f.source };
  if (cause === "source-path") f.source.path = "Other.md";
  if (cause === "source-draft") f.base.sourceEdit.rawText = "10";
  if (cause === "file") f.base.file = { ...f.file };
  if (cause === "file-path") f.file.path = "Other.base";
  if (cause === "vault") f.base.app.vault = { ...f.vault };
  if (cause === "root") f.vault.root = "/other";
  if (cause === "owner") f.stale();
  if (cause === "lifecycle") f.base.nativeLifecycleGeneration++;
  if (cause === "definition") f.base.definitionRevision++;
  if (cause === "value") f.input.value = "10";
  if (cause === "disabled") f.input.disabled = true;
  if (cause === "detached") f.input.remove();
  if (cause === "pending") f.base.sourcePersistsInFlight.add(Promise.resolve());
  if (cause === "conflict") f.base.sourceConflictReadOnly = true;
  expect(f.visibility.preserves(f.input as any)).toBe(false);
});
it("reveal drops authority and the next deliberate actual Table blur saves normally", () => {
  const f = fixture(); f.hide(); f.host.active = true; f.visibility.reveal();
  f.input.emit("blur", { relatedTarget: null }); expect(f.save).toHaveBeenCalledOnce();
});
it("an aborted visible transition cannot suppress an ordinary blur", () => {
  const f = fixture(); const finish = f.visibility.beginHide(f.host as any); finish();
  expect(f.visibility.preserves(f.input as any)).toBe(false);
});
it("an old transition finalizer cannot clear a newer hide interval", () => {
  const f = fixture(); const old = f.visibility.beginHide(f.host as any); f.visibility.reveal();
  const newer = f.visibility.beginHide(f.host as any); f.host.active = false; newer(); old();
  expect(f.visibility.preserves(f.input as any)).toBe(true);
});
it("a hidden owner cannot grant authority to a newly opened session", () => {
  const f = fixture(); f.hide(); f.table.startEdit({ row: 0, col: 0 }); const newer = f.cell.children.at(-1)!;
  expect(f.visibility.preserves(newer as any)).toBe(false);
});
it("registered owner disposal drops pending visibility authority and listeners", () => {
  const f = fixture(); const release = f.visibility.register(() => null); f.hide(); release();
  expect(f.visibility.preserves(f.input as any)).toBe(false); expect(f.doc.handlers.get("keydown")?.size).toBe(0);
});

it.each(["leaf", "view", "file", "file-path", "vault", "vault-root", "container", "parent", "revision", "retirement"])("source owner %s change invalidates actual Base/Table visibility capture", cause => {
  const f = fixture(); let leaf: any = { view: f.base }, revision = 0;
  f.base.app.workspace = { findLeafForView: () => leaf };
  const visibility = nativeBackgroundVisibility(f.base.app, f.base, () => [revision]);
  visibility.register(() => f.base.captureBackgroundEdit());
  const done = visibility.beginHide(f.host as any); f.host.active = false; done();
  expect(visibility.preserves(f.input as any)).toBe(true);
  if (cause === "leaf") leaf = { view: f.base };
  if (cause === "view") leaf.view = {};
  if (cause === "file") f.base.file = { ...f.file };
  if (cause === "file-path") f.file.path = "Renamed.base";
  if (cause === "vault") f.base.app.vault = { ...f.vault };
  if (cause === "vault-root") f.vault.root = "/new-root";
  if (cause === "container") f.base.containerEl = new Element();
  if (cause === "parent") f.root.parentElement = new Element();
  if (cause === "revision") revision++;
  if (cause === "retirement") f.base.renderOwner.freezeAdmission();
  expect(visibility.preserves(f.input as any)).toBe(false);
});
it.each(["pointerdown", "keydown", "window-blur", "document-hidden"])("%s invalidates only existing visibility authority without refocus or a synthetic write", cause => {
  const f = fixture(); f.hide();
  expect(f.visibility.preserves(f.input as any)).toBe(true);
  if (cause === "document-hidden") { f.doc.hidden = true; f.doc.emit("visibilitychange"); }
  else if (cause === "window-blur") (window as any).emit("blur");
  else f.doc.emit(cause, { isTrusted: true });
  expect(f.visibility.preserves(f.input as any)).toBe(false); expect(f.save).not.toHaveBeenCalled(); expect(f.input.focus).not.toHaveBeenCalled();
});
it.each(["frozen", "registry-paused"] as const)("optional source capture declines %s admission without changing strict scope semantics", async cause => {
  const f = fixture(); const registry = new RenderOwnership();
  f.base.renderOwner = registry.create(f.base);
  f.base.app.workspace = { findLeafForView: () => ({ view: f.base }) };
  const visibility = nativeBackgroundVisibility(f.base.app, f.base, () => []);
  visibility.register(() => f.base.captureBackgroundEdit());
  let held: any;
  if (cause === "frozen") f.base.renderOwner.freezeAdmission();
  else held = await registry.hold(new Set([f.base]));
  expect(() => visibility.beginHide(f.host as any)).not.toThrow();
  expect(visibility.preserves(f.input as any)).toBe(false);
  expect(f.base.renderOwner.admissionAllowed).toBe(false);
  expect(() => f.base.renderOwner.captureToken()).toThrow(/admission is paused/);
  expect(f.save).not.toHaveBeenCalled(); expect(f.input.focus).not.toHaveBeenCalled();
  if (held) registry.release(held);
});
