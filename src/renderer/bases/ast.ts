/**
 * AST for the Bases expression grammar. Produced by `parser.ts`, consumed
 * by `evaluator.ts`. Pure data — no behavior lives here.
 */

export type ComparisonOp = "==" | "!=" | ">" | "<" | ">=" | "<=";
export type ArithmeticOp = "+" | "-" | "*" | "/" | "%";
export type LogicalOp = "and" | "or";
export type BinaryOp = ComparisonOp | ArithmeticOp | LogicalOp;

export type PropertyRoot = "shorthand" | "note" | "file" | "formula" | "this";

export type Expr =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "regexLiteral"; source: string; flags: string }
  | { kind: "propertyPath"; root: PropertyRoot; segments: string[] }
  | { kind: "call"; callee: string; args: Expr[] }
  | { kind: "methodCall"; target: Expr; method: string; args: Expr[] }
  | { kind: "fieldAccess"; target: Expr; field: string }
  | { kind: "index"; target: Expr; indexExpr: Expr }
  | { kind: "unary"; op: "-" | "+" | "not"; operand: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "group"; inner: Expr };

/**
 * Recursive filter tree parsed from a `.base` YAML `filters` block (or a
 * view's `filters` override). Exactly one of `and`/`or`/`not`/`leaf` is set
 * per node.
 */
export type FilterNode =
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode[] }
  | { leaf: Expr };
