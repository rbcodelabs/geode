import { describe, expect, it, vi } from "vitest";
import { CommentService, StaleCommentWriteError } from "../../src/renderer/comments/service";
import { parseCommentThreads } from "../../src/renderer/comments/model";
import type { TFile } from "../../src/renderer/types";

const file = { kind: "file", path: "Note.md", name: "Note.md", basename: "Note", extension: "md", parent: "", ctime: 1, mtime: 1, size: 11 } as TFile;

function harness(initial = "Hello world") {
  let text = initial;
  const vault = {
    cachedRead: vi.fn(async () => text),
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

  it("reattaches a detached thread to a valid new selection", async () => {
    const h = harness();
    const thread = await h.service.create(file, { from: 0, to: 5 }, "note", { type: "user", name: "Rick" });
    h.external(h.text().replace("Hello", ""));
    await h.service.reattach(file, thread.id, { from: h.text().indexOf("world"), to: h.text().indexOf("world") + 5 });
    expect(h.service.list(file)[0]).toMatchObject({ anchorText: "world", detached: false });
  });
});
