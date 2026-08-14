import { parse as parseYaml } from "yaml";

export interface BaseViewDefinition {
  type: string;
  name: string;
  limit?: number;
  groupBy?: { property: string; direction: "ASC" | "DESC" };
  /** Raw YAML filter node (view-level override) — parsed on demand by query-engine.ts via filter-parser.ts. */
  filters?: unknown;
  order?: string[];
  sort?: { property: string; direction: "ASC" | "DESC" }[];
  /** property path -> summary name (built-in) or formula name, per the spec's view.summaries shape. */
  summaries?: Record<string, string>;
}

export interface BasePropertyConfig {
  displayName?: string;
}

export interface BaseDefinition {
  /** Raw YAML filter node (base-wide) — parsed on demand by query-engine.ts via filter-parser.ts. `undefined` if absent. */
  filters: unknown;
  formulas: Record<string, string>;
  properties: Record<string, BasePropertyConfig>;
  summaries: Record<string, string>;
  views: BaseViewDefinition[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringMap(v: unknown): Record<string, string> {
  const rec = asRecord(v);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function parseDirection(v: unknown): "ASC" | "DESC" {
  return v === "DESC" ? "DESC" : "ASC";
}

function parseView(raw: unknown): BaseViewDefinition | null {
  const rec = asRecord(raw);
  if (!rec || typeof rec.type !== "string" || typeof rec.name !== "string") return null;

  const view: BaseViewDefinition = { type: rec.type, name: rec.name };
  if (typeof rec.limit === "number") view.limit = rec.limit;

  const groupBy = asRecord(rec.groupBy);
  if (groupBy && typeof groupBy.property === "string") {
    view.groupBy = { property: groupBy.property, direction: parseDirection(groupBy.direction) };
  }

  if (rec.filters !== undefined) view.filters = rec.filters;

  if (Array.isArray(rec.order)) {
    view.order = rec.order.filter((o): o is string => typeof o === "string");
  }

  if (Array.isArray(rec.sort)) {
    view.sort = rec.sort
      .map((s) => asRecord(s))
      .filter((s): s is Record<string, unknown> => s !== null && typeof s.property === "string")
      .map((s) => ({ property: s.property as string, direction: parseDirection(s.direction) }));
  }

  const summaries = stringMap(rec.summaries);
  if (Object.keys(summaries).length) view.summaries = summaries;

  return view;
}

/**
 * Parse a `.base` file's raw YAML text into a `BaseDefinition`. Leniently
 * normalizes — missing/malformed keys default to empty collections and are
 * silently dropped, never throwing. Only returns `{error}` for YAML syntax
 * errors that `yaml.parse` itself throws on.
 *
 * Deliberately does NOT parse `filters`/`formulas`/`summaries` expression
 * strings into ASTs here — that happens lazily in `query-engine.ts` (via
 * `parser.ts`/`filter-parser.ts`), which is also where a malformed
 * individual expression gets handled (skipped) without invalidating the
 * whole base file.
 */
export function parseBaseFile(yamlText: string): { def: BaseDefinition } | { error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const obj = asRecord(raw) ?? {};

  const views: BaseViewDefinition[] = Array.isArray(obj.views)
    ? obj.views.map(parseView).filter((v): v is BaseViewDefinition => v !== null)
    : [];

  const properties: Record<string, BasePropertyConfig> = {};
  const propsRec = asRecord(obj.properties);
  if (propsRec) {
    for (const [key, val] of Object.entries(propsRec)) {
      const valRec = asRecord(val);
      const displayName = valRec && typeof valRec.displayName === "string" ? valRec.displayName : undefined;
      properties[key] = { displayName };
    }
  }

  return {
    def: {
      filters: obj.filters,
      formulas: stringMap(obj.formulas),
      properties,
      summaries: stringMap(obj.summaries),
      views,
    },
  };
}
