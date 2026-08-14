import { evaluateArgs } from "../evaluator";
import { bool, fileValue, nullValue } from "../value";
import { MethodFn } from "./any-methods";

export const LINK_METHODS: Record<string, MethodFn> = {
  asFile: (target) => {
    if (target.type !== "link") return nullValue();
    return target.value.resolved ? fileValue(target.value.resolved) : nullValue();
  },

  linksTo: (target, args, ctx) => {
    if (target.type !== "link") return nullValue();
    const [arg] = evaluateArgs(args, ctx);
    if (!arg) return bool(false);
    if (arg.type === "file") return bool(target.value.resolved?.path === arg.value.path);
    if (arg.type === "link") {
      return bool(!!target.value.resolved && !!arg.value.resolved && target.value.resolved.path === arg.value.resolved.path);
    }
    return bool(false);
  },
};
