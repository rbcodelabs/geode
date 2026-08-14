import type { TFile } from "../types";
import { PropertyRoot } from "./ast";
import { EvalContext } from "./eval-context";
import { evaluateFormula } from "./formula-engine";
import { dispatchMethod } from "./functions";
import { BaseValue, bool, dateValue, fileValue, linkValue, listValue, nullValue, num, objectValue, str } from "./value";

/** `[[target]]` or `[[target|display]]`, per Obsidian wikilink syntax. */
const WIKILINK_RE = /^\[\[(.+?)\]\]$/;

/**
 * Coerce a raw frontmatter value (as parsed by the `yaml` package) into a
 * `BaseValue`. `instanceof Date` is handled defensively per the spec's
 * guidance, but in practice this repo's `yaml.parse` call
 * (`src/renderer/metadata-cache.ts`) uses the default "core" schema, which
 * does NOT resolve unquoted date-shaped scalars (`due: 2025-06-01`) to a
 * native `Date` — confirmed with a throwaway probe against the `yaml`
 * package actually vendored here. So date-shaped frontmatter values arrive
 * as plain strings and stay plain strings here; only an explicit `date(...)`
 * formula call produces a `BaseValue` of type `"date"`. This is a
 * deliberate, spec-consistent judgment call (see the phase report).
 */
export function frontmatterValueToBaseValue(raw: unknown, ctx: EvalContext): BaseValue {
  if (raw === null || raw === undefined) return nullValue();
  if (raw instanceof Date) return dateValue(raw.getTime());
  if (typeof raw === "string") {
    const linkMatch = raw.match(WIKILINK_RE);
    if (linkMatch) {
      const inner = linkMatch[1];
      const pipe = inner.indexOf("|");
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const display = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
      const resolved = ctx.metadataCache.getFirstLinkpathDest(target, ctx.file.path);
      return linkValue(target, resolved, display);
    }
    return str(raw);
  }
  if (typeof raw === "number") return num(raw);
  if (typeof raw === "boolean") return bool(raw);
  if (Array.isArray(raw)) return listValue(raw.map((item) => frontmatterValueToBaseValue(item, ctx)));
  if (typeof raw === "object") {
    const entries: Record<string, BaseValue> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      entries[k] = frontmatterValueToBaseValue(v, ctx);
    }
    return objectValue(entries);
  }
  return nullValue();
}

/**
 * The `file`/`this` namespace field table, per the spec's property-namespace
 * list. Exported so `functions/file-methods.ts` can reuse it for the field
 * names that are also accessible as `BaseValue["type"] === "file"` fields
 * (e.g. `someFileValue.name`), instead of duplicating the table.
 */
export function fileNamespaceField(file: TFile, name: string, ctx: EvalContext): BaseValue {
  const cache = ctx.metadataCache.getFileCache(file);
  switch (name) {
    case "name":
      return str(file.name);
    case "basename":
      return str(file.basename);
    case "path":
      return str(file.path);
    case "folder":
      return str(file.parent);
    case "ext":
      return str(file.extension);
    case "size":
      return num(file.size);
    case "ctime":
      return dateValue(file.ctime);
    case "mtime":
      return dateValue(file.mtime);
    case "tags":
      return listValue((cache?.tags ?? []).map((t) => str(t.tag)));
    case "links":
      return listValue(
        (cache?.links ?? []).map((l) =>
          linkValue(
            l.link,
            ctx.metadataCache.getFirstLinkpathDest(l.link, file.path),
            l.displayText !== l.link ? l.displayText : undefined
          )
        )
      );
    case "backlinks": {
      // getBacklinks() is typed unknown[] on the narrow MetadataCacheReader
      // interface (see eval-context.ts); the real MetadataCache returns
      // {source: TFile; count: number}[], which is what we actually get here.
      const backlinks = ctx.metadataCache.getBacklinks(file) as { source: TFile }[];
      return listValue(backlinks.map((b) => fileValue(b.source)));
    }
    case "embeds":
      return listValue(
        (cache?.embeds ?? []).map((l) =>
          linkValue(
            l.link,
            ctx.metadataCache.getFirstLinkpathDest(l.link, file.path),
            l.displayText !== l.link ? l.displayText : undefined
          )
        )
      );
    case "properties": {
      const fm = cache?.frontmatter ?? {};
      const entries: Record<string, BaseValue> = {};
      for (const [k, v] of Object.entries(fm)) entries[k] = frontmatterValueToBaseValue(v, ctx);
      return objectValue(entries);
    }
    case "file":
      return fileValue(file);
    default:
      return nullValue();
  }
}

/**
 * Walk any segments left over after the first namespace lookup (e.g. the
 * `name` in `note.author.name` when frontmatter has `author: {name: ...}`,
 * or a hypothetical `.year` after `file.mtime`). Object-type values use
 * literal dot-notation member lookup (the spec's "Objects: dot notation or
 * prop[\"subprop\"]" rule); every other type reuses `dispatchMethod` with an
 * empty args array, which is exactly how a parenthesis-less field access
 * (e.g. `.length`, `.year`) is evaluated elsewhere in this engine — so date/
 * string/list field tables aren't duplicated here.
 */
/**
 * Own-property-only lookup by a user-controlled key (a frontmatter property
 * name, or an object member name in a dot-notation chain). Both are
 * arbitrary text an author writes into YAML/an expression, so a bare
 * `obj[key]`/`key in obj` would incorrectly resolve names like "toString"
 * or "__proto__" to an inherited `Object.prototype` member instead of
 * "not present" — this guards every such lookup in this module.
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function walkRemainingSegments(value: BaseValue, segments: string[], ctx: EvalContext): BaseValue {
  let current = value;
  for (const seg of segments) {
    if (current.type === "object") {
      current = hasOwn(current.value, seg) ? current.value[seg] : nullValue();
    } else {
      current = dispatchMethod(current, seg, [], ctx);
    }
  }
  return current;
}

/**
 * Resolve a property path AST node (`note.<x>`, `file.<x>`, `formula.<x>`,
 * `this.<x>`, or bare shorthand) to a `BaseValue`. Never throws — any
 * unresolved path segment at any point produces `nullValue()`.
 *
 * `root === "file"`/`"this"` with zero segments is a real, common case: the
 * spec's own filter example calls methods directly on the namespace root
 * itself, e.g. `file.hasTag("tag")` — the parser produces a `methodCall`
 * wrapping `propertyPath(root:"file", segments:[])` for that (see
 * `parser.ts`'s `identifierLead`), so it must resolve to a `"file"`
 * `BaseValue` for the current (or `this`) file, not fall through to the
 * generic "no segments -> null" case below.
 */
export function resolvePropertyPath(path: { root: PropertyRoot; segments: string[] }, ctx: EvalContext): BaseValue {
  const { root, segments } = path;

  if (segments.length === 0) {
    if (root === "file") return fileValue(ctx.file);
    if (root === "this") return ctx.thisFile ? fileValue(ctx.thisFile) : nullValue();
    return nullValue();
  }

  if (root === "shorthand" && hasOwn(ctx.locals, segments[0])) {
    return walkRemainingSegments(ctx.locals[segments[0]], segments.slice(1), ctx);
  }

  switch (root) {
    case "shorthand":
    case "note": {
      const fm = ctx.frontmatter;
      if (!fm || !hasOwn(fm, segments[0])) return nullValue();
      return walkRemainingSegments(frontmatterValueToBaseValue(fm[segments[0]], ctx), segments.slice(1), ctx);
    }
    case "file":
      return walkRemainingSegments(fileNamespaceField(ctx.file, segments[0], ctx), segments.slice(1), ctx);
    case "this":
      if (!ctx.thisFile) return nullValue();
      return walkRemainingSegments(fileNamespaceField(ctx.thisFile, segments[0], ctx), segments.slice(1), ctx);
    case "formula":
      return walkRemainingSegments(evaluateFormula(segments[0], ctx), segments.slice(1), ctx);
    default:
      return nullValue();
  }
}
