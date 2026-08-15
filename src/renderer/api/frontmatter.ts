// ---------------------------------------------------------------------------
// Frontmatter / tag helper functions — Obsidian-compat module exports
// ---------------------------------------------------------------------------
//
// Obsidian exposes a family of module-level helpers for pulling normalized
// values out of a note's YAML frontmatter and metadata cache. Plugins call
// them directly (not via `app`), often deep inside cache-building loops.
//
// obsidian-tasks calls `parseFrontMatterTags(frontmatter)` per file while
// building its task Cache — when it was undefined the call threw an *uncaught*
// TypeError that aborted the whole scan, so no tasks were ever cached and
// every ```tasks query rendered empty. It also calls `getAllTags(cache)`.
//
// These are pure functions (no DOM, no app) — matching Geode's existing
// `normalizePath`/`parseMetadata` helper exports and unit-testable directly.

import type { CachedMetadata } from "../types";

/**
 * Normalize one raw frontmatter tag value to Obsidian's `#tag` form.
 * Strips a single leading `#` if present, trims, then re-prefixes. Returns
 * null for empty/whitespace so callers can filter.
 */
function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/^#/, "").trim();
  return t ? "#" + t : null;
}

/**
 * Read tags out of a note's parsed frontmatter, `#`-prefixed.
 *
 * Mirrors Obsidian: looks at both the `tags` and `tag` keys; each may be an
 * array of strings or a single string (comma/space/newline separated). Values
 * are normalized to `#tag`. Returns `null` when `frontmatter` is null/omitted
 * or carries no usable tags (that null-vs-empty distinction is what callers
 * like obsidian-tasks branch on).
 */
export function parseFrontMatterTags(frontmatter: Record<string, unknown> | null): string[] | null {
  if (!frontmatter) return null;
  const raw = frontmatter["tags"] ?? frontmatter["tag"];
  if (raw == null) return null;

  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [raw];

  const tags: string[] = [];
  for (const p of parts) {
    const norm = normalizeTag(p);
    if (norm) tags.push(norm);
  }
  return tags.length ? tags : null;
}

/**
 * Return every tag referenced by a note (frontmatter + inline body), each
 * `#`-prefixed and de-duplicated, or `null` if the note has none.
 *
 * Geode's metadata cache already folds frontmatter tags into `cache.tags`
 * (stored without the leading `#`) alongside inline `#tag` occurrences, so
 * this reads from that single source and re-prefixes — no risk of
 * double-counting a frontmatter tag. Order of first appearance is preserved.
 */
export function getAllTags(cache: CachedMetadata | null | undefined): string[] | null {
  if (!cache || !Array.isArray(cache.tags) || cache.tags.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cache.tags) {
    if (!t || typeof t.tag !== "string") continue;
    const tag = "#" + t.tag.replace(/^#/, "");
    if (tag === "#") continue;
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.length ? out : null;
}
