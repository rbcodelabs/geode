/**
 * GUI-editable filter representation for the Bases toolbar's Filter panel,
 * plus (de)serialization to/from the plain YAML-shaped `FilterNode` object
 * `filter-parser.ts`'s `parseFilterTree` consumes (and that gets written
 * back into a `.base` file's `filters:`/view `filters:` key).
 *
 * `parseFilterTree` (and `runQuery`) work against a raw, already-YAML-parsed
 * JS value: `{and:[...]} | {or:[...]} | {not:[...]} | "leaf expression"`.
 * This module is the bridge: a `FilterGroup` tree the filter-editor UI can
 * render as rows + nested groups, converted to/from that raw shape.
 *
 * Round-trip fidelity for hand-written `.base` filters is a nice-to-have,
 * not a guarantee — `parseNodeToGroup` returns `null` (rather than guessing)
 * for any leaf expression it doesn't recognize as one of the GUI's known
 * operator patterns, or any node shape it doesn't recognize. Callers should
 * fall back to a raw-text "code" editor in that case (see
 * `views/bases/filter-editor.ts`).
 */

export type FilterOperator = "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "does not contain" | "is empty" | "is not empty";

export const FILTER_OPERATORS: FilterOperator[] = [
  "==",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "contains",
  "does not contain",
  "is empty",
  "is not empty",
];

/** Operators that don't take a value (rendered without a value input in the GUI). */
export function operatorTakesValue(op: FilterOperator): boolean {
  return op !== "is empty" && op !== "is not empty";
}

export interface FilterCondition {
  kind: "condition";
  /** Full property path as it appears in an expression, e.g. "note.status", "file.name", "formula.total". */
  property: string;
  operator: FilterOperator;
  /** Raw (unquoted) value text as typed by the user; empty string for value-less operators. */
  value: string;
}

export type FilterConjunction = "and" | "or" | "not";

export interface FilterGroup {
  kind: "group";
  conjunction: FilterConjunction;
  children: FilterItem[];
}

export type FilterItem = FilterCondition | FilterGroup;

let idCounter = 0;
/** Stable client-side identity for GUI list rendering (React-key-style) — never persisted. */
export function nextFilterItemId(): string {
  return `filter-item-${++idCounter}`;
}

export function emptyGroup(conjunction: FilterConjunction = "and"): FilterGroup {
  return { kind: "group", conjunction, children: [] };
}

export function emptyCondition(): FilterCondition {
  return { kind: "condition", property: "", operator: "==", value: "" };
}

/** Quote/format a raw value string as an expression literal: numeric/boolean pass through unquoted, everything else is a quoted string. */
function valueLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "true" || trimmed === "false") return trimmed;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return trimmed;
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Strip one layer of quoting/escaping added by `valueLiteral`, for round-tripping a parsed leaf back into the GUI's plain value text. */
function unquoteLiteral(literal: string): string {
  const trimmed = literal.trim();
  const m = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) return m[1].replace(/\\(.)/g, "$1");
  return trimmed;
}

/** Build the leaf expression string for one condition row. */
export function conditionToExprString(cond: FilterCondition): string {
  const prop = cond.property.trim() || "note.value";
  switch (cond.operator) {
    case "==":
    case "!=":
    case ">":
    case "<":
    case ">=":
    case "<=":
      return `${prop} ${cond.operator} ${valueLiteral(cond.value)}`;
    case "contains":
      return `${prop}.contains(${valueLiteral(cond.value)})`;
    case "does not contain":
      return `not ${prop}.contains(${valueLiteral(cond.value)})`;
    case "is empty":
      return `${prop}.isEmpty()`;
    case "is not empty":
      return `not ${prop}.isEmpty()`;
  }
}

const COMPARISON_RE = /^(\S+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;
const CONTAINS_RE = /^(\S+)\.contains\((.*)\)$/;
const NOT_CONTAINS_RE = /^not\s+(\S+)\.contains\((.*)\)$/;
const IS_EMPTY_RE = /^(\S+)\.isEmpty\(\)$/;
const NOT_IS_EMPTY_RE = /^not\s+(\S+)\.isEmpty\(\)$/;

/** Parse a leaf expression string back into a `FilterCondition`, or `null` if it doesn't match a GUI-known pattern. */
export function parseConditionExpr(text: string): FilterCondition | null {
  const src = text.trim();

  let m = src.match(NOT_CONTAINS_RE);
  if (m) return { kind: "condition", property: m[1], operator: "does not contain", value: unquoteLiteral(m[2]) };

  m = src.match(NOT_IS_EMPTY_RE);
  if (m) return { kind: "condition", property: m[1], operator: "is not empty", value: "" };

  m = src.match(CONTAINS_RE);
  if (m) return { kind: "condition", property: m[1], operator: "contains", value: unquoteLiteral(m[2]) };

  m = src.match(IS_EMPTY_RE);
  if (m) return { kind: "condition", property: m[1], operator: "is empty", value: "" };

  m = src.match(COMPARISON_RE);
  if (m) return { kind: "condition", property: m[1], operator: m[2] as FilterOperator, value: unquoteLiteral(m[3]) };

  return null;
}

function itemToNode(item: FilterItem): unknown {
  return item.kind === "condition" ? conditionToExprString(item) : groupToNode(item);
}

/** Serialize a `FilterGroup` tree to the raw YAML-node shape `parseFilterTree`/`.base` files expect. */
export function groupToNode(group: FilterGroup): unknown {
  return { [group.conjunction]: group.children.map(itemToNode) };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Reconstruct a `FilterGroup` tree from a raw YAML filter node (as parsed
 * from a `.base` file, or previously produced by `groupToNode`). Returns
 * `null` if the node isn't a `{and|or|not: [...]}` object, or if any leaf
 * string doesn't match one of `parseConditionExpr`'s known patterns — the
 * caller should fall back to raw-text "code" editing in that case rather
 * than silently dropping/misrepresenting an expression the GUI can't build.
 */
export function parseNodeToGroup(node: unknown): FilterGroup | null {
  const rec = asRecord(node);
  if (!rec) return null;
  for (const conjunction of ["and", "or", "not"] as const) {
    if (!(conjunction in rec)) continue;
    const children = rec[conjunction];
    if (!Array.isArray(children)) return null;
    const parsedChildren: FilterItem[] = [];
    for (const child of children) {
      if (typeof child === "string") {
        const cond = parseConditionExpr(child);
        if (!cond) return null;
        parsedChildren.push(cond);
      } else {
        const nested = parseNodeToGroup(child);
        if (!nested) return null;
        parsedChildren.push(nested);
      }
    }
    return { kind: "group", conjunction, children: parsedChildren };
  }
  return null;
}
