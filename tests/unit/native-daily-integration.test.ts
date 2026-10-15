import { afterEach, expect, it, vi } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { App } from "../../src/renderer/app";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import { pdfDocumentCapacity } from "../../src/renderer/pdf/capacity";
import { mutateProperty } from "../../src/renderer/properties/property-source";

afterEach(() => vi.unstubAllGlobals());
const source = "---\nstatus: old\n---\nBody\n";
function fixture() {
  vi.stubGlobal("document", { body: {}, activeElement: null });
  let state = EditorState.create({ doc: source, extensions: [history()] });
  const editor = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
  const view = Object.create(MarkdownView.prototype) as any;
  const registry = new RenderOwnership();
  Object.assign(view, { editor, mode: "live", file: { path: "Note.md" }, renderOwner: registry.create(view), transitionTail: Promise.resolve(), transitionGeneration: 0, transitionClosing: false, vaultSwitching: false, autosavePaused: false, conflictReadOnly: false, bodyEl: { inert: false, contains: () => false }, app: { vault: { root: "synthetic" }, notify: vi.fn() }, flush: vi.fn(async () => {}) });
  return { view, editor, registry };
}

it.each(["ownership hold", "replacement lock", "autosave hold", "terminal close"])("rejects sidebar edits during %s without dispatch or history changes", async boundary => {
  const { view, editor, registry } = fixture();
  let held: Awaited<ReturnType<RenderOwnership["hold"]>> | undefined;
  if (boundary === "ownership hold") held = await registry.hold(new Set([view]));
  if (boundary === "replacement lock") view.bodyEl.inert = true;
  if (boundary === "autosave hold") await view.pauseAutosave();
  if (boundary === "terminal close") view.transitionClosing = true;
  const before = editor.state;
  expect(view.canApplySourceEdit()).toBe(false);
  expect(view.applySourceEdit(source, 0, 0, "unexpected")).toBe(false);
  expect(editor.state).toBe(before);
  if (held) registry.release(held);
});

it("keeps the property transaction and preceding dirty body edit when native draft preflight refuses Reading", async () => {
  const { view, editor } = fixture();
  editor.dispatch({ changes: { from: source.length, insert: "Unsaved body\n" } });
  const dirty = view.getText();
  const property = mutateProperty(dirty, { kind: "set", key: "status", expected: "old", value: "fresh" });
  if (!property.ok) throw Error(property.error);
  expect(view.applySourceEdit(dirty, property.from, property.to, property.insert)).toBe(true);
  const edited = view.getText();
  view.lpProjection = view.renderOwner.child({ preflightClose: () => { throw Error("Finish child draft"); } });
  await expect(view.toggleMode()).rejects.toThrow("Finish child draft");
  expect(view.mode).toBe("live"); expect(view.getText()).toBe(edited); expect(view.flush).not.toHaveBeenCalled();
  expect(undo(editor as unknown as EditorView)).toBe(true); expect(view.getText()).toBe(dirty);
});

it("settles property persistence, Footnotes lifecycle and every PDF lease before retiring the Vault", async () => {
  const events: string[] = []; let finishProperty!: () => void; let finishFootnotes!: () => void; let finishPdf!: () => void;
  const property = new Promise<void>(resolve => { finishProperty = resolve; });
  const footnotes = new Promise<void>(resolve => { finishFootnotes = resolve; });
  const pdf = new Promise<void>(resolve => { finishPdf = resolve; });
  const app = Object.assign(Object.create(App.prototype), { clearReconcileState() {}, reconcileGeneration: 0, sync: { cancel: async () => {} }, hostDisposers: new Set(), reconcileInFlight: null, saveLayoutTimer: null, teardownLaunchSequence() {}, propertyTypes: { close: async () => { events.push("property-start"); await property; events.push("property-end"); } }, footnotesLifecycle: footnotes, footnotesPlugin: { stop: async () => { events.push("footnotes-stop"); } }, vault: { close: async () => { events.push("vault-close"); } }, metadataCache: { dispose: () => events.push("metadata-dispose") }, workspace: { dispose: () => events.push("workspace-dispose") } }) as any;
  const lease = pdfDocumentCapacity(app).acquire(async () => { events.push("pdf-start"); await pdf; events.push("pdf-end"); });
  expect(lease).toBeDefined();
  const closing = app.dispose(); await new Promise(resolve => setImmediate(resolve)); expect(events).toEqual(["property-start"]);
  finishProperty(); await new Promise(resolve => setImmediate(resolve)); expect(events).toEqual(["property-start", "property-end"]);
  finishFootnotes(); await new Promise(resolve => setImmediate(resolve)); expect(events).toEqual(["property-start", "property-end", "footnotes-stop", "pdf-start"]);
  expect(events).not.toContain("vault-close"); finishPdf(); await closing;
  expect(events).toEqual(["property-start", "property-end", "footnotes-stop", "pdf-start", "pdf-end", "vault-close", "metadata-dispose", "workspace-dispose"]);
  expect(pdfDocumentCapacity(app).size).toBe(0);
});
