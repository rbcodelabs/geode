import { describe, expect, it } from "vitest";
import { evaluateSummary } from "../../../src/renderer/bases/summary-engine";
import { parseExpression } from "../../../src/renderer/bases/parser";
import { num, str } from "../../../src/renderer/bases/value";
import { buildContext } from "./helpers";

function expr(source: string) {
  const parsed = parseExpression(source);
  if (!("expr" in parsed)) throw new Error(parsed.error);
  return parsed.expr;
}

describe("evaluateSummary", () => {
  it("binds `values` to the given column values and evaluates the formula", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    const result = evaluateSummary(expr("values.length"), [num(1), num(2), num(3)], ctx);
    expect(result).toEqual(num(3));
  });

  it("supports chaining methods on `values`, e.g. a custom join summary", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    const result = evaluateSummary(expr('values.join(", ")'), [str("a"), str("b")], ctx);
    expect(result).toEqual(str("a, b"));
  });

  it("does not leak the `values` binding back into the outer context's locals", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    evaluateSummary(expr("values.length"), [num(1)], ctx);
    expect(ctx.locals.values).toBeUndefined();
  });

  it("supports a reduce-based custom summary (sum)", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    const result = evaluateSummary(expr("values.reduce(acc + value, 0)"), [num(1), num(2), num(3)], ctx);
    expect(result).toEqual(num(6));
  });
});
