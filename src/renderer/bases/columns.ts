/**
 * Table-view column resolution: which property-path columns to show, and
 * their display names. Pure logic, split out of `views/bases/table-view.ts`
 * so it's unit-testable without DOM.
 */
import type { BaseDefinition } from "./base-file";
import type { TFile } from "../types";

/**
 * Resolve the effective, ordered list of column paths for a view.
 * `explicitOrder` is `view.order` (undefined/empty means "not set" — falls
 * back to "file.name" plus every known frontmatter property, per the spec's
 * "columns from properties (view.order, or all known properties if order is
 * unset)"). `knownPropertyKeys` are bare frontmatter keys (no "note."
 * prefix), already deduplicated by the caller (see `enumerateFrontmatterKeys`).
 */
export function resolveColumns(explicitOrder: string[] | undefined, knownPropertyKeys: string[]): string[] {
  if (explicitOrder && explicitOrder.length > 0) return explicitOrder;
  return ["file.name", ...knownPropertyKeys.map((k) => `note.${k}`)];
}

/** Display header text for a column path: `BaseDefinition.properties[path].displayName` override, else the raw path. */
export function columnDisplayName(def: Pick<BaseDefinition, "properties">, path: string): string {
  return def.properties[path]?.displayName?.trim() || path;
}

/** Is this column path backed by an editable frontmatter property (`note.*`/shorthand)? `file.*`/`formula.*` are computed, not editable. */
export function isEditableColumn(path: string): boolean {
  return !path.startsWith("file.") && !path.startsWith("formula.") && path !== "file" && path !== "formula";
}

/** Frontmatter key a `note.*` (or bare shorthand) column path writes to when edited. `null` for non-note columns. */
export function frontmatterKeyForColumn(path: string): string | null {
  if (!isEditableColumn(path)) return null;
  return path.startsWith("note.") ? path.slice("note.".length) : path;
}

/**
 * Coerce a table cell's edited raw text into the value written to
 * frontmatter. Numeric- and boolean-shaped text become real numbers/
 * booleans (so e.g. sorting/filtering a numeric property keeps working
 * after a table edit); everything else is stored as plain text. Empty text
 * means "clear this property" — represented as `undefined` so
 * `patchFrontmatter`'s caller can `delete` the key rather than writing an
 * empty string.
 */
export function parseEditedValue(raw: string): string | number | boolean | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (!Number.isNaN(Number(trimmed))) return Number(trimmed);
  return raw;
}

/** Distinct frontmatter keys across a set of files, sorted — the "known vault properties" the Filter/Properties panels offer. */
export function enumerateFrontmatterKeys(
  files: TFile[],
  getFrontmatter: (file: TFile) => Record<string, unknown> | null
): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    const fm = getFrontmatter(file);
    if (fm) for (const key of Object.keys(fm)) keys.add(key);
  }
  return Array.from(keys).sort();
}
