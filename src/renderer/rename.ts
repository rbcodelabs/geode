const WIKILINK_TARGET_RE = /(!?\[\[)([^\[\]\n|#]+)([^\[\]\n]*\]\])/g;

/**
 * Rewrite `[[wikilink]]` targets in `text` that point at a renamed file, so
 * they point at its new basename instead. A link matches the renamed file
 * if its target equals (case-insensitively) the old basename, the old path
 * without its extension, or the old path verbatim — the same three forms
 * `getFirstLinkpathDest` accepts when resolving a link. Embeds (`![[...]]`),
 * piped display text, and `#heading`/`^block` suffixes are preserved as-is;
 * only the link target itself is replaced.
 *
 * Pure and side-effect-free: given the same inputs it always returns the
 * same output, independent of the vault/filesystem. Extracted from
 * `App.renameFileWithLinkUpdate`, which still owns the I/O (reading files,
 * deciding which files reference the renamed one, and writing the result).
 */
export function rewriteWikilinksForRename(
  text: string,
  oldBasename: string,
  oldPathNoExt: string,
  oldPath: string,
  newBasename: string
): string {
  const oldBasenameLower = oldBasename.toLowerCase();
  return text.replace(WIKILINK_TARGET_RE, (match, open, target, rest) => {
    const t = target.trim();
    if (t.toLowerCase() === oldBasenameLower || t === oldPathNoExt || t === oldPath) {
      return `${open}${newBasename}${rest}`;
    }
    return match;
  });
}
