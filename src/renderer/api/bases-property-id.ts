/**
 * `BasesPropertyId` handling.
 *
 * Obsidian's Bases config addresses a property by a prefixed id —
 * `` `${'note' | 'formula' | 'file'}.${string}` `` — where the prefix names
 * the *source* of the value: frontmatter, a base formula, or an intrinsic file
 * attribute. Geode's expression engine is looser: it also accepts a bare
 * shorthand (`status`) and a `this.` root (see `../bases/ast.ts`), and
 * `resolveColumns` can hand back either form.
 *
 * That difference is not cosmetic. A view calls `parsePropertyId(id).name` to
 * decide which frontmatter key to *write*, so handing a plugin a bare id would
 * make it write to the wrong key. Ids are therefore normalized to prefixed
 * form at the API boundary, and never inside the engine.
 */

export type BasesPropertyType = "note" | "formula" | "file";

/** `note.status`, `file.name`, `formula.total`. */
export type BasesPropertyId = `${BasesPropertyType}.${string}`;

export interface BasesProperty {
  type: BasesPropertyType;
  name: string;
}

const PROPERTY_TYPES: ReadonlySet<string> = new Set<BasesPropertyType>(["note", "formula", "file"]);

/**
 * Split a property id into its source and name.
 *
 * Only the first dot is a separator — a nested frontmatter path keeps the rest
 * of its dots (`note.meta.owner` -> `{type: "note", name: "meta.owner"}`).
 * An id with no recognised prefix is treated as frontmatter shorthand, which
 * is how the engine already resolves a bare identifier.
 */
export function parsePropertyId(propertyId: string): BasesProperty {
  const dot = propertyId.indexOf(".");
  if (dot > 0) {
    const prefix = propertyId.slice(0, dot);
    if (PROPERTY_TYPES.has(prefix)) {
      return { type: prefix as BasesPropertyType, name: propertyId.slice(dot + 1) };
    }
  }
  return { type: "note", name: propertyId };
}

/**
 * Normalize an engine-side property path to a prefixed `BasesPropertyId`,
 * for handing out across the plugin API boundary.
 *
 * - already-prefixed ids pass through unchanged
 * - `this.foo` is rewritten to `note.foo`: `this` selects the contextual file,
 *   but the *property* it names is still frontmatter, and the prefix has to
 *   describe the source for `parsePropertyId(id).name` to resolve correctly
 * - anything else is shorthand for frontmatter, so it gains a `note.` prefix
 */
export function toPropertyId(path: string): BasesPropertyId {
  const dot = path.indexOf(".");
  if (dot > 0) {
    const prefix = path.slice(0, dot);
    if (PROPERTY_TYPES.has(prefix)) return path as BasesPropertyId;
    if (prefix === "this") return `note.${path.slice(dot + 1)}`;
  }
  return `note.${path}`;
}

/**
 * No inverse of `toPropertyId` is needed: every `BasesPropertyId` is already a
 * valid engine expression, since `note`/`file`/`formula` are all `PropertyRoot`
 * values (`../bases/ast.ts`). Prefixed form is in fact the *safer* one to
 * evaluate — `shorthand` resolution consults `EvalContext.locals` first
 * (`property-path.ts`), so a bare `value` could be shadowed by a lambda
 * binding where `note.value` cannot.
 */
