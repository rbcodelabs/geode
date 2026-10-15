import { expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
it.each([["B.md", false], ["A.md", false], ["B.md", true], ["A.md", true]] as const)("keeps a newer %s cell draft owned while an older row save fails=%s", async (newerPath, rejected) => {
  const view = Object.create(BaseView.prototype) as any;
  const owner = new RenderOwnership().create(view, { writer: view, preflightClose: () => view.assertWorkspaceLoadReady() });
  let finish!: () => void;
  Object.assign(view, { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, renderOwner: owner, vaultSwitching: false, sourceConflictReadOnly: false, persistRequestedWhileSuspended: false, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), tableView: { editIdentity: null }, setSaveStatus: vi.fn(), runAndRender: vi.fn(), app: { vault: { read: async () => "---\npriority: 2\n---\n", modify: vi.fn(() => new Promise<void>((resolve, reject) => { finish = () => rejected ? reject(new Error("old save rejected")) : resolve(); })) } } });
  const file = { path: "A.md" };
  view.app.vault.getAbstractFileByPath = (path: string) => path === file.path ? file : null;
  view.beginSourceEdit(file, "note.priority", "9");
  const saving = view.editCell(file, "note.priority", "9");
  await new Promise(resolve => setImmediate(resolve)); expect(view.app.vault.modify).toHaveBeenCalledOnce();
  view.beginSourceEdit({ path: newerPath }, "note.priority", "10"); const newer = view.sourceEdit;
  finish(); if (rejected) await expect(saving).rejects.toThrow("old save rejected"); else await saving;
  expect(view.sourceEdit).toBe(newer); expect(view.runAndRender).not.toHaveBeenCalled();
  expect(() => owner.assertRetirementReady()).toThrow(/draft/);
});

it("acknowledges persisted row bytes when only the subsequent projection refresh fails", async () => {
  const view = Object.create(BaseView.prototype) as any;
  const owner = new RenderOwnership().create(view); const modify = vi.fn(async () => {});
  Object.assign(view, { file: null, rowFailures: new Map(), retainedNativeFailures: [], rowSubmissionSequence: 0, renderOwner: owner, vaultSwitching: false, sourceEdit: null, sourcePersistsInFlight: new Set(), sourcePersistPaths: new Map(), tableView: { editIdentity: null }, setSaveStatus: vi.fn(), runAndRender: () => { throw new Error("query failed"); }, app: { notify: vi.fn(), vault: { read: async () => "---\npriority: 2\n---\n", modify } } });
  const file = { path: "A.md" };
  view.app.vault.getAbstractFileByPath = (path: string) => path === file.path ? file : null;
  await expect(view.editCell(file, "note.priority", "9")).resolves.toBeUndefined();
  expect(modify).toHaveBeenCalledOnce(); expect(owner.hasUnacknowledgedWrites).toBe(false);
  expect(view.setSaveStatus).toHaveBeenLastCalledWith(expect.stringMatching(/saved.*refresh/i), true);
});
