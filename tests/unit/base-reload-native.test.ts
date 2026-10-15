import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import { parseBaseFile } from "../../src/renderer/bases/base-file";
afterEach(() => vi.unstubAllGlobals());
const original = "views:\n  - type: table\n    name: Table\n";
const external = "views:\n  - type: table\n    name: Table\n    sort:\n      - property: note.priority\n        direction: ASC\n";
function fixture() {
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
  const parsed = parseBaseFile(original); if ("error" in parsed) throw Error(parsed.error);
  let finish!: (value: string) => void;
  const vault = { root: "synthetic", read: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })), getCachedContent: () => undefined };
  const view = Object.assign(Object.create(BaseView.prototype), { app: { vault, notify: vi.fn() }, file: { path: "Tasks.base" }, def: parsed.def, currentViewName: "Table", inlinePersist: null, lastKnownText: original, pendingKnownText: null, persistQueue: Promise.resolve(), definitionRevision: 0, reloadOwnerGeneration: 0, reloadRequestGeneration: 0, reloadHandledGeneration: 0, reloadInFlight: null, reloadClosed: false, runAndRender: vi.fn() }) as any;
  const registry = new RenderOwnership(); view.renderOwner = registry.create(view);
  return { view, vault, registry, finish: () => finish(external) };
}
it.each(["held", "retired"])("does not admit a reload under a %s native owner", async state => {
  const { view, vault, registry } = fixture();
  let held;
  if (state === "held") held = await registry.hold(new Set([view])); else await view.renderOwner.close();
  await expect(view.reloadIfChangedExternally()).rejects.toThrow(); expect(vault.read).not.toHaveBeenCalled();
  if (held) registry.release(held);
});
it.each(["held", "retired"])("does not apply an awaited read after the native owner becomes %s", async state => {
  const { view, vault, finish } = fixture(); const before = view.def;
  const reading = view.reloadIfChangedExternally(); await new Promise(resolve => setImmediate(resolve)); expect(vault.read).toHaveBeenCalledOnce();
  let closing: Promise<void> | undefined;
  if (state === "held") view.renderOwner.freezeAdmission(); else closing = view.renderOwner.close();
  finish(); await reading; if (closing) await closing;
  expect(view.def).toBe(before); expect(view.runAndRender).not.toHaveBeenCalled();
});
it("keeps an active row edit identity and defers projection refresh after an external definition reload", async () => {
  const { view, finish } = fixture(); const edit = { file: { path: "Source.md" }, rawText: "9" };
  view.sourceEdit = edit; view.tableView = { editIdentity: edit };
  view.runAndRender = BaseView.prototype["runAndRender"];
  const reading = view.reloadIfChangedExternally(); await new Promise(resolve => setImmediate(resolve)); finish(); await reading;
  expect(view.sourceEdit).toBe(edit); expect(view.tableView.editIdentity).toBe(edit); expect(view.projectionRefreshPending).toBe(true);
});
it("retains source conflict and exact-key row failure while refreshing unrelated definition bytes", async () => {
  const { view, finish } = fixture(); view.sourceConflictReadOnly = true;
  const failed = Error("row write rejected"); await expect(view.renderOwner.run(async () => { throw failed; }, "row:source:priority")).rejects.toBe(failed);
  const reading = view.reloadIfChangedExternally(); await new Promise(resolve => setImmediate(resolve)); finish(); await reading;
  expect(view.sourceConflictReadOnly).toBe(true); expect(view.renderOwner.hasUnacknowledgedWrites).toBe(true);
  await expect(view.renderOwner.close()).rejects.toBe(failed);
});
it.each(["held", "retired"])("checks native ownership after waiting for an own-write tail when %s", async state => {
  const { view, vault } = fixture(); let finish!: () => void;
  view.persistQueue = new Promise<void>(resolve => { finish = resolve; });
  const reading = view.reloadIfChangedExternally(); await new Promise(resolve => setImmediate(resolve));
  expect(vault.read).not.toHaveBeenCalled(); let closing: Promise<void> | undefined;
  if (state === "held") view.renderOwner.freezeAdmission(); else closing = view.renderOwner.close();
  finish(); await reading; if (closing) await closing;
  expect(vault.read).not.toHaveBeenCalled(); expect(view.runAndRender).not.toHaveBeenCalled();
});
