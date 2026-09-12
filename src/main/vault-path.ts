import * as path from "node:path";

/**
 * Resolve a vault-relative path against `root` and refuse anything that
 * escapes it. This is the single boundary every vault IPC handler resolves
 * through, so `..` components, absolute paths, and Windows drive-relative
 * paths all fail here rather than in whatever fs call comes next.
 */
export function resolveVaultPath(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes vault: ${rel}`);
  }
  return abs;
}
