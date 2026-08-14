import { Expr } from "./ast";
import { EvalContext } from "./eval-context";
import { evaluate } from "./evaluator";
import { BaseValue, listValue } from "./value";

/**
 * Evaluate a custom summary formula, binding the `values` keyword (the
 * column's visible values) as a local in an extended context — the same
 * `locals` mechanism list-method lambdas use for `value`/`index`/`acc`.
 */
export function evaluateSummary(node: Expr, columnValues: BaseValue[], ctx: EvalContext): BaseValue {
  const summaryCtx: EvalContext = { ...ctx, locals: { ...ctx.locals, values: listValue(columnValues) } };
  return evaluate(node, summaryCtx);
}
