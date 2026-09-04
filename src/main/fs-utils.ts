import type { Stats } from "node:fs";

/**
 * `stats.birthtimeMs` is unreliable on some filesystems (e.g. some Linux
 * ext filesystems report it as 0, meaning "unavailable") — fall back to
 * mtime in that case so a file's reported `ctime` never reports an
 * epoch-zero date. A `null` stat (e.g. the file doesn't exist) reports 0.
 */
export function birthtimeOf(st: Stats | null): number {
  if (!st) return 0;
  return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
}
