/**
 * Per-path settle windows.
 *
 * The scan's global `settleMs` (default 5 s) only protects against half-written files. A file that is *continuously*
 * appended to (a Claude session log: `Claude/logs/<id>.jsonl`, up to ~100 MB) is stable for a few seconds between
 * appends, so it passes that window and is published as a brand-new whole-file blob on every sync (a 30 MB log
 * synced every ~20 s for a day is ~8 GB of hub blobs). A settle rule defers matching files until they have been
 * quiet for `ms`, so a growing file is stored once per quiet period instead of once per sync.
 *
 * A deferred file is reported as `blocked: unsettled`, which the engine already treats as untouchable (never
 * published, never deleted, never overwritten), so it syncs normally on the first run after the window.
 */
export interface SettleRule {
  /** `*.ext` matches by extension anywhere; anything else is a vault-relative folder prefix (`Claude/logs`). */
  match: string;
  /** Quiet period in ms. 0 disables deferral for matching paths (use it to opt a path out of a broader rule). */
  ms: number;
}

export const SETTLE_REASON = "unsettled";
export const DEFAULT_LOG_SETTLE_MS = 10 * 60_000;
export const DEFAULT_SETTLE_RULES: readonly SettleRule[] = [
  { match: "Claude/logs", ms: DEFAULT_LOG_SETTLE_MS },
  { match: "*.jsonl", ms: DEFAULT_LOG_SETTLE_MS },
];

const normalise = (match: string) => match.trim().replace(/^\/+|\/+$/g, "");

/** Specificity: a folder rule beats an extension rule; a longer folder beats a shorter one. -1 = no match. */
function matchSpecificity(rule: SettleRule, path: string): number {
  const match = normalise(rule.match);
  if (!match) return -1;
  if (match.startsWith("*.")) return path.toLowerCase().endsWith(match.slice(1).toLowerCase()) ? 1 : -1;
  return path === match || path.startsWith(match + "/") ? 2 + match.length : -1;
}

/** The quiet period that applies to `path`: the most specific matching rule, or 0 when none matches. */
export function settleMsFor(path: string, rules: readonly SettleRule[]): number {
  let best = -1, ms = 0;
  for (const rule of rules) {
    const score = matchSpecificity(rule, path);
    if (score >= best && score >= 0) { best = score; ms = rule.ms; } // later rule wins a tie
  }
  return ms;
}

/** Parses `<folder-or-*.ext>=<ms>` (the CLI's `--settle-rule`). Returns an error string when malformed. */
export function parseSettleRule(text: string): SettleRule | string {
  const at = text.lastIndexOf("=");
  if (at <= 0) return `Invalid settle rule "${text}": expected <folder-or-*.ext>=<milliseconds>`;
  const match = normalise(text.slice(0, at)), raw = text.slice(at + 1).trim();
  if (!match) return `Invalid settle rule "${text}": empty path`;
  if (!/^\d+$/.test(raw)) return `Invalid settle rule "${text}": milliseconds must be a non-negative integer`;
  return { match, ms: Number(raw) };
}

/** User rules replace defaults with the same `match`; the remaining defaults still apply. */
export function mergeSettleRules(user: readonly SettleRule[] | undefined, defaults: readonly SettleRule[] = DEFAULT_SETTLE_RULES): SettleRule[] {
  const overridden = new Set((user ?? []).map(rule => normalise(rule.match)));
  return [...defaults.filter(rule => !overridden.has(normalise(rule.match))), ...(user ?? [])];
}

/** True when `path`, last modified at `mtimeMs`, is still inside its settle window at `nowMs`. A future mtime never settles. */
export function isUnsettled(path: string, mtimeMs: number, nowMs: number, rules: readonly SettleRule[]): boolean {
  const ms = settleMsFor(path, rules);
  return ms > 0 && nowMs - mtimeMs < ms;
}
