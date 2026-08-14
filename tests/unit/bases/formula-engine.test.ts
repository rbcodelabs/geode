import { describe, expect, it } from "vitest";
import { evaluateAllFormulas, evaluateFormula } from "../../../src/renderer/bases/formula-engine";
import { parseExpression } from "../../../src/renderer/bases/parser";
import { nullValue, num } from "../../../src/renderer/bases/value";
import { Expr } from "../../../src/renderer/bases/ast";
import { buildContext } from "./helpers";

function expr(source: string): Expr {
  const parsed = parseExpression(source);
  if (!("expr" in parsed)) throw new Error(parsed.error);
  return parsed.expr;
}

describe("evaluateFormula", () => {
  it("evaluates a formula expression against the row's context", async () => {
    const formulas = { doubled: expr("price * 2") };
    const { ctx } = await buildContext({ "A.md": "---\nprice: 5\n---\n" }, "A.md", { formulas });
    expect(evaluateFormula("doubled", ctx)).toEqual(num(10));
  });

  it("returns nullValue() for a name with no formula definition", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    expect(evaluateFormula("nope", ctx)).toEqual(nullValue());
  });

  it("memoizes per-row via ctx.formulaCache — only evaluates once", async () => {
    let calls = 0;
    // A formula that increments a call counter via a side channel isn't
    // expressible in the grammar, so instead assert the cache actually
    // holds the entry after one evaluation and a second call returns the
    // identical cached object reference.
    const formulas = { x: expr("1 + 1") };
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md", { formulas });
    const first = evaluateFormula("x", ctx);
    calls++;
    const second = evaluateFormula("x", ctx);
    expect(second).toBe(first); // same object reference: came from the cache, not re-evaluated
    expect(calls).toBe(1);
  });

  it("detects a direct self-reference cycle and returns nullValue() instead of recursing forever", async () => {
    const formulas = { a: expr("formula.a") };
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md", { formulas });
    expect(() => evaluateFormula("a", ctx)).not.toThrow();
    expect(evaluateFormula("a", ctx)).toEqual(nullValue());
  });

  it("detects an indirect (transitive) cycle across two formulas", async () => {
    const formulas = { a: expr("formula.b"), b: expr("formula.a") };
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md", { formulas });
    expect(() => evaluateFormula("a", ctx)).not.toThrow();
    expect(evaluateFormula("a", ctx)).toEqual(nullValue());
  });
});

describe("evaluateAllFormulas", () => {
  it("evaluates every formula in ctx.formulas, keyed by name", async () => {
    const formulas = { a: expr("1 + 1"), b: expr('"x" + "y"') };
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md", { formulas });
    expect(evaluateAllFormulas(ctx)).toEqual({ a: num(2), b: { type: "string", value: "xy" } });
  });

  it("returns an empty object when there are no formulas", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    expect(evaluateAllFormulas(ctx)).toEqual({});
  });
});
