import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("document", { body: {}, activeElement: null });
  const source = { path: "Outer.md" }; const copy = { path: "Outer conflict.md" }; let local = "captured local";
  const vault = { root: "/synthetic", getAbstractFileByPath: () => null, getFileByPath: (path: string) => path === source.path ? source : copy, create: vi.fn(async (_path: string, _text: string) => copy), read: vi.fn(async () => "captured local"), modify: vi.fn() };
  const app = Object.assign(Object.create(App.prototype), { vault, notify: vi.fn(), host: { vaultFiles: { read: async () => "provider" } } }) as any;
  const view = Object.assign(Object.create(MarkdownView.prototype), { app, file: source, mode: "source", transitionTail: Promise.resolve(), transitionGeneration: 0, lastSavedText: "provider", saveTimer: null, flushInFlight: null, editor: { state: { doc: { toString: () => local } } }, pagePreview: { hide() {} }, applyMode() {}, buildEditor: (text: string) => { local = text; }, presentConflict: vi.fn(() => { view.conflictReadOnly = true; view.recoveryReceipt = null; }) }) as any;
  view.renderOwner = new RenderOwnership().create(view, { prepareClose: () => view.prepareCloseNative() });
  app.workspace = { findLeafForFile: () => ({ view }), findLeafForView: () => null };
  const storage: Record<string, any> = {};
  Object.defineProperties(storage, { getItem: { value: (key: string) => storage[key] ?? null }, setItem: { value: (key: string, value: string) => { storage[key] = value; } } });
  vi.stubGlobal("localStorage", storage);
  return { app, view, vault, source, copy, storage, changeLocal: (text: string) => { local = text; } };
}
it("mints a conflict-copy receipt from the actual preserved snapshot, not newer live text", async () => {
  const f = fixture(); let finish!: (copy: unknown) => void;
  f.vault.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }) as any);
  const preserving = f.app.prepareConflict(f.view, f.source, "provider", f.source.path);
  f.changeLocal("newer local"); finish(f.copy); const present = await preserving; present();
  expect(f.vault.create.mock.calls[0][1]).toBe("captured local"); expect(f.view.recoveryReceipt.localText).toBe("captured local");
  await expect(f.view.onClose()).rejects.toThrow(/recovery/); expect(f.vault.modify).not.toHaveBeenCalled();
});
it("mints device evidence only after the actual fallback record is stored and read back", async () => {
  const f = fixture(); f.vault.create.mockRejectedValue(new Error("copy unavailable"));
  await expect(f.app.prepareConflict(f.view, f.source, "provider", f.source.path)).rejects.toThrow("copy unavailable");
  expect(f.view.recoveryReceipt.destination.kind).toBe("device"); await f.view.onClose(); expect(f.vault.modify).not.toHaveBeenCalled();
});
it("restores and confirms the exact existing device record before ordinary close", async () => {
  const f = fixture(); const key = `geode:conflict-recovery:${encodeURIComponent(f.vault.root)}:${encodeURIComponent(f.source.path)}`;
  f.storage[key] = JSON.stringify({ vaultId: f.vault.root, path: f.source.path, text: "recovered local" });
  await f.app.restoreConflictRecovery();
  expect(f.view.getText()).toBe("recovered local"); expect(f.view.recoveryReceipt.localText).toBe("recovered local");
  await f.view.onClose(); expect(f.vault.modify).not.toHaveBeenCalled();
});
