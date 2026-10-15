import { afterEach, expect, it, vi } from "vitest";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const view = Object.create(MarkdownView.prototype) as any;
  const source = { path: "Outer.md" }; const copy = { path: "Outer conflict.md" }; const close = vi.fn(async () => {});
  let indexed = copy; let stored = "retained local"; let local = stored;
  const vault = { root: "/synthetic", getFileByPath: (path: string) => path === source.path ? source : indexed, read: vi.fn(async () => stored), modify: vi.fn() };
  Object.assign(view, { file: source, conflictReadOnly: true, conflictRecoveryDurable: true, transitionTail: Promise.resolve(), transitionGeneration: 0, flushInFlight: null, saveTimer: null, lastSavedText: "provider", editor: { state: { doc: { toString: () => local } } }, app: { vault, notify: vi.fn() }, recoveryReceipt: { vault, root: vault.root, source, sourcePath: source.path, localText: local, destination: { kind: "copy", file: copy, path: copy.path } } });
  view.renderOwner = new RenderOwnership().create(view, { prepareClose: () => view.prepareCloseNative(), validateClose: () => view.validateRecoveryReceipt(), close });
  return { view, vault, close, source, copy, changeLocal: (text: string) => { local = text; }, changeCopy: (text: string) => { stored = text; }, recreateCopy: () => { indexed = { ...copy }; } };
}
it("allows ordinary close only after validating the exact indexed recovery copy without provider writes", async () => {
  const { view, vault, copy, close } = fixture(); await view.onClose();
  expect(vault.read).toHaveBeenCalledWith(copy); expect(vault.modify).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  expect(() => view.assertWorkspaceLoadReady()).toThrow(/conflict/);
});
it.each(["local", "copy", "recreated", "absent"])("refuses a %s recovery mismatch without destroying the local editor", async mismatch => {
  const f = fixture();
  if (mismatch === "local") f.changeLocal("newer unsaved local"); else if (mismatch === "copy") f.changeCopy("modified copy"); else if (mismatch === "recreated") f.recreateCopy(); else f.view.recoveryReceipt = null;
  await expect(f.view.onClose()).rejects.toThrow(/recovery/); expect(f.close).not.toHaveBeenCalled(); expect(f.vault.modify).not.toHaveBeenCalled();
});
it("rechecks the live local snapshot after an awaited recovery-copy read", async () => {
  const f = fixture(); let finish!: (text: string) => void;
  f.vault.read.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  const closing = f.view.onClose(); await new Promise(resolve => setImmediate(resolve)); f.changeLocal("changed during validation"); finish("retained local");
  await expect(closing).rejects.toThrow(/recovery/); expect(f.close).not.toHaveBeenCalled();
});
it("allows a corrected recovery copy to be revalidated without acknowledging an invented save failure", async () => {
  const f = fixture();
  f.view.renderOwner = new RenderOwnership().create(f.view, { preflightClose: () => f.view.assertNativeCloseReady(), prepareClose: () => f.view.prepareCloseNative(), validateClose: () => f.view.validateRecoveryReceipt(), failureKey: "markdown-save", close: f.close });
  f.changeCopy("invalidated copy"); await expect(f.view.onClose()).rejects.toThrow(/recovery/);
  f.changeCopy("retained local");
  await f.view.onClose(); expect(f.close).toHaveBeenCalledOnce(); expect(f.vault.modify).not.toHaveBeenCalled();
});
it("revalidates a repaired exact device record without a save acknowledgment", async () => {
  const f = fixture(); const key = "synthetic recovery"; const record = JSON.stringify({ vaultId: f.vault.root, path: f.source.path, text: "retained local" }); let stored = "invalidated";
  vi.stubGlobal("localStorage", { getItem: () => stored });
  f.view.recoveryReceipt.destination = { kind: "device", key, record };
  await expect(f.view.onClose()).rejects.toThrow(/record changed/); expect(f.view.renderOwner.hasUnacknowledgedWrites).toBe(false); expect(f.close).not.toHaveBeenCalled();
  stored = record; await f.view.onClose(); expect(f.close).toHaveBeenCalledOnce(); expect(f.vault.modify).not.toHaveBeenCalled();
});
