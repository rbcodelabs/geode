import { valueToDisplayString } from "../coerce";
import { evaluateArgs } from "../evaluator";
import { bool, listValue, nullValue, num, str } from "../value";
import { MethodFn } from "./any-methods";

function asString(target: Parameters<MethodFn>[0]): string | null {
  return target.type === "string" ? target.value : null;
}

export const STRING_METHODS: Record<string, MethodFn> = {
  length: (target) => {
    const s = asString(target);
    return s === null ? nullValue() : num(s.length);
  },

  contains: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [needle] = evaluateArgs(args, ctx);
    return bool(s.includes(valueToDisplayString(needle ?? nullValue())));
  },

  containsAll: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const values = evaluateArgs(args, ctx);
    return bool(values.every((v) => s.includes(valueToDisplayString(v))));
  },

  containsAny: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const values = evaluateArgs(args, ctx);
    return bool(values.some((v) => s.includes(valueToDisplayString(v))));
  },

  endsWith: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [q] = evaluateArgs(args, ctx);
    return bool(s.endsWith(valueToDisplayString(q ?? nullValue())));
  },

  isEmpty: (target) => {
    const s = asString(target);
    return s === null ? nullValue() : bool(s.length === 0);
  },

  lower: (target) => {
    const s = asString(target);
    return s === null ? nullValue() : str(s.toLowerCase());
  },

  replace: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [pattern, replacement] = evaluateArgs(args, ctx);
    const replacementStr = valueToDisplayString(replacement ?? nullValue());
    if (pattern?.type === "regexp") {
      try {
        const flags = pattern.value.flags.includes("g") ? pattern.value.flags : pattern.value.flags + "g";
        const re = new RegExp(pattern.value.source, flags);
        return str(s.replace(re, replacementStr));
      } catch {
        return str(s); // malformed regex source: leave the string unchanged
      }
    }
    // Literal string pattern: single-occurrence replace (JS String.replace(string, string) default).
    return str(s.replace(valueToDisplayString(pattern ?? nullValue()), replacementStr));
  },

  repeat: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [n] = evaluateArgs(args, ctx);
    if (n?.type !== "number") return nullValue();
    const count = Math.max(0, Math.floor(n.value));
    return str(s.repeat(count));
  },

  reverse: (target) => {
    const s = asString(target);
    return s === null ? nullValue() : str([...s].reverse().join(""));
  },

  slice: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [startArg, endArg] = evaluateArgs(args, ctx);
    const start = startArg?.type === "number" ? startArg.value : undefined;
    const end = endArg?.type === "number" ? endArg.value : undefined;
    return str(s.slice(start, end));
  },

  split: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [sepArg, limitArg] = evaluateArgs(args, ctx);
    const limit = limitArg?.type === "number" ? limitArg.value : undefined;
    let parts: string[];
    if (sepArg?.type === "regexp") {
      try {
        parts = s.split(new RegExp(sepArg.value.source, sepArg.value.flags), limit);
      } catch {
        parts = [s];
      }
    } else {
      parts = s.split(valueToDisplayString(sepArg ?? nullValue()), limit);
    }
    return listValue(parts.map(str));
  },

  startsWith: (target, args, ctx) => {
    const s = asString(target);
    if (s === null) return nullValue();
    const [q] = evaluateArgs(args, ctx);
    return bool(s.startsWith(valueToDisplayString(q ?? nullValue())));
  },

  title: (target) => {
    const s = asString(target);
    if (s === null) return nullValue();
    return str(s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()));
  },

  trim: (target) => {
    const s = asString(target);
    return s === null ? nullValue() : str(s.trim());
  },
};
