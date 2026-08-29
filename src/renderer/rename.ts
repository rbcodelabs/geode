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
export type RenamePathResult = { ok: true; path: string } | { ok: false; error: string };

/** Validate a user-entered basename and derive a same-folder, same-extension path. */
export function renamePathForBasename(currentPath: string, rawName: string): RenamePathResult {
  const name = rawName.trim();
  if (!name || /[\\/:#|^\[\]]/.test(name)) return { ok: false, error: "Invalid file name" };
  const slash = currentPath.lastIndexOf("/");
  const parent = slash >= 0 ? currentPath.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? currentPath.slice(slash + 1) : currentPath;
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot) : "";
  return { ok: true, path: `${parent}${name}${extension}` };
}
