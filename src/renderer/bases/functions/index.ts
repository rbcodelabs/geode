import { Expr } from "../ast";
import { EvalContext } from "../eval-context";
import { BaseValue, nullValue } from "../value";
import { ANY_METHODS, MethodFn } from "./any-methods";
import { DATE_METHODS } from "./date-methods";
import { FILE_METHODS } from "./file-methods";
import { GLOBAL_FUNCTIONS } from "./global";
import { LINK_METHODS } from "./link-methods";
import { LIST_METHODS } from "./list-methods";
import { NUMBER_METHODS } from "./number-methods";
import { OBJECT_METHODS } from "./object-methods";
import { REGEXP_METHODS } from "./regexp-methods";
import { STRING_METHODS } from "./string-methods";

/**
 * Per-type method/field tables. Deliberately has no entries for
 * "null"/"boolean"/"duration"/"html"/"image" — those types only support the
 * universal `ANY_METHODS` (isTruthy/isType/toString), per the spec's
 * function reference (it defines no type-specific methods for them).
 */
export const METHOD_REGISTRY: Partial<Record<BaseValue["type"], Record<string, MethodFn>>> = {
  string: STRING_METHODS,
  number: NUMBER_METHODS,
  date: DATE_METHODS,
  list: LIST_METHODS,
  link: LINK_METHODS,
  file: FILE_METHODS,
  object: OBJECT_METHODS,
  regexp: REGEXP_METHODS,
};

/**
 * Own-property-only lookup. A plain `table[key]` lookup falls through to
 * `Object.prototype` for keys like "toString", "constructor", "valueOf", or
 * "hasOwnProperty" — all real-world method/function names a `.base`
 * expression can legally reference (`.toString()` is a required Any-type
 * method; a formula author could just as easily type `.constructor()` and
 * expect `nullValue()`, not an accidental invocation of `Object.prototype`).
 * Every method/global-function dispatch table lookup below goes through
 * this instead of bare indexing, so an unrecognized name is always
 * `undefined` and never silently resolves to an inherited prototype member.
 */
function ownLookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Resolve and invoke a method or field access (`.name` / `.name(args)`) on
 * `target`. `ANY_METHODS` is checked first (so isTruthy/isType/toString work
 * on every type), then the per-type table. An unknown method/field for that
 * type -> `nullValue()`, never throws.
 */
export function dispatchMethod(target: BaseValue, name: string, args: Expr[], ctx: EvalContext): BaseValue {
  const anyFn = ownLookup(ANY_METHODS, name);
  if (anyFn) return anyFn(target, args, ctx);
  const table = METHOD_REGISTRY[target.type];
  const fn = table && ownLookup(table, name);
  return fn ? fn(target, args, ctx) : nullValue();
}

/** Resolve and invoke a global function call (`name(args)`). Unknown name -> `nullValue()`. */
export function dispatchGlobalFunction(name: string, args: BaseValue[], ctx: EvalContext): BaseValue {
  const fn = ownLookup(GLOBAL_FUNCTIONS, name);
  return fn ? fn(args, ctx) : nullValue();
}
