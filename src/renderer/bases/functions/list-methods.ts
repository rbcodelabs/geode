import { compareValues, isTruthy, valueToDisplayString } from "../coerce";
import { EvalContext } from "../eval-context";
import { evaluate, evaluateArgs } from "../evaluator";
import { BaseValue, bool, listValue, nullValue, num, str } from "../value";
import { MethodFn } from "./any-methods";

function asList(target: BaseValue): BaseValue[] | null {
  return target.type === "list" ? target.value : null;
}

function equalsAny(item: BaseValue, needle: BaseValue): boolean {
  return isTruthy(compareValues(item, needle, "=="));
}

/** Binds `value`/`index` (and optionally `acc`) as locals for one lambda-body evaluation. */
function iterationContext(ctx: EvalContext, extra: Record<string, BaseValue>): EvalContext {
  return { ...ctx, locals: { ...ctx.locals, ...extra } };
}

export const LIST_METHODS: Record<string, MethodFn> = {
  length: (target) => {
    const l = asList(target);
    return l === null ? nullValue() : num(l.length);
  },

  contains: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const [needle] = evaluateArgs(args, ctx);
    return bool(!!needle && l.some((item) => equalsAny(item, needle)));
  },

  containsAll: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const values = evaluateArgs(args, ctx);
    return bool(values.every((v) => l.some((item) => equalsAny(item, v))));
  },

  containsAny: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const values = evaluateArgs(args, ctx);
    return bool(values.some((v) => l.some((item) => equalsAny(item, v))));
  },

  // vars: value, index
  filter: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const expr = args[0];
    if (!expr) return listValue(l);
    const out: BaseValue[] = [];
    l.forEach((value, index) => {
      const iterCtx = iterationContext(ctx, { value, index: num(index) });
      if (isTruthy(evaluate(expr, iterCtx))) out.push(value);
    });
    return listValue(out);
  },

  flat: (target) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const out: BaseValue[] = [];
    for (const item of l) {
      if (item.type === "list") out.push(...item.value);
      else out.push(item);
    }
    return listValue(out);
  },

  isEmpty: (target) => {
    const l = asList(target);
    return l === null ? nullValue() : bool(l.length === 0);
  },

  join: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const [sepArg] = evaluateArgs(args, ctx);
    const sep = sepArg?.type === "string" ? sepArg.value : ",";
    return str(l.map(valueToDisplayString).join(sep));
  },

  // vars: value, index
  map: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const expr = args[0];
    if (!expr) return listValue(l);
    return listValue(
      l.map((value, index) => evaluate(expr, iterationContext(ctx, { value, index: num(index) })))
    );
  },

  // vars: value, index, acc
  reduce: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const [expr, initialExpr] = args;
    if (!expr) return nullValue();
    let acc = initialExpr ? evaluate(initialExpr, ctx) : nullValue();
    l.forEach((value, index) => {
      acc = evaluate(expr, iterationContext(ctx, { value, index: num(index), acc }));
    });
    return acc;
  },

  reverse: (target) => {
    const l = asList(target);
    return l === null ? nullValue() : listValue([...l].reverse());
  },

  slice: (target, args, ctx) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const [startArg, endArg] = evaluateArgs(args, ctx);
    const start = startArg?.type === "number" ? startArg.value : undefined;
    const end = endArg?.type === "number" ? endArg.value : undefined;
    return listValue(l.slice(start, end));
  },

  sort: (target) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const sorted = [...l].sort((a, b) => {
      if (isTruthy(compareValues(a, b, "<"))) return -1;
      if (isTruthy(compareValues(a, b, ">"))) return 1;
      return 0;
    });
    return listValue(sorted);
  },

  unique: (target) => {
    const l = asList(target);
    if (l === null) return nullValue();
    const out: BaseValue[] = [];
    for (const item of l) {
      if (!out.some((o) => equalsAny(o, item))) out.push(item);
    }
    return listValue(out);
  },
};
