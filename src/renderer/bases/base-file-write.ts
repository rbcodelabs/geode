import { stringify as stringifyYaml } from "yaml";
import type { BaseDefinition, BaseViewDefinition } from "./base-file";

/** Shallow-drop `undefined`-valued keys so `yaml.stringify` doesn't emit `key: null`/`key:` for fields the caller left unset. */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function viewToRaw(view: BaseViewDefinition): Record<string, unknown> {
  return omitUndefined({
    type: view.type,
    name: view.name,
    limit: view.limit,
    groupBy: view.groupBy ? { property: view.groupBy.property, direction: view.groupBy.direction } : undefined,
    filters: view.filters,
    order: view.order,
    sort: view.sort,
    summaries: view.summaries && Object.keys(view.summaries).length ? view.summaries : undefined,
  });
}

/**
 * Serialize an in-memory `BaseDefinition` back to `.base` YAML text — the
 * inverse of `parseBaseFile`. Used whenever the toolbar UI (filters, sort,
 * group-by, column order, formulas, summaries, views) mutates the
 * definition and needs to persist it back to the file.
 *
 * Not a byte-for-byte round trip of hand-authored YAML (comments/formatting
 * aren't preserved — `parseBaseFile` doesn't keep them either), but
 * `parseBaseFile(stringifyBaseFile(def)).def` is structurally equivalent to
 * `def` for every field this module understands.
 */
export function stringifyBaseFile(def: BaseDefinition): string {
  const properties: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(def.properties)) {
    if (cfg.displayName) properties[key] = { displayName: cfg.displayName };
  }

  const raw = omitUndefined({
    filters: def.filters,
    formulas: Object.keys(def.formulas).length ? def.formulas : undefined,
    properties: Object.keys(properties).length ? properties : undefined,
    summaries: Object.keys(def.summaries).length ? def.summaries : undefined,
    views: def.views.map(viewToRaw),
  });

  return stringifyYaml(raw);
}
