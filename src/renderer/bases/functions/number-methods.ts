import { evaluateArgs } from "../evaluator";
import { bool, nullValue, num, str } from "../value";
import { MethodFn } from "./any-methods";

function asNumber(target: Parameters<MethodFn>[0]): number | null {
  return target.type === "number" ? target.value : null;
}

export const NUMBER_METHODS: Record<string, MethodFn> = {
  abs: (target) => {
    const n = asNumber(target);
    return n === null ? nullValue() : num(Math.abs(n));
  },

  ceil: (target) => {
    const n = asNumber(target);
    return n === null ? nullValue() : num(Math.ceil(n));
  },

  floor: (target) => {
    const n = asNumber(target);
    return n === null ? nullValue() : num(Math.floor(n));
  },

  // Judgment call: the spec doesn't define what "empty" means for a number
  // (unlike string/list, a number has no natural empty state); the closest
  // reading is "not a valid numeric value" — i.e. NaN.
  isEmpty: (target) => {
    const n = asNumber(target);
    return n === null ? nullValue() : bool(Number.isNaN(n));
  },

  round: (target, args, ctx) => {
    const n = asNumber(target);
    if (n === null) return nullValue();
    const [digitsArg] = evaluateArgs(args, ctx);
    const digits = digitsArg?.type === "number" ? digitsArg.value : 0;
    const factor = 10 ** digits;
    return num(Math.round(n * factor) / factor);
  },

  toFixed: (target, args, ctx) => {
    const n = asNumber(target);
    if (n === null) return nullValue();
    const [precisionArg] = evaluateArgs(args, ctx);
    const precision = precisionArg?.type === "number" ? precisionArg.value : 0;
    return str(n.toFixed(precision));
  },
};
