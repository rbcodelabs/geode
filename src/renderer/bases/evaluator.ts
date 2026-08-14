import { Expr } from "./ast";
import { add, compareValues, divide, isTruthy, modulo, multiply, negate, subtract } from "./coerce";
import { EvalContext } from "./eval-context";
import { dispatchGlobalFunction, dispatchMethod } from "./functions";
import { resolvePropertyPath } from "./property-path";
import { BaseValue, bool, nullValue, num, regexpValue, str } from "./value";

function evaluateInner(node: Expr, ctx: EvalContext): BaseValue {
  switch (node.kind) {
    case "literal": {
      const v = node.value;
      if (typeof v === "string") return str(v);
      if (typeof v === "number") return num(v);
      return bool(v);
    }
    case "regexLiteral":
      return regexpValue(node.source, node.flags);
    case "propertyPath":
      return resolvePropertyPath(node, ctx);
    case "call": {
      const args = node.args.map((a) => evaluateInner(a, ctx));
      return dispatchGlobalFunction(node.callee, args, ctx);
    }
    case "methodCall": {
      const target = evaluateInner(node.target, ctx);
      // Method args are passed through as raw AST, not pre-evaluated:
      // list .filter()/.map()/.reduce() need to evaluate their lambda-body
      // argument once per element with fresh value/index/acc bindings, which
      // is impossible if the caller already collapsed it to a single
      // BaseValue. Non-lambda methods just call evaluate()/evaluateArgs()
      // on their args immediately — see functions/*.ts.
      return dispatchMethod(target, node.method, node.args, ctx);
    }
    case "fieldAccess": {
      const target = evaluateInner(node.target, ctx);
      return dispatchMethod(target, node.field, [], ctx);
    }
    case "index": {
      const target = evaluateInner(node.target, ctx);
      const idx = evaluateInner(node.indexExpr, ctx);
      if (target.type !== "list" || idx.type !== "number") return nullValue();
      const item = target.value[idx.value];
      return item ?? nullValue();
    }
    case "unary": {
      const operand = evaluateInner(node.operand, ctx);
      if (node.op === "not") return bool(!isTruthy(operand));
      if (node.op === "-") return negate(operand);
      // Unary "+": numeric/duration identity, else null. Not detailed by the
      // spec (which only defines unary "-"); a symmetrical no-op is the
      // least surprising behavior for the one other unary op the grammar allows.
      return operand.type === "number" || operand.type === "duration" ? operand : nullValue();
    }
    case "binary": {
      if (node.op === "and") {
        return bool(isTruthy(evaluateInner(node.left, ctx)) && isTruthy(evaluateInner(node.right, ctx)));
      }
      if (node.op === "or") {
        return bool(isTruthy(evaluateInner(node.left, ctx)) || isTruthy(evaluateInner(node.right, ctx)));
      }
      const left = evaluateInner(node.left, ctx);
      const right = evaluateInner(node.right, ctx);
      switch (node.op) {
        case "==":
        case "!=":
        case ">":
        case "<":
        case ">=":
        case "<=":
          return compareValues(left, right, node.op);
        case "+":
          return add(left, right);
        case "-":
          return subtract(left, right);
        case "*":
          return multiply(left, right);
        case "/":
          return divide(left, right);
        case "%":
          return modulo(left, right);
      }
      return nullValue();
    }
    case "group":
      return evaluateInner(node.inner, ctx);
  }
}

/**
 * Evaluate an expression AST node against `ctx`. Total function: the whole
 * tree-walk runs inside a try/catch so one bad formula/filter/summary can
 * never throw out of this module — logs via `console.error` and returns
 * `nullValue()` on any unexpected internal error.
 */
export function evaluate(node: Expr, ctx: EvalContext): BaseValue {
  try {
    return evaluateInner(node, ctx);
  } catch (err) {
    console.error("Bases: expression evaluation failed", err);
    return nullValue();
  }
}

/** Evaluate a list of argument expressions against the same context. */
export function evaluateArgs(args: Expr[], ctx: EvalContext): BaseValue[] {
  return args.map((a) => evaluate(a, ctx));
}
