import { expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
function fixture() {
  const view = Object.create(BaseView.prototype) as any;
  const writes: { resolve(): void; reject(error: Error): void }[] = [];
  const owner = new RenderOwnership().create(view, { recover: failures => view.recoverNativeWrites(failures) });
  Object.assign(view, { file: { path: "Tasks.base" }, renderOwner: owner, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, sourceEdit: null, vaultSwitching: false, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), tableView: { editIdentity: null, acknowledgeEdit: vi.fn() }, setSaveStatus: vi.fn(), runAndRender: vi.fn(), app: { notify: vi.fn(), vault: { read: async () => "---\npriority: 2\n---\nOriginal source\n", modify: vi.fn(() => new Promise<void>((resolve, reject) => writes.push({ resolve, reject }))) } } });
  const file = { path: "A.md" };
  async function start(path = file, column = "note.priority", text = "9") { const saving = view.editCell(path, column, text); await new Promise(resolve => setImmediate(resolve)); return { saving, write: writes.at(-1)! }; }
  async function fail(path = file, column = "note.priority") { const pending = await start(path, column); pending.write.reject(new Error("disk rejected")); await expect(pending.saving).rejects.toThrow("disk rejected"); }
  return { view, owner, file, start, fail };
}
it("ordinary successful resubmission acknowledges its captured exact row failure", async () => {
  const { view, owner, start, fail } = fixture(); await fail(); expect(owner.hasUnacknowledgedWrites).toBe(true);
  const pending = await start(undefined, undefined, "10"); pending.write.resolve(); await pending.saving;
  expect(owner.hasUnacknowledgedWrites).toBe(false); expect(view.rowFailures.size).toBe(0);
});
it("recovery targets failed A while newer B remains owned, and refuses retrying A over B", async () => {
  const { view, owner, file, start } = fixture(); view.beginSourceEdit(file, "note.priority", "9");
  const pending = await start(); view.beginSourceEdit({ path: "B.md" }, "note.priority", "10"); const draft = view.sourceEdit;
  pending.write.reject(new Error("disk rejected")); await expect(pending.saving).rejects.toThrow();
  const recovery = view.setSaveStatus.mock.calls.at(-1)!;
  expect(recovery[3]).toEqual({ file, columnPath: "note.priority" });
  await recovery[2](); expect(view.app.vault.modify).toHaveBeenCalledOnce(); expect(view.sourceEdit).toBe(draft); expect(owner.hasUnacknowledgedWrites).toBe(true);
});
it("a successful A resubmission preserves other-column, other-file and definition failures", async () => {
  const { view, owner, start, fail } = fixture(); await fail(); await fail(undefined, "note.other"); await fail({ path: "B.md" });
  await expect(owner.run(async () => { throw new Error("definition rejected"); }, "definition")).rejects.toThrow();
  const pending = await start(); pending.write.resolve(); await pending.saving;
  expect(owner.hasUnacknowledgedWrites).toBe(true); expect(view.rowFailures.size).toBe(2);
  expect(view.setSaveStatus.mock.calls.at(-1)?.[3]).toBeUndefined();
});
it("a failure arriving after same-key retry admission survives that successful retry", async () => {
  const { view, owner, start, fail } = fixture(); await fail(); const retry = await start(); const later = await start(undefined, undefined, "11");
  later.write.reject(new Error("later rejected")); await expect(later.saving).rejects.toThrow(); retry.write.resolve(); await retry.saving;
  expect(owner.hasUnacknowledgedWrites).toBe(true); expect([...view.rowFailures.values()][0].rawText).toBe("11");
});
it("a retained recovery callback cannot write after its Base file identity changes", async () => {
  const { view, fail } = fixture(); await fail(); const retry = view.setSaveStatus.mock.calls.at(-1)![2]; view.file = { path: "Other.base" };
  await retry(); expect(view.app.vault.modify).toHaveBeenCalledOnce();
});
it("a recovery presentation exception cannot turn acknowledged bytes into a failed write", async () => {
  const { view, owner, start } = fixture(); view.setSaveStatus.mockImplementation((message: string) => { if (message === "Base saved") throw new Error("projection unavailable"); });
  const pending = await start(); pending.write.resolve(); await expect(pending.saving).resolves.toBeUndefined();
  expect(owner.hasUnacknowledgedWrites).toBe(false); expect(view.app.vault.modify).toHaveBeenCalledOnce();
});
it("cancel and unrelated success do not acknowledge an earlier failed row", async () => {
  const { view, owner, file, start, fail } = fixture(); view.beginSourceEdit(file, "note.priority", "9"); const identity = view.sourceEdit;
  await fail(); view.endSourceEdit(identity);
  const other = await start({ path: "B.md" }); other.write.resolve(); await other.saving;
  expect(owner.hasUnacknowledgedWrites).toBe(true); expect(view.rowFailures.size).toBe(1);
  expect(view.setSaveStatus.mock.calls.at(-1)?.[3]).toEqual({ file, columnPath: "note.priority" });
});
it.each(["rename", "conflict"])("refuses a %s introduced during the row read before any mutation", async change => {
  const { view, owner, file } = fixture(); let finish!: (text: string) => void;
  view.app.vault.read = () => new Promise<string>(resolve => { finish = resolve; });
  const saving = view.editCell(file, "note.priority", "9"); await Promise.resolve();
  if (change === "rename") file.path = "Renamed.md"; else view.sourceConflictReadOnly = true;
  finish("---\npriority: 2\n---\nOriginal source\n");
  await expect(saving).rejects.toThrow(/changed/); expect(view.app.vault.modify).not.toHaveBeenCalled(); expect(owner.hasUnacknowledgedWrites).toBe(true);
});
it("retains the newest failed value when an older same-key write fails later", async () => {
  const { view, start } = fixture(); const older = await start(); const newer = await start(undefined, undefined, "11");
  newer.write.reject(new Error("new rejected")); await expect(newer.saving).rejects.toThrow();
  older.write.reject(new Error("old rejected")); await expect(older.saving).rejects.toThrow();
  expect([...view.rowFailures.values()][0].rawText).toBe("11");
});
