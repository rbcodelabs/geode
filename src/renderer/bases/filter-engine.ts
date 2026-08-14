import { FilterNode } from "./ast";
import { isTruthy } from "./coerce";
import { EvalContext } from "./eval-context";
import { evaluate } from "./evaluator";

/**
 * Recursively evaluate a filter tree: `and` is true iff every child is true,
 * `or` is true iff any child is true, `not` is true iff none of its children
 * are true (i.e. it's the negation of an implicit `or` over its children —
 * matching the `.base` YAML's `not:` block, which is a list of conditions
 * that must ALL be false).
 */
export function evaluateFilterTree(tree: FilterNode, ctx: EvalContext): boolean {
  if ("and" in tree) return tree.and.every((child) => evaluateFilterTree(child, ctx));
  if ("or" in tree) return tree.or.some((child) => evaluateFilterTree(child, ctx));
  if ("not" in tree) return tree.not.every((child) => !evaluateFilterTree(child, ctx));
  return isTruthy(evaluate(tree.leaf, ctx));
}
