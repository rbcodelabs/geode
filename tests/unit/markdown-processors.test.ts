import { describe, expect, it } from "vitest";
import {
  MarkdownProcessorRegistry,
  type MarkdownPostProcessor,
} from "../../src/renderer/markdown/processor-registry";

/**
 * Build a post-processor stub with a given (starting) sortOrder. Records the
 * order it ran in when invoked, into the shared `ran` array.
 */
function makePost(label: string, sortOrder: number, ran: string[]): MarkdownPostProcessor {
  const fn = (() => {
    ran.push(label);
  }) as unknown as MarkdownPostProcessor;
  fn.sortOrder = sortOrder;
  return fn;
}

describe("MarkdownProcessorRegistry", () => {
  describe("code-block processors", () => {
    it("registers, looks up, and reports presence by language", () => {
      const reg = new MarkdownProcessorRegistry();
      expect(reg.hasCodeBlocks()).toBe(false);
      const handler = () => {};
      reg.registerCodeBlock("tasks", handler);
      expect(reg.hasCodeBlocks()).toBe(true);
      expect(reg.getCodeBlock("tasks")).toBe(handler);
      expect(reg.getCodeBlock("dataview")).toBeUndefined();
    });

    it("unregisters a language and goes empty again", () => {
      const reg = new MarkdownProcessorRegistry();
      const handler = () => {};
      reg.registerCodeBlock("tasks", handler);
      reg.unregisterCodeBlock("tasks", handler);
      expect(reg.getCodeBlock("tasks")).toBeUndefined();
      expect(reg.hasCodeBlocks()).toBe(false);
    });

    it("does not clobber a language claimed by a later registration when an earlier handler unregisters", () => {
      // Edge case: two plugins claim the same language; the first to unload
      // must not remove the second's live handler.
      const reg = new MarkdownProcessorRegistry();
      const first = () => {};
      const second = () => {};
      reg.registerCodeBlock("tasks", first);
      reg.registerCodeBlock("tasks", second); // second wins
      reg.unregisterCodeBlock("tasks", first); // stale unload from the first
      expect(reg.getCodeBlock("tasks")).toBe(second);
    });
  });

  describe("post processors", () => {
    it("runs in ascending sortOrder regardless of registration order", () => {
      const reg = new MarkdownProcessorRegistry();
      const ran: string[] = [];
      reg.registerPostProcessor(makePost("c", 100, ran), 100);
      reg.registerPostProcessor(makePost("a", 0, ran), 0);
      reg.registerPostProcessor(makePost("b", 50, ran), 50);

      const order = reg.postProcessorsInOrder();
      expect(order.map((p) => p.sortOrder)).toEqual([0, 50, 100]);
      for (const p of order) (p as unknown as () => void)();
      expect(ran).toEqual(["a", "b", "c"]);
    });

    it("keeps equal sortOrders in registration order (stable) and defaults sortOrder to 0", () => {
      const reg = new MarkdownProcessorRegistry();
      const ran: string[] = [];
      const first = makePost("first", 0, ran);
      const second = makePost("second", 0, ran);
      reg.registerPostProcessor(first); // default sortOrder 0
      reg.registerPostProcessor(second, 0);

      expect(first.sortOrder).toBe(0);
      const order = reg.postProcessorsInOrder();
      expect(order).toEqual([first, second]);
    });

    it("unregisters only the given processor, leaving the rest ordered", () => {
      const reg = new MarkdownProcessorRegistry();
      const ran: string[] = [];
      const a = makePost("a", 0, ran);
      const b = makePost("b", 10, ran);
      const c = makePost("c", 20, ran);
      reg.registerPostProcessor(a, 0);
      reg.registerPostProcessor(b, 10);
      reg.registerPostProcessor(c, 20);

      reg.unregisterPostProcessor(b);
      expect(reg.postProcessorsInOrder()).toEqual([a, c]);

      // Unregistering something never registered is a harmless no-op.
      reg.unregisterPostProcessor(makePost("x", 5, ran));
      expect(reg.postProcessorsInOrder()).toEqual([a, c]);
    });
  });
});
