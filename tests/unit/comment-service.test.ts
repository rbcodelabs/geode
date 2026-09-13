import { describe, expect, it, vi } from "vitest";
import { CommentService, StaleCommentWriteError } from "../../src/renderer/comments/service";
import { parseCommentThreads } from "../../src/renderer/comments/model";
import type { TFile } from "../../src/renderer/types";

const file = { kind: "file", path: "Note.md", name: "Note.md", basename: "Note", extension: "md", parent: "", ctime: 1, mtime: 1, size: 11 } as TFile;

function harness(initial = "Hello world") {
  let text = initial;
  const vault = {
    cachedRead: vi.fn(async () => text),
    getCachedContent: vi.fn(() => text),
    modify: vi.fn(async (_file: TFile, next: string) => { text = next; }),
  };
  const service = new CommentService(vault as never);
  return { service, vault, text: () => text, external: (next: string) => { text = next; } };
}

describe("CommentService", () => {
  it("creates, lists, replies, edits, resolves, reopens, and deletes a thread", async () => {
    const h = harness();
    const changed = vi.fn();
    h.service.on("changed", changed);
    const thread = await h.service.create(file, { from: 0, to: 5 }, "  first  ", { type: "user", name: "Rick" });
    expect(thread.messages[0].body).toBe("first");
    expect(h.service.list(file)).toHaveLength(1);

    const reply = await h.service.reply(file, thread.id, "reply", { type: "agent", name: "Claude" });
    await h.service.editMessage(file, thread.id, reply.id, "edited");
    await h.service.resolve(file, thread.id);
    expect(h.service.list(file)).toEqual([]);
    expect(h.service.list(file, { includeResolved: true })[0]).toMatchObject({ resolvedAt: expect.any(String) });
    const writesAfterResolve = h.vault.modify.mock.calls.length;
    await h.service.resolve(file, thread.id);
    expect(h.vault.modify).toHaveBeenCalledTimes(writesAfterResolve);
    await h.service.reopen(file, thread.id);
    await h.service.deleteMessage(file, thread.id, reply.id);
    await h.service.deleteMessage(file, thread.id, thread.messages[0].id);
    expect(parseCommentThreads(h.text()).threads).toEqual([]);
    expect(h.text()).toBe("Hello world");
    expect(changed).toHaveBeenCalled();
  });

  it("rejects blank and oversized content without changing the file", async () => {
    const h = harness();
    await expect(h.service.create(file, { from: 0, to: 5 }, "  ", { type: "user", name: "Rick" })).rejects.toThrow("blank");
    await expect(h.service.create(file, { from: 0, to: 5 }, "x".repeat(20_001), { type: "user", name: "Rick" })).rejects.toThrow("20,000");
    expect(h.vault.modify).not.toHaveBeenCalled();
  });

  it("serializes same-file mutations", async () => {
    const h = harness();
    const thread = await h.service.create(file, { from: 0, to: 5 }, "one", { type: "user", name: "Rick" });
    await Promise.all([
      h.service.reply(file, thread.id, "two", { type: "user", name: "Rick" }),
      h.service.reply(file, thread.id, "three", { type: "agent", name: "Claude" }),
    ]);
    expect(h.service.list(file)[0].messages.map((message) => message.body)).toEqual(["one", "two", "three"]);
  });

  it("drains admitted writes and rejects new comments until every sync hold releases", async () => {
    const h = harness();
    let finish!: () => void;
    h.vault.modify.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); });
    const write = h.service.create(file, { from: 0, to: 5 }, "first", { type: "agent", name: "Test" }).catch(() => undefined);
    await vi.waitFor(() => expect(h.vault.modify).toHaveBeenCalledOnce());
    let drained = false;
    const hold = h.service.holdMutations("first").then(() => { drained = true; });
    const second = h.service.holdMutations("second");
    await expect(h.service.create(file, { from: 0, to: 5 }, "blocked", { type: "agent", name: "Test" })).rejects.toThrow("paused");
    expect(drained).toBe(false);
    finish();
    await Promise.all([write, hold, second]);
    expect(drained).toBe(true);
    h.service.releaseMutationHold("first");
    await expect(h.service.create(file, { from: 0, to: 5 }, "still blocked", { type: "agent", name: "Test" })).rejects.toThrow("paused");
    h.service.releaseMutationHold("second");
    await h.service.create(file, { from: 0, to: 5 }, "allowed", { type: "agent", name: "Test" });
    expect(h.vault.modify).toHaveBeenCalledTimes(2);
  });

  it("routes through an open editor when available", async () => {
    let editorText = "Hello world";
    const apply = vi.fn(async (mutator: (source: string) => string) => { editorText = mutator(editorText); });
    const service = new CommentService({ cachedRead: vi.fn(), modify: vi.fn() } as never, () => ({
      getText: () => editorText,
      applyCommentMutation: apply,
    }));
    await service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" });
    expect(apply).toHaveBeenCalledOnce();
    expect(parseCommentThreads(editorText).threads).toHaveLength(1);
  });

  it("rejects a closed-file write when the source changes before commit", async () => {
    const h = harness();
    h.vault.cachedRead.mockImplementationOnce(async () => "Hello world").mockImplementationOnce(async () => "Externally changed");
    await expect(h.service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" })).rejects.toBeInstanceOf(StaleCommentWriteError);
    expect(h.vault.modify).not.toHaveBeenCalled();
  });

  it("bypasses the warmed Vault cache for the stale-write guard", async () => {
    let cached = "Hello world";
    let provider = "Hello world";
    const vault = {
      cachedRead: vi.fn(async () => cached),
      read: vi.fn(async () => provider),
      modify: vi.fn(async (_file: TFile, next: string) => { cached = provider = next; }),
    };
    const service = new CommentService(vault as never);
    provider = "External provider edit";
    await expect(service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" })).rejects.toBeInstanceOf(StaleCommentWriteError);
    expect(vault.read).toHaveBeenCalledOnce();
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("prefers the current Vault cache over its mutation fallback after an external edit", async () => {
    let current = "Hello world";
    const vault = {
      cachedRead: vi.fn(async () => current),
      read: vi.fn(async () => current),
      getCachedContent: vi.fn(() => current),
      modify: vi.fn(async (_file: TFile, next: string) => { current = next; }),
    };
    const service = new CommentService(vault as never);
    await service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" });

    current = "External plain text";

    expect(service.list(file, { includeResolved: true })).toEqual([]);
    expect(service.inspect(file)).toEqual({ threads: [], errors: [] });
  });

  it("does not resurrect mutation fallback content after an external edit evicts the Vault cache", async () => {
    let cached: string | undefined = "Hello world";
    let provider = cached;
    const vault = {
      cachedRead: vi.fn(async () => cached ?? provider),
      read: vi.fn(async () => provider),
      getCachedContent: vi.fn(() => cached),
      modify: vi.fn(async (_file: TFile, next: string) => { cached = provider = next; }),
    };
    const service = new CommentService(vault as never);
    await service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" });
    expect(service.list(file, { includeResolved: true })).toHaveLength(1);

    provider = "External plain text";
    cached = undefined;

    expect(service.list(file, { includeResolved: true })).toEqual([]);
    expect(service.inspect(file)).toEqual({ threads: [], errors: [] });
  });

  it("reattaches a detached thread to a valid new selection", async () => {
    const h = harness();
    const thread = await h.service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" });
    h.external(h.text().replace("Hello", ""));
    await h.service.reattach(file, thread.id, { from: h.text().indexOf("world"), to: h.text().indexOf("world") + 5 });
    expect(h.service.list(file)[0]).toMatchObject({ anchorText: "world", detached: false });
  });

  it("rejects a reattachment selection that crosses the detached marker pair", async () => {
    const h = harness();
    const thread = await h.service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" });
    h.external(h.text().replace("Hello", ""));
    await expect(h.service.reattach(file, thread.id, { from: 0, to: h.text().length })).rejects.toThrow("cross");
  });
});
