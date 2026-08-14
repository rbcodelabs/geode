import { valueToDisplayString } from "../coerce";
import { evaluateArgs } from "../evaluator";
import { bool, nullValue } from "../value";
import { MethodFn } from "./any-methods";

export const REGEXP_METHODS: Record<string, MethodFn> = {
  matches: (target, args, ctx) => {
    if (target.type !== "regexp") return nullValue();
    const [strArg] = evaluateArgs(args, ctx);
    if (!strArg) return bool(false);
    try {
      const re = new RegExp(target.value.source, target.value.flags);
      return bool(re.test(valueToDisplayString(strArg)));
    } catch {
      return bool(false);
    }
  },
};
