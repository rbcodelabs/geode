import { isTruthy, valueToDisplayString } from "../coerce";
import { parseDateString, parseDuration, today } from "../date-math";
import { EvalContext } from "../eval-context";
import { BaseValue, dateValue, durationValue, fileValue, htmlValue, imageValue, linkValue, listValue, nullValue, num, str } from "../value";

export type GlobalFunctionFn = (args: BaseValue[], ctx: EvalContext) => BaseValue;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deterministic PRNG for `random()` when `ctx.randomSeed` is set — makes tests stable. */
function mulberry32(seed: number): number {
  let t = (seed | 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const GLOBAL_FUNCTIONS: Record<string, GlobalFunctionFn> = {
  escapeHTML: (args) => str(escapeHtml(valueToDisplayString(args[0] ?? nullValue()))),

  date: (args) => {
    const v = args[0];
    if (!v || v.type !== "string") return nullValue();
    const ms = parseDateString(v.value);
    return ms === null ? nullValue() : dateValue(ms);
  },

  duration: (args) => {
    const v = args[0];
    if (!v || v.type !== "string") return nullValue();
    const parsed = parseDuration(v.value);
    return parsed ? durationValue(parsed.amount, parsed.unit) : nullValue();
  },

  file: (args, ctx) => {
    const v = args[0];
    if (!v) return nullValue();
    if (v.type === "file") return v;
    if (v.type === "link") return v.value.resolved ? fileValue(v.value.resolved) : nullValue();
    if (v.type === "string") {
      const resolved = ctx.metadataCache.getFirstLinkpathDest(v.value, ctx.file.path) ?? ctx.vault.getFileByPath(v.value);
      return resolved ? fileValue(resolved) : nullValue();
    }
    return nullValue();
  },

  html: (args) => htmlValue(valueToDisplayString(args[0] ?? nullValue())),

  if: (args) => {
    const cond = args[0] ?? nullValue();
    return isTruthy(cond) ? (args[1] ?? nullValue()) : (args[2] ?? nullValue());
  },

  image: (args) => {
    const v = args[0];
    if (!v) return nullValue();
    const source = v.type === "file" ? v.value.path : valueToDisplayString(v);
    return imageValue(source);
  },

  // Lucide icon names are opaque strings to a headless (non-DOM) engine —
  // treated as a passthrough per the spec's guidance.
  icon: (args) => str(valueToDisplayString(args[0] ?? nullValue())),

  link: (args, ctx) => {
    const pathArg = args[0];
    if (!pathArg || pathArg.type !== "string") return nullValue();
    const display = args[1] && args[1].type === "string" ? args[1].value : undefined;
    const resolved = ctx.metadataCache.getFirstLinkpathDest(pathArg.value, ctx.file.path);
    return linkValue(pathArg.value, resolved, display);
  },

  // Judgment call: list() is documented as "wraps in list" for a single
  // element, but is implemented here as variadic collect-all-args — that's
  // the only sensible reading that also supports the spec's own filter
  // example usage as `list(type)[0]` where `type` is a single value, while
  // still letting `list(a, b, c)` build a literal multi-element list (there
  // is no bracket list-literal syntax in this grammar, so list() is the only
  // way to construct one from several values).
  list: (args) => listValue(args),

  max: (args) => {
    const nums = args.filter((a): a is Extract<BaseValue, { type: "number" }> => a.type === "number");
    return nums.length ? num(Math.max(...nums.map((n) => n.value))) : nullValue();
  },

  min: (args) => {
    const nums = args.filter((a): a is Extract<BaseValue, { type: "number" }> => a.type === "number");
    return nums.length ? num(Math.min(...nums.map((n) => n.value))) : nullValue();
  },

  now: (_args, ctx) => dateValue(ctx.now),

  number: (args) => {
    const v = args[0];
    if (!v) return nullValue();
    if (v.type === "number") return v;
    if (v.type === "date") return num(v.value);
    if (v.type === "boolean") return num(v.value ? 1 : 0);
    if (v.type === "duration") return num(v.value.amount);
    if (v.type === "string") {
      const n = Number(v.value);
      return Number.isNaN(n) ? nullValue() : num(n);
    }
    return nullValue();
  },

  random: (_args, ctx) => num(ctx.randomSeed !== undefined ? mulberry32(ctx.randomSeed) : Math.random()),

  today: (_args, ctx) => dateValue(today(ctx.now)),
};
