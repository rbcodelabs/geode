import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { MarkdownView } from "../../src/renderer/views/markdown-view";

it.each([false, true])("rechecks an overtaken own-write read and preserves a genuine external edit: %s", async (external) => {
  const file = { path: "Note.md" };
  let saved = "first comment";
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    file,
    getLastKnownText: () => saved,
    hasUnacknowledgedChanges: () => true,
    acceptExternalText: vi.fn(),
  });
  const read = vi.fn().mockImplementationOnce(async () => {
    saved = "first comment and reply";
    return "first comment";
  }).mockResolvedValue(external ? "remote edit" : "first comment and reply");
  const app = Object.assign(Object.create(App.prototype), {
    workspace: { findLeafForFile: () => ({ view }) },
    host: { vaultFiles: { read } },
    preserveConflict: vi.fn(),
  });
  await app.processExternalModify(file);
  if (external) expect(app.preserveConflict).toHaveBeenCalledWith(view, file, "remote edit", file.path);
  else expect(app.preserveConflict).not.toHaveBeenCalled();
  expect(view.acceptExternalText).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
});

it("waits for a pending own write before reading disk to classify a modification", async () => {
  const file = { path: "Note.md" };
  let disk = "first comment";
  let finish!: () => void;
  const write = new Promise<void>(resolve => { finish = () => { disk = "first comment and reply"; resolve(); }; });
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    file,
    flushInFlight: write,
    getLastKnownText: () => "first comment and reply",
    hasUnacknowledgedChanges: () => true,
    acceptExternalText: vi.fn(),
  });
  const read = vi.fn(async () => disk);
  const app = Object.assign(Object.create(App.prototype), {
    workspace: { findLeafForFile: () => ({ view }) },
    host: { vaultFiles: { read } },
    preserveConflict: vi.fn(),
  });
  const processing = app.processExternalModify(file);
  await Promise.resolve();
  const readBeforeSave = read.mock.calls.length;
  finish();
  await processing;
  expect(readBeforeSave).toBe(0);
  expect(app.preserveConflict).not.toHaveBeenCalled();
});

it("does not apply an old file read to a view reused for another note", async () => {
  const file = { path: "Old.md" };
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    file,
    getLastKnownText: () => "unchanged",
    hasUnacknowledgedChanges: () => false,
    acceptExternalText: vi.fn(),
  });
  const app = Object.assign(Object.create(App.prototype), {
    workspace: { findLeafForFile: () => ({ view }) },
    host: { vaultFiles: { read: async () => { view.file = { path: "New.md" }; return "old note remote edit"; } } },
    preserveConflict: vi.fn(),
  });
  await app.processExternalModify(file);
  expect(view.acceptExternalText).not.toHaveBeenCalled();
  expect(app.preserveConflict).not.toHaveBeenCalled();
});
