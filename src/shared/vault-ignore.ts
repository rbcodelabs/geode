/**
 * The single definition of "this path is invisible to the vault".
 *
 * Both the initial walk (`vault-files.ts`) and the live watcher
 * (`vault-watcher.ts`) must agree on this rule, otherwise the watcher can
 * announce files the file list never contained (or vice versa).
 *
 * The rule itself — ignore any path with a dot-prefixed segment — is
 * load-bearing, not cosmetic. `.geode/metadata-cache/cache.json` is rewritten
 * by the debounced indexer writer on every metadata change
 * (`src/indexer/indexer-process.ts`), so a watcher that reports it feeds the
 * indexer its own output: cache write -> watch event -> reindex -> cache
 * write. See `docs/adr/0001-community-install-from-github.md` for why
 * dot-directories stay out of the vault surface.
 */

/** True when a single path component makes its whole subtree invisible. */
export function isIgnoredSegment(segment: string): boolean {
  return segment.startsWith(".");
}

/**
 * True when any segment of a vault-relative path is ignored.
 *
 * Tested segment-wise rather than on the basename alone. A basename test is
 * only sufficient when the caller prunes during traversal (chokidar's
 * `ignored` predicate, or a `readdir` recursion that never descends). A
 * recursive `fs.watch` has no traversal hook and delivers deep paths
 * directly, so `.geode/metadata-cache/cache.json` — whose basename is not
 * dotted — would otherwise pass straight through.
 *
 * The empty string is the vault root and is never ignored.
 */
export function isIgnoredVaultPath(relativePath: string): boolean {
  if (!relativePath) return false;
  for (const segment of relativePath.split(/[\\/]/)) {
    if (segment && isIgnoredSegment(segment)) return true;
  }
  return false;
}
