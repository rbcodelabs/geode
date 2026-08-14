/**
 * Public API surface of the Bases expression/query engine (Phase A). Phase B
 * (the actual table UI) imports from here rather than reaching into
 * individual modules.
 */

export type { Expr, FilterNode, BinaryOp, ComparisonOp, ArithmeticOp, LogicalOp, PropertyRoot } from "./ast";
export { tokenize } from "./lexer";
export type { Token, TokenType } from "./lexer";
export { parseExpression } from "./parser";
export { parseFilterTree } from "./filter-parser";

export type { BaseValue, DurationUnit, LinkValue, RegexpValue, ImageValue } from "./value";
export {
  nullValue,
  str,
  num,
  bool,
  dateValue,
  durationValue,
  listValue,
  objectValue,
  linkValue,
  fileValue,
  regexpValue,
  htmlValue,
  imageValue,
} from "./value";

export { isTruthy, compareValues, valueToDisplayString } from "./coerce";
export { parseDuration, parseDateString, addDuration } from "./date-math";

export type { EvalContext, VaultReader, MetadataCacheReader } from "./eval-context";
export { createRowContext } from "./eval-context";
export { resolvePropertyPath, frontmatterValueToBaseValue } from "./property-path";

export { evaluate, evaluateArgs } from "./evaluator";
export { evaluateFormula, evaluateAllFormulas } from "./formula-engine";
export { evaluateFilterTree } from "./filter-engine";
export { evaluateSummary } from "./summary-engine";

export type { BaseDefinition, BaseViewDefinition, BasePropertyConfig } from "./base-file";
export { parseBaseFile } from "./base-file";

export type { QueryRow, QueryGroup, QueryResult } from "./query-engine";
export { runQuery } from "./query-engine";
