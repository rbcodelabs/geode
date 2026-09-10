import { expect, it, vi } from "vitest";
import { MarkdownView } from "../../src/renderer/views/markdown-view";

it.each(["vaultSwitching", "conflictReadOnly"])("rejects direct comment mutation while %s without touching the editor", async (flag) => {
  const transform = vi.fn(() => "commented");
  const dispatch = vi.fn();
  const flush = vi.fn(async () => {});
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    [flag]: true,
    editor: { state: { doc: { toString: () => "original" } }, dispatch },
    flush,
  });
  await expect(view.applyCommentMutation(transform)).rejects.toThrow(/paused|read.only/i);
  expect(transform).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});
