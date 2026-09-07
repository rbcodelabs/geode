/**
 * Adapters between Geode's Bases query engine and the objects a hosted Bases
 * view actually receives: `BasesEntry`, `BasesQueryResult`, `BasesEntryGroup`
 * and `BasesViewConfig`.
 *
 * These are the real integration surface. `QueryController` is opaque (its
 * documented body is empty), so everything a view can actually reach goes
 * through the four classes here.
 */
import type { BaseDefinition, BaseViewDefinition } from "../bases/base-file";
import type { EvalContext, MetadataCacheReader, VaultReader } from "../bases/eval-context";
import { createRowContext } from "../bases/eval-context";
import { evaluate } from "../bases/evaluator";
import { parseExpression } from "../bases/parser";
import type { QueryResult, QueryRow } from "../bases/query-engine";
import { evaluateSummary } from "../bases/summary-engine";
import type { BaseValue } from "../bases/value";
import type { Expr } from "../bases/ast";
import type { TFile } from "../types";
import { parsePropertyId, toPropertyId, type BasesPropertyId } from "./bases-property-id";
import { NullValue, toApiValue, type Value } from "./bases-values";

export type BasesSortConfig = { property: BasesPropertyId; direction: "ASC" | "DESC" };

/** Everything an entry needs to evaluate a property it wasn't given up front. */
export interface EntryEvalDeps {
  vault: VaultReader;
  metadataCache: MetadataCacheReader;
  /** Base-level formulas, already parsed once by the caller. */
  formulas: Record<string, Expr>;
  thisFile: TFile | null;
  now: number;
}

/**
 * One row of a base.
 *
 * `getValue` has to evaluate on demand, not read a precomputed map. The query
 * engine only materializes the property paths named in `view.order`, but a
 * view routinely asks for a property deliberately *excluded* from `order` —
 * a Kanban board groups by a property it does not also render as a card field.
 * Looking such a property up in the precomputed map returns nothing, and every
 * card lands in "Uncategorized".
 *
 * So values the engine already computed are used as a memo seed, and anything
 * else is evaluated lazily against a row context built on first use. The
 * `EvalContext` is retained across calls (it is per-row by construction —
 * formula cache, cycle guard and locals are all row-scoped), and results are
 * memoized. Lifetime is bounded for free: the API documents `data` as replaced
 * wholesale on every update, so entries never outlive one result set.
 */
export class BasesEntry {
  private ctx: EvalContext | null = null;
  private memo = new Map<string, Value>();

  constructor(
    readonly file: TFile,
    private readonly deps: EntryEvalDeps,
    seed?: { properties: Record<string, BaseValue>; formulas: Record<string, BaseValue> }
  ) {
    if (!seed) return;
    // Seed keys are engine paths; the API speaks prefixed ids.
    for (const [path, value] of Object.entries(seed.properties)) {
      this.memo.set(toPropertyId(path), toApiValue(value));
    }
    for (const [name, value] of Object.entries(seed.formulas)) {
      this.memo.set(`formula.${name}`, toApiValue(value));
    }
  }

  /**
   * The value of `propertyId` for this row.
   *
   * A property that simply isn't set yields `NullValue.value` (the engine's
   * own answer for a missing property), not `null`. `null` is reserved for an
   * id that isn't a parseable property expression at all.
   */
  getValue(propertyId: string): Value | null {
    const id = toPropertyId(propertyId);
    const cached = this.memo.get(id);
    if (cached) return cached;

    const parsed = parseExpression(id);
    if (!("expr" in parsed)) return null;

    const value = toApiValue(evaluate(parsed.expr, this.context()));
    this.memo.set(id, value);
    return value;
  }

  private context(): EvalContext {
    this.ctx ??= createRowContext(
      this.file,
      this.deps.vault,
      this.deps.metadataCache,
      this.deps.formulas,
      this.deps.thisFile,
      this.deps.now
    );
    return this.ctx;
  }
}

/** A bucket of entries sharing one groupBy value. */
export class BasesEntryGroup {
  constructor(
    readonly entries: BasesEntry[],
    readonly key?: Value
  ) {}

  /** True iff this group has a non-null key. */
  hasKey(): boolean {
    return this.key !== undefined && !(this.key instanceof NullValue);
  }
}

/** Deps `BasesQueryResult.getSummaryValue` needs beyond the rows themselves. */
export interface SummaryDeps extends EntryEvalDeps {
  /** Named summary formulas from the base definition (`def.summaries`). */
  summaries: Record<string, string>;
  anchorFile: TFile | null;
}

/** The output of one query run, in the shape a view consumes. */
export class BasesQueryResult {
  constructor(
    readonly data: BasesEntry[],
    private readonly groups: BasesEntryGroup[] | null,
    private readonly visibleProperties: BasesPropertyId[],
    private readonly summaryDeps: SummaryDeps
  ) {}

  /**
   * Entries bucketed by the groupBy config. With no groupBy configured this
   * is a single keyless group holding everything, per the documented
   * contract — a view can always iterate `groupedData` without branching.
   */
  get groupedData(): BasesEntryGroup[] {
    return this.groups ?? [new BasesEntryGroup(this.data)];
  }

  /** Visible properties, in user-configured order. */
  get properties(): BasesPropertyId[] {
    return this.visibleProperties;
  }

  /**
   * Apply a named summary formula to one property across `entries`.
   *
   * `summaryKey` names a formula in the base's `summaries` block. Obsidian
   * also offers built-in aggregations (Average/Sum/Median/...) which Geode's
   * engine does not implement; an unknown key yields `NullValue` rather than
   * a guess, matching how `runQuery` already skips them.
   *
   * `queryController` is accepted for signature compatibility and unused —
   * the controller carries no public state (see `QueryController`).
   */
  getSummaryValue(_queryController: unknown, entries: BasesEntry[], prop: string, summaryKey: string): Value {
    const formulaText = this.summaryDeps.summaries[summaryKey];
    if (!formulaText) return NullValue.value;

    const summaryExpr = parseExpression(formulaText);
    if (!("expr" in summaryExpr)) return NullValue.value;

    const anchor = this.summaryDeps.anchorFile ?? entries[0]?.file;
    if (!anchor) return NullValue.value;

    const columnValues = entries.map((e) => {
      const v = e.getValue(prop);
      return (v ?? NullValue.value).baseValue;
    });
    const ctx = createRowContext(
      anchor,
      this.summaryDeps.vault,
      this.summaryDeps.metadataCache,
      this.summaryDeps.formulas,
      this.summaryDeps.thisFile,
      this.summaryDeps.now
    );
    return toApiValue(evaluateSummary(summaryExpr.expr, columnValues, ctx));
  }
}

/**
 * The in-memory settings of one view in a `.base` file.
 *
 * `get`/`set` operate over `BaseViewDefinition.extra` — the passthrough bag
 * that keeps keys Geode itself does not model. That is what makes a
 * plugin-registered view type able to persist its own settings at all; before
 * the bag existed, every `set` was erased by the next write.
 */
export class BasesViewConfig {
  constructor(
    private readonly view: BaseViewDefinition,
    private readonly def: BaseDefinition,
    /** Resolved column paths for this view (already through `resolveColumns`). */
    private readonly resolvedColumns: () => string[],
    /** Persist the mutated definition back to the `.base` file. */
    private readonly persist: () => void,
    /** Evaluation context for `getEvaluatedFormula`. */
    private readonly deps: EntryEvalDeps
  ) {}

  get name(): string {
    return this.view.name;
  }

  get(key: string): unknown {
    return this.view.extra?.[key];
  }

  /**
   * Store a view setting. `null` removes the key rather than writing a null
   * into the user's YAML.
   */
  set(key: string, value: unknown): void {
    const extra = { ...this.view.extra };
    if (value === null || value === undefined) delete extra[key];
    else extra[key] = value;
    this.view.extra = Object.keys(extra).length ? extra : undefined;
    this.persist();
  }

  /**
   * A stored setting read as a property id. `null` when the key is absent or
   * the stored value isn't a usable string — a view uses this to pick the
   * property it groups by, so a bad value must read as "not configured"
   * rather than as a broken id.
   */
  getAsPropertyId(key: string): BasesPropertyId | null {
    const raw = this.get(key);
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return toPropertyId(raw.trim());
  }

  /**
   * Read a stored setting and evaluate it as a formula in the context of the
   * current base — the contextual file (`this`), which for an embedded or
   * sidebar base is the currently active note.
   *
   * @returns the resulting value, or `NullValue` if the key is absent or the
   * formula is invalid. Never throws: a malformed formula in a config file
   * should degrade to "no value", not break the view rendering it.
   */
  getEvaluatedFormula(_view: unknown, key: string): Value {
    const raw = this.get(key);
    if (typeof raw !== "string" || raw.trim() === "") return NullValue.value;

    const parsed = parseExpression(raw);
    if (!("expr" in parsed)) return NullValue.value;

    const anchor = this.deps.thisFile;
    if (!anchor) return NullValue.value;

    const ctx = createRowContext(
      anchor,
      this.deps.vault,
      this.deps.metadataCache,
      this.deps.formulas,
      this.deps.thisFile,
      this.deps.now
    );
    return toApiValue(evaluate(parsed.expr, ctx));
  }

  /** Visible properties in user-configured order, normalized to prefixed ids. */
  getOrder(): BasesPropertyId[] {
    return this.resolvedColumns().map(toPropertyId);
  }

  /** Sort config, normalized. Invalid entries are dropped, per the documented contract. */
  getSort(): BasesSortConfig[] {
    return (this.view.sort ?? [])
      .filter((s) => typeof s.property === "string" && s.property !== "")
      .map((s) => ({ property: toPropertyId(s.property), direction: s.direction }));
  }

  /**
   * Friendly name for a property: the user's `properties[...].displayName`
   * override if set, otherwise the id with its source prefix removed (so a
   * card labels a field "status", not "note.status").
   *
   * The override is looked up under both the prefixed id and the bare name,
   * because a hand-authored `.base` may key `properties` either way.
   */
  getDisplayName(propertyId: string): string {
    const id = toPropertyId(propertyId);
    const { name } = parsePropertyId(id);
    for (const key of [id, name, propertyId]) {
      const override = this.def.properties[key]?.displayName?.trim();
      if (override) return override;
    }
    // Same override-first shape as `columnDisplayName`, but a different
    // fallback: that one is for table headers and shows the raw path, while
    // the API contract is the prefix-stripped name.
    return name;
  }
}

/**
 * Build the API-shaped result for one engine query run.
 *
 * `columns` are the resolved column paths (engine form); they become
 * `BasesQueryResult.properties` as prefixed ids.
 */
export function toBasesQueryResult(
  result: QueryResult,
  columns: string[],
  deps: SummaryDeps
): BasesQueryResult {
  const toEntry = (row: QueryRow) =>
    new BasesEntry(row.file, deps, { properties: row.properties, formulas: row.formulas });

  // Entries must be shared between `data` and `groupedData`: a view that
  // reads one and then the other would otherwise get two objects per row,
  // each with its own memo, doubling evaluation work and breaking identity
  // comparisons.
  //
  // Keyed by file path, not by row identity — `runQuery` builds its public
  // rows with a `toPublicRow` that returns a fresh object per call, so the
  // row in `result.rows` is never the same object as its twin in
  // `result.groups[].rows`. Paths are unique within one result set.
  const entries = new Map<string, BasesEntry>();
  const entryFor = (row: QueryRow) => {
    let e = entries.get(row.file.path);
    if (!e) {
      e = toEntry(row);
      entries.set(row.file.path, e);
    }
    return e;
  };

  const data = result.rows.map(entryFor);
  const groups =
    result.groups?.map((g) => new BasesEntryGroup(g.rows.map(entryFor), toApiValue(g.key))) ?? null;

  return new BasesQueryResult(data, groups, columns.map(toPropertyId), deps);
}
