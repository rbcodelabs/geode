import { expect, it, vi } from "vitest";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import { BaseView } from "../../src/renderer/views/base-view";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it("a successful retry acknowledges only failures captured at admission, preserving a same-key failure arriving before completion", async () => {
  const scope = new RenderOwnership().create({});
  const original = new Error("original failure"), later = new Error("later failure");
  await expect(scope.run(async () => { throw original; }, "row")).rejects.toBe(original);
  const gate = deferred();
  const retry = scope.retry(() => gate.promise, "row");
  await tick();
  await expect(scope.run(async () => { throw later; }, "row")).rejects.toBe(later);
  gate.resolve(); await retry;
  expect(scope.hasUnacknowledgedWrites).toBe(true);
  await expect(scope.close()).rejects.toBe(later);
  await scope.retry(async () => {}, "row");
  await expect(scope.close()).resolves.toBeUndefined();
});

it("Base keeps a newer indexed-target guard failure when an already dispatched same-key retry subsequently succeeds", async () => {
  const file = { path: "Source.md" };
  const files = new Map([[file.path, file]]);
  const gate = deferred();
  const modify = vi.fn().mockRejectedValueOnce(new Error("initial write failed")).mockImplementationOnce(() => gate.promise);
  const vault = { getAbstractFileByPath: (path: string) => files.get(path) ?? null, read: vi.fn(async () => "---\npriority: 2\n---\nBody\n"), modify };
  const view = Object.create(BaseView.prototype) as any;
  const owner = new RenderOwnership().create(view);
  Object.assign(view, {
    file: null, renderOwner: owner, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0,
    sourceEdit: null, vaultSwitching: false, sourceConflictReadOnly: false,
    sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), tableView: { editIdentity: null },
    setSaveStatus: vi.fn(), runAndRender: vi.fn(), app: { vault, notify: vi.fn() },
  });
  await expect(view.editCell(file, "note.priority", "9")).rejects.toThrow("initial write failed");
  const retry = view.editCell(file, "note.priority", "10");
  await tick(); expect(modify).toHaveBeenCalledTimes(2);
  // This fails before joining the shared lane. No overlapping participating
  // read/write or cancellation of the already dispatched modify is asserted.
  files.set(file.path, { path: file.path });
  await expect(view.editCell(file, "note.priority", "11")).rejects.toThrow(/target changed/);
  gate.resolve(); await retry;
  expect(vault.read).toHaveBeenCalledTimes(2);
  expect(modify).toHaveBeenCalledTimes(2);
  expect([...view.rowFailures.values()].map((failure: any) => failure.rawText)).toEqual(["11"]);
  expect(owner.hasUnacknowledgedWrites).toBe(true);
  await expect(owner.close()).rejects.toThrow(/target changed/);
});
