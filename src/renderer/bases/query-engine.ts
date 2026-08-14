import type { TFile } from "../types";
import { Expr, FilterNode } from "./ast";
import { BaseDefinition, BaseViewDefinition } from "./base-file";
import { compareValues, isTruthy, valueToDisplayString } from "./coerce";
import { createRowContext, MetadataCacheReader, VaultReader } from "./eval-context";
import { evaluate } from "./evaluator";
import { evaluateFilterTree } from "./filter-engine";
import { parseFilterTree } from "./filter-parser";
import { evaluateAllFormulas } from "./formula-engine";
import { parseExpression } from "./parser";
import { evaluateSummary } from "./summary-engine";
import { BaseValue, nullValue } from "./value";

export interface QueryRow {
  file: TFile;
  /** Resolved values for each `order` column path (empty if the view specifies no `order`). */
  properties: Record<string, BaseValue>;
  /** Every base-level formula, resolved for this row. */
  formulas: Record<string, BaseValue>;
}

export interface QueryGroup {
  key: BaseValue;
  rows: QueryRow[];
}

export interface QueryResult {
  view: BaseViewDefinition;
  /** Filtered, sorted, limited rows (flat — ungrouped). */
  rows: QueryRow[];
  /** Present iff the view specifies `groupBy`; buckets `rows` by that property's value. */
  groups: QueryGroup[] | null;
  /**
   * column path -> summary value, for entries in `view.summaries` that
   * resolve to a custom named formula in `def.summaries` (the `values`-
   * keyword aggregations `summary-engine.ts` implements). Built-in named
   * table-view summaries (Average/Sum/Median/...) are a Table-view UI
   * concept from the spec's "View layouts" section — out of scope for this
   * pure-engine phase, so an entry naming one is silently skipped rather
   * than guessed at.
   */
  summaries: Record<string, BaseValue>;
}

interface RowInternal extends QueryRow {
  sortKeys: BaseValue[];
  groupKey: BaseValue | null;
}

function parseFormulas(raw: Record<string, string>): Record<string, Expr> {
  const out: Record<string, Expr> = {};
  for (const [name, text] of Object.entries(raw)) {
    const parsed = parseExpression(text);
    if ("expr" in parsed) out[name] = parsed.expr;
    else console.error(`Bases: formula "${name}" failed to parse: ${parsed.error}`);
  }
  return out;
}

/** Base-wide and view-level `filters` concatenate with AND, per the spec's "Filters" section. */
function combinedFilterTree(base: unknown, view: unknown): FilterNode | null {
  const trees: FilterNode[] = [];
  for (const raw of [base, view]) {
    if (raw === undefined) continue;
    const parsed = parseFilterTree(raw);
    if ("tree" in parsed) trees.push(parsed.tree);
    else console.error(`Bases: filters failed to parse: ${parsed.error}`);
  }
  if (trees.length === 0) return null;
  return trees.length === 1 ? trees[0] : { and: trees };
}

/** Parse every distinct column-path string once, up front, instead of per row. */
function parseColumnPaths(paths: string[]): Map<string, Expr | null> {
  const map = new Map<string, Expr | null>();
  for (const p of paths) {
    if (map.has(p)) continue;
    const parsed = parseExpression(p);
    map.set(p, "expr" in parsed ? parsed.expr : null);
  }
  return map;
}

/**
 * Order two `BaseValue`s for sorting. Uses `compareValues`'s numeric/
 * lexicographic rules; for pairs it can't order (e.g. two lists), falls back
 * to comparing their display strings, so sort output stays deterministic
 * rather than leaving those rows in arbitrary relative order.
 */
function compareForSort(a: BaseValue, b: BaseValue, direction: "ASC" | "DESC"): number {
  const lt = isTruthy(compareValues(a, b, "<"));
  const gt = isTruthy(compareValues(a, b, ">"));
  let ord = lt ? -1 : gt ? 1 : 0;
  if (!lt && !gt) {
    const as = valueToDisplayString(a);
    const bs = valueToDisplayString(b);
    ord = as < bs ? -1 : as > bs ? 1 : 0;
  }
  return direction === "DESC" ? -ord : ord;
}

function toPublicRow({ file, properties, formulas }: RowInternal): QueryRow {
  return { file, properties, formulas };
}

/**
 * Run one view of a `.base` definition against a candidate file list —
 * filter, sort, limit, group, and resolve formula/property columns plus
 * summary values. This is the integration surface Phase B's UI calls: give
 * it a parsed `BaseDefinition`, a view name, and a file list (e.g. from
 * `Vault.getMarkdownFiles()`), get back everything needed to render a table.
 */
export function runQuery(
  def: BaseDefinition,
  viewName: string,
  files: TFile[],
  vault: VaultReader,
  metadataCache: MetadataCacheReader,
  thisFile: TFile | null,
  now: number
): QueryResult | { error: string } {
  const view = def.views.find((v) => v.name === viewName);
  if (!view) return { error: `View "${viewName}" not found` };

  const formulas = parseFormulas(def.formulas);
  const filterTree = combinedFilterTree(def.filters, view.filters);

  const orderPaths = view.order ?? [];
  const sortSpecs = view.sort ?? [];
  const groupProperty = view.groupBy?.property;

  const orderExprs = parseColumnPaths(orderPaths);
  const sortExprs = parseColumnPaths(sortSpecs.map((s) => s.property));
  const groupExpr = groupProperty ? (parseColumnPaths([groupProperty]).get(groupProperty) ?? null) : null;

  const rows: RowInternal[] = [];
  for (const file of files) {
    const ctx = createRowContext(file, vault, metadataCache, formulas, thisFile, now);
    if (filterTree && !evaluateFilterTree(filterTree, ctx)) continue;

    const rowFormulas = evaluateAllFormulas(ctx);

    const properties: Record<string, BaseValue> = {};
    for (const path of orderPaths) {
      const expr = orderExprs.get(path);
      properties[path] = expr ? evaluate(expr, ctx) : nullValue();
    }

    const sortKeys = sortSpecs.map((s) => {
      const expr = sortExprs.get(s.property);
      return expr ? evaluate(expr, ctx) : nullValue();
    });

    const groupKey = groupExpr ? evaluate(groupExpr, ctx) : null;

    rows.push({ file, properties, formulas: rowFormulas, sortKeys, groupKey });
  }

  if (sortSpecs.length) {
    rows.sort((a, b) => {
      for (let i = 0; i < sortSpecs.length; i++) {
        const cmp = compareForSort(a.sortKeys[i], b.sortKeys[i], sortSpecs[i].direction);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  const limited = typeof view.limit === "number" ? rows.slice(0, view.limit) : rows;

  let groups: QueryGroup[] | null = null;
  if (view.groupBy) {
    const direction = view.groupBy.direction;
    const buckets = new Map<string, { key: BaseValue; rows: QueryRow[] }>();
    const bucketOrder: string[] = [];
    for (const row of limited) {
      const key = row.groupKey ?? nullValue();
      const bucketId = JSON.stringify(key);
      let bucket = buckets.get(bucketId);
      if (!bucket) {
        bucket = { key, rows: [] };
        buckets.set(bucketId, bucket);
        bucketOrder.push(bucketId);
      }
      bucket.rows.push(toPublicRow(row));
    }
    groups = bucketOrder.map((id) => buckets.get(id)!);
    groups.sort((a, b) => compareForSort(a.key, b.key, direction));
  }

  const summaries: Record<string, BaseValue> = {};
  const anchorFile = thisFile ?? limited[0]?.file ?? files[0];
  if (view.summaries && anchorFile) {
    for (const [columnPath, summaryName] of Object.entries(view.summaries)) {
      const formulaText = def.summaries[summaryName];
      if (!formulaText) continue; // built-in table-view summary name, or unknown — out of scope, see QueryResult.summaries doc
      const summaryExprResult = parseExpression(formulaText);
      const columnExprResult = parseExpression(columnPath);
      if (!("expr" in summaryExprResult) || !("expr" in columnExprResult)) continue;

      const columnValues = limited.map((row) => {
        const ctx = createRowContext(row.file, vault, metadataCache, formulas, thisFile, now);
        return evaluate(columnExprResult.expr, ctx);
      });
      const summaryCtx = createRowContext(anchorFile, vault, metadataCache, formulas, thisFile, now);
      summaries[columnPath] = evaluateSummary(summaryExprResult.expr, columnValues, summaryCtx);
    }
  }

  return { view, rows: limited.map(toPublicRow), groups, summaries };
}
