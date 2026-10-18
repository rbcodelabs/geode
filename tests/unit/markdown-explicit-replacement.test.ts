import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { RenderOwnership, RenderScope } from "../../src/renderer/workspaces/render-ownership";

afterEach(() => vi.unstubAllGlobals());
function fixture(mode: "live" | "reading" = "live") {
  vi.stubGlobal("document", { body: { classList: { contains: () => false } }, createElement: () => ({ appendChild() {}, className: "" }) });
  const view = Object.create(MarkdownView.prototype) as any; const close = vi.fn(async () => {});
  const owner = new RenderOwnership().create(view);
  let refuse = true; const projection = owner.child({}); projection.child({ preflightClose: () => { if (refuse) throw new Error("Finish child draft"); }, close });
  const editor = { destroy: vi.fn(), dispatch: vi.fn(), focus: vi.fn(), state: { doc: { toString: () => "![[Board.canvas]]", length: 17 } } };
  const reading = { innerHTML: "original connected controls", appendChild: vi.fn(), style: {} };
  Object.assign(view, { renderOwner: owner, lpProjection: mode === "live" ? projection : null, readingProjection: mode === "reading" ? projection : null, transitionTail: Promise.resolve(), transitionGeneration: 0, readingRenderGeneration: 0, transitionClosing: false, file: { path: "Outer.md", basename: "Outer", parent: "" }, mode, lastEditingMode: "live", editor, pagePreview: { hide: vi.fn() }, editorHostEl: { style: {} }, readingEl: reading, readingContentEl: {}, titleEl: { textContent: "Outer" }, titleParentEl: { innerHTML: "" }, editingCompartment: { reconfigure: () => ({}) }, presentConflict: vi.fn(), clearConflictState: vi.fn(), clearSyncConflict: vi.fn(), buildEditor: vi.fn(), flush: vi.fn(async () => {}), app: { notify: vi.fn(), vault: { root: "/synthetic", read: vi.fn(async () => "replacement") }, metadataCache: { getFileCache: () => null }, markdownRenderer: { render: vi.fn(async () => {}), dispose: vi.fn() } } });
  return { view, close, editor, reading, allow: () => { refuse = false; } };
}
it.each(["toggleMode", "toggleSource", "setFile", "acceptExternalText", "restoreConflictRecovery"] as const)("refuses %s before parent flush, mode/file/title/focus or projection mutation", async action => {
  const { view, close, editor } = fixture(); const originalFile = view.file;
  await expect(async () => {
    if (action === "setFile") await view.setFile({ path: "Other.md", basename: "Other", parent: "" });
    else if (action === "acceptExternalText") await view.acceptExternalText("provider replacement");
    else if (action === "restoreConflictRecovery") await view.restoreConflictRecovery("local retained", "provider");
    else await view[action]();
  }).rejects.toThrow("Finish child draft");
  expect(view.file).toBe(originalFile); expect(view.mode).toBe("live"); expect(view.titleEl.textContent).toBe("Outer");
  expect(editor.dispatch).not.toHaveBeenCalled(); expect(editor.focus).not.toHaveBeenCalled(); expect(view.buildEditor).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(view.flush).not.toHaveBeenCalled();
});
it("refuses Reading refresh before removing its connected controls or flushing the parent", async () => {
  const { view, reading, close } = fixture("reading");
  await expect(view.renderReading()).rejects.toThrow("Finish child draft");
  expect(reading.innerHTML).toBe("original connected controls"); expect(view.flush).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(view.app.markdownRenderer.dispose).not.toHaveBeenCalled();
});
it("keeps all projections when a second projection refuses before any close", async () => {
  const { view, close } = fixture("reading"); const firstClose = vi.fn(async () => {});
  view.lpProjection = view.renderOwner.child({ close: firstClose });
  await expect(view.toggleSource()).rejects.toThrow("Finish child draft");
  expect(firstClose).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});
it("does not let terminal close wait for itself through the root transition queue", async () => {
  const { view } = fixture(); view.lpProjection = null;
  const root = new RenderOwnership().create(view, { close: vi.fn(async () => {}) }); view.renderOwner = root;
  view.transitionTail = new Promise<void>(resolve => { setTimeout(resolve, 0); });
  await view.onClose(); expect(view.transitionClosing).toBe(true);
  await expect(view.toggleSource()).rejects.toThrow();
});
it("defers a resumed projection refresh instead of synchronously destroying its widget", async () => {
  const { view, editor } = fixture(); view.resumeOwnedRendering();
  expect(editor.dispatch).not.toHaveBeenCalled();
  await new Promise(resolve => setImmediate(resolve));
  expect(editor.dispatch).not.toHaveBeenCalled();
});
it("keeps a refused child subtree intact when a navigation reveal would change mode and focus", async () => {
  const { view, editor } = fixture("reading");
  await view.scrollToOffset(2);
  expect(view.mode).toBe("reading"); expect(editor.focus).not.toHaveBeenCalled(); expect(editor.dispatch).not.toHaveBeenCalled();
});

it("recovers the transition queue after a parent save failure without retiring children early", async () => {
  const { view, close, allow } = fixture(); allow();
  view.flush.mockRejectedValueOnce(new Error("parent save rejected"));
  await expect(view.toggleSource()).rejects.toThrow("parent save rejected");
  expect(view.mode).toBe("live"); expect(close).not.toHaveBeenCalled();
  await view.toggleSource(); expect(view.mode).toBe("source"); expect(close).toHaveBeenCalledOnce();
});
it("rejects a stale queued mode request rather than replaying it in a new projection", async () => {
  const { view, allow } = fixture(); allow();
  const first = view.toggleSource(); const stale = view.toggleMode();
  await first; await expect(stale).rejects.toThrow(/owner changed/); expect(view.mode).toBe("source");
});
it("completes a Reading transition with nested root-tracked flush without self-draining", async () => {
  const { view, allow } = fixture(); allow();
  view.flush = () => view.renderOwner.retry(async () => {}, "markdown-save");
  await view.toggleMode(); expect(view.mode).toBe("reading"); expect(view.readingProjection).toBeTruthy();
}, 1000);
it("rejects parent edits during an awaited read before retiring old projections", async () => {
  const { view, editor, close, allow } = fixture(); allow(); let finish!: (text: string) => void;
  view.app.vault.read = () => new Promise<string>(resolve => { finish = resolve; });
  const changing = view.setFile({ path: "Other.md", basename: "Other", parent: "" });
  await new Promise(resolve => setImmediate(resolve)); editor.state.doc.toString = () => "new local edit"; finish("other text");
  await expect(changing).rejects.toThrow(/owner changed/); expect(view.file.path).toBe("Outer.md"); expect(close).not.toHaveBeenCalled();
});
it.each([true, false])("ordinary close ignores an unconfirmed durable banner claim=%s", async durable => {
  const view = Object.create(MarkdownView.prototype) as any; const modify = vi.fn(); const destroy = vi.fn(async () => {});
  Object.assign(view, { transitionTail: Promise.resolve(), transitionGeneration: 0, conflictReadOnly: true, conflictRecoveryDurable: durable, saveTimer: null, flushInFlight: null, file: { path: "Outer.md" }, lastSavedText: "provider", editor: { state: { doc: { toString: () => "retained local" } } }, app: { vault: { modify } } });
  view.renderOwner = new RenderOwnership().create(view, { prepareClose: () => view.prepareCloseNative(), close: destroy });
  await expect(view.onClose()).rejects.toThrow(/recovery/); expect(destroy).not.toHaveBeenCalled();
  expect(modify).not.toHaveBeenCalled(); expect(() => view.assertWorkspaceLoadReady()).toThrow(/conflict/);
});
it("cannot bypass a partially failed destructor with a subsequent replacement", async () => {
  const { view, close, editor, allow } = fixture(); allow(); close.mockRejectedValueOnce(new Error("destructor rejected"));
  await expect(view.toggleSource()).rejects.toThrow("destructor rejected");
  await expect(view.toggleSource()).rejects.toThrow(); expect(editor.dispatch).not.toHaveBeenCalled();
});
it("recovers an inert already-retired projection after its parent canceled publication", async () => {
  const { view, close, allow } = fixture(); allow(); view.bodyEl = { inert: false, contains: () => false };
  close.mockImplementationOnce(async () => { view.renderOwner.freezeAdmission(); });
  await expect(view.toggleSource()).rejects.toThrow(/owner changed/); expect(view.bodyEl.inert).toBe(true);
  view.renderOwner.resume(); await view.toggleSource(); expect(view.bodyEl.inert).toBe(false); expect(view.mode).toBe("source");
});
it.each([false, true])("locks new native input admission during delayed parent flush and restores only owned focus: moved=%s", async moved => {
  const { view, allow } = fixture(); allow(); let fail!: (error: Error) => void;
  const focus = { isConnected: true, focus: vi.fn() }; const header = {};
  (document as any).activeElement = focus;
  view.bodyEl = { inert: false, contains: (element: unknown) => element === focus };
  view.flush = () => new Promise<void>((_resolve, reject) => { fail = reject; });
  const changing = view.toggleSource(); await new Promise(resolve => setImmediate(resolve));
  expect(view.bodyEl.inert).toBe(true);
  (document as any).activeElement = moved ? header : document.body;
  fail(new Error("parent write rejected")); await expect(changing).rejects.toThrow("parent write rejected");
  expect(view.bodyEl.inert).toBe(false); expect(view.mode).toBe("live"); expect(focus.focus).toHaveBeenCalledTimes(moved ? 0 : 1);
});
it("does not steal editor focus when the user activates another pane during preparation", async () => {
  const { view, editor, allow } = fixture(); allow(); const leaf = {}; const other = {}; let active: object = leaf;
  view.ownLeaf = () => leaf; view.app.workspace = { getActiveLeaf: () => active };
  let finish!: () => void; view.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const changing = view.toggleSource(); await new Promise(resolve => setImmediate(resolve)); active = other; finish(); await changing;
  expect(editor.focus).not.toHaveBeenCalled(); expect(view.mode).toBe("source");
});

it("restores Markdown interaction after a commit-time child refusal without destroying its projection", async () => {
  const { view, allow, close } = fixture(); allow(); view.bodyEl = { inert: false, contains: () => false };
  let lateDraft = false; view.lpProjection.child({ preflightClose: () => { if (lateDraft) throw new Error("late child draft"); } });
  const prepare = RenderScope.prepareRetirement;
  const spy = vi.spyOn(RenderScope, "prepareRetirement").mockImplementation(async scopes => { const handle = await prepare(scopes); lateDraft = true; return handle; });
  try {
    await expect(view.toggleSource()).rejects.toThrow("late child draft");
    expect(view.bodyEl.inert).toBe(false); expect(view.lpProjection.admissionAllowed).toBe(true); expect(close).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
it("validates recovery bytes after projection writes before replacing the buffer", async () => {
  const { view, allow, close, editor } = fixture(); allow();
  const copy = { path: "Outer conflict.md" }; let stored = view.getText();
  view.conflictReadOnly = true;
  view.app.vault.getFileByPath = () => copy; view.app.vault.read = async () => stored;
  view.recoveryReceipt = { vault: view.app.vault, root: view.app.vault.root, source: view.file, sourcePath: view.file.path, localText: stored, destination: { kind: "copy", file: copy, path: copy.path } };
  view.lpProjection.child({ prepareClose: async () => { stored = "copy changed by child preparation"; } });
  await expect(view.acceptExternalText("provider replacement")).rejects.toThrow(/recovery copy/);
  expect(editor.dispatch).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(view.lpProjection.admissionAllowed).toBe(true);
});
it("accepts clean provider replacement while only autosave is paused", async () => {
  const { view, allow } = fixture(); allow();
  await view.pauseAutosave(); await view.acceptExternalText("provider replacement");
  expect(view.buildEditor).toHaveBeenCalledWith("provider replacement"); expect(view.file.path).toBe("Outer.md");
});
it("does not turn a real vault switch into an ordinary autosave resume", async () => {
  const { view, allow } = fixture(); allow();
  vi.stubGlobal("window", { clearTimeout() {}, setTimeout: vi.fn() }); view.app.statusBar = { update: vi.fn() };
  await view.pauseAutosave(); await view.prepareVaultSwitch(); view.resumeAutosave();
  await expect(view.acceptExternalText("provider replacement")).rejects.toThrow(/paused/); expect(view.buildEditor).not.toHaveBeenCalled();
});
it("keeps automatic saves suppressed during an autosave-only hold", async () => {
  const { view } = fixture(); const setTimeout = vi.fn(); vi.stubGlobal("window", { clearTimeout() {}, setTimeout }); view.app.statusBar = { update: vi.fn() };
  await view.pauseAutosave(); view.scheduleSave(); expect(setTimeout).not.toHaveBeenCalled();
  view.resumeAutosave(); expect(setTimeout).toHaveBeenCalledOnce();
});
