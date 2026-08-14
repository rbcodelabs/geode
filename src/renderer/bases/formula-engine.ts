import { EvalContext } from "./eval-context";
import { evaluate } from "./evaluator";
import { BaseValue, nullValue } from "./value";

/**
 * Lazily evaluate a named formula, memoized per-row via `ctx.formulaCache`
 * and cycle-guarded via `ctx.inProgress` — a formula that (directly or
 * transitively) references itself resolves to `nullValue()` rather than
 * recursing forever. Never throws (delegates to `evaluate`, which is total).
 */
export function evaluateFormula(name: string, ctx: EvalContext): BaseValue {
  const cached = ctx.formulaCache.get(name);
  if (cached !== undefined) return cached;

  if (ctx.inProgress.has(name)) return nullValue(); // cycle detected

  const expr = ctx.formulas[name];
  if (!expr) return nullValue();

  ctx.inProgress.add(name);
  try {
    const result = evaluate(expr, ctx);
    ctx.formulaCache.set(name, result);
    return result;
  } finally {
    ctx.inProgress.delete(name);
  }
}

/** Evaluate every formula defined on `ctx.formulas`, keyed by name. */
export function evaluateAllFormulas(ctx: EvalContext): Record<string, BaseValue> {
  const out: Record<string, BaseValue> = {};
  for (const name of Object.keys(ctx.formulas)) out[name] = evaluateFormula(name, ctx);
  return out;
}
