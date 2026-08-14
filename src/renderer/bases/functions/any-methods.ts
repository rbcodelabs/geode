import { Expr } from "../ast";
import { isTruthy, valueToDisplayString } from "../coerce";
import { EvalContext } from "../eval-context";
import { evaluate } from "../evaluator";
import { BaseValue, bool, str } from "../value";

/** `(target, args, ctx) => BaseValue` — args are raw AST, evaluated on demand (see functions/index.ts). */
export type MethodFn = (target: BaseValue, args: Expr[], ctx: EvalContext) => BaseValue;

/**
 * Methods available on every `BaseValue` type, checked before the
 * per-type table in `dispatchMethod` — per the spec's "Any type" section.
 */
export const ANY_METHODS: Record<string, MethodFn> = {
  isTruthy: (target) => bool(isTruthy(target)),
  isType: (target, args, ctx) => {
    const typeArg = args[0] ? evaluate(args[0], ctx) : null;
    if (!typeArg || typeArg.type !== "string") return bool(false);
    return bool(target.type === typeArg.value);
  },
  // Explicit `BaseValue` annotation: "toString" is also a well-known
  // Object.prototype member, which makes TS infer this object-literal
  // property against `Object.prototype.toString`'s `(): string` signature
  // instead of the surrounding `Record<string, MethodFn>` index signature —
  // silently making `target` an implicit `any` without this.
  toString: (target: BaseValue) => str(valueToDisplayString(target)),
};
