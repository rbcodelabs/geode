/**
 * Pure decision logic for "is it time to check for an update yet?" — no
 * Electron imports, so it's testable without spinning up the app. See
 * docs/adr/0003-auto-update-mechanism.md.
 */

/** Default cadence between background update checks: 6 hours. */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Decide whether a background update check should run now.
 *
 * - Never checked before (`lastCheckedAt === null`) → always check.
 * - Clock skew (`now` before `lastCheckedAt`) → don't check; wait for the
 *   clock to catch back up rather than checking constantly.
 * - Otherwise → check once at least `intervalMs` has elapsed since the last
 *   check (inclusive of the boundary).
 */
export function shouldCheckForUpdates(
  lastCheckedAt: number | null,
  now: number,
  intervalMs: number = DEFAULT_UPDATE_CHECK_INTERVAL_MS
): boolean {
  if (lastCheckedAt === null) return true;
  if (now < lastCheckedAt) return false;
  return now - lastCheckedAt >= intervalMs;
}
