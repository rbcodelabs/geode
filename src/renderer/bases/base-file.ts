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
  // --- Cards-view layout options (type: "cards") -------------------------
  /** Property path whose value supplies each card's cover image. */
  image?: string;
  /** How the cover image fills its box (CSS object-fit). Default "cover". */
  imageFit?: "cover" | "contain";
  /** Cover image aspect ratio (width / height). Default 16/9. */
  imageAspectRatio?: number;
  /** Minimum card width in px, driving the responsive grid. */
  cardSize?: number;
  /**
   * Every key of this view that Geode itself does not model, preserved
   * verbatim so writing the file back never destroys it.
   *
   * `.base` files are hand-editable, and plugin-registered view types (see
   * `Plugin.registerBasesView`) store their own settings here — a Kanban view
   * keeps `columnOrders`, `columnColors`, `collapsedLanes` and friends. The
   * schema below is therefore open, not closed: anything unrecognised lands
   * here on read and is spread back out on write.
   *
   * `undefined` (not `{}`) when the view had no unknown keys, so a plain
   * table view round-trips byte-identically.
   */
  extra?: Record<string, unknown>;
}

/** View keys this module models explicitly; everything else goes to `BaseViewDefinition.extra`. */
const KNOWN_VIEW_KEYS: ReadonlySet<string> = new Set([
  "type",
  "name",
  "limit",
  "groupBy",
  "filters",
  "order",
  "sort",
  "summaries",
  "image",
  "imageFit",
  "imageAspectRatio",
  "cardSize",
]);

export interface BasePropertyConfig {
  displayName?: string;
  /**
   * Per-property config keys Geode does not model (property type hints,
   * per-value colours, …), preserved for the same reason as
   * `BaseViewDefinition.extra`. `undefined` when there are none.
   */
  extra?: Record<string, unknown>;
}

/** Per-property keys this module models explicitly; everything else goes to `BasePropertyConfig.extra`. */
const KNOWN_PROPERTY_KEYS: ReadonlySet<string> = new Set(["displayName"]);

/**
 * Split a raw record into the keys `known` covers and everything else.
 * Returns `undefined` for the remainder when nothing is left over, so callers
 * can leave the `extra` field unset rather than writing an empty object.
 */
function unknownKeys(rec: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(rec)) {
    if (known.has(k)) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : undefined;
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

  if (typeof rec.image === "string") view.image = rec.image;
  if (rec.imageFit === "cover" || rec.imageFit === "contain") view.imageFit = rec.imageFit;
  if (typeof rec.imageAspectRatio === "number" && rec.imageAspectRatio > 0) view.imageAspectRatio = rec.imageAspectRatio;
  if (typeof rec.cardSize === "number" && rec.cardSize > 0) view.cardSize = rec.cardSize;

  // Note the asymmetry: a *known* key holding a malformed value is still
  // dropped (this parser's long-standing lenient normalization, documented on
  // `parseBaseFile`). Only genuinely unrecognised keys are preserved.
  const extra = unknownKeys(rec, KNOWN_VIEW_KEYS);
  if (extra) view.extra = extra;

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
      const extra = valRec ? unknownKeys(valRec, KNOWN_PROPERTY_KEYS) : undefined;
      properties[key] = extra ? { displayName, extra } : { displayName };
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
