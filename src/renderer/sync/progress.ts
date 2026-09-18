import { SYNC_MAX_FILE_BYTES } from "./history-types";
import type { SyncProgressPhase, SyncStatusProgress } from "./types";

/**
 * Status is an event bus with real subscribers (conflict banners re-scan every
 * open leaf on each one), so a 17,251-operation batch must not become 17,251
 * events. 250 ms caps the bus at 4 updates/sec: fast enough that a counter
 * looks live to a human, slow enough that the cost is bounded no matter how
 * large the batch. Phase changes and the terminal tick bypass this entirely —
 * a swallowed last update is what leaves a panel frozen at 96%.
 */
export const SYNC_PROGRESS_THROTTLE_MS = 250;

/**
 * How long "no progress at all" must last before it is called a stall.
 *
 * The floor is the slowest *legitimate* gap between two ticks. Ticks are
 * emitted per operation and once more per network leg inside an operation, so
 * the worst honest gap is one leg carrying a single file at the 100 MiB cap
 * (SYNC_MAX_FILE_BYTES). At a pessimistic sustained 500 KiB/s that leg takes
 * ~3.5 minutes, so anything at or below that would fire on a merely slow large
 * upload. Five minutes clears it with ~45% headroom.
 *
 * The ceiling is usefulness. This is warn-only — nothing is cancelled, retried
 * or aborted — so the cost of being slightly early is one sentence on screen,
 * while the cost of being late is the 40-minute blank panel this exists to
 * prevent. Five minutes is the smallest value that never accuses a slow link.
 */
export const SYNC_STALL_THRESHOLD_MS = 5 * 60_000;

/** Documents the arithmetic above so a change to the file cap re-opens the question. */
export const SYNC_STALL_WORST_HONEST_LEG_MS = Math.round((SYNC_MAX_FILE_BYTES / (500 * 1024)) * 1000);

const PHASE_LABELS: Record<SyncProgressPhase, string> = {
  scanning: "Scanning remote history",
  planning: "Planning changes",
  staging: "Preparing files",
  transferring: "Transferring",
  finalizing: "Finishing up",
};

export const syncPhaseLabel = (phase: SyncProgressPhase): string => PHASE_LABELS[phase] ?? phase;

/** Milliseconds since the last progress tick. 0 when there is no run in flight. */
export const syncStalledFor = (progress: SyncStatusProgress | undefined, now: number): number =>
  progress ? Math.max(0, now - progress.lastProgressAt) : 0;

export const isSyncStalled = (progress: SyncStatusProgress | undefined, now: number): boolean =>
  syncStalledFor(progress, now) >= SYNC_STALL_THRESHOLD_MS;

/** Whole-number percent, or null when the batch is not countable yet (scan/plan). */
export const syncProgressPercent = (progress: { completed: number; total: number }): number | null => {
  if (!Number.isFinite(progress.total) || progress.total <= 0) return null;
  const ratio = progress.completed / progress.total;
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)));
};

/** Compact and non-jittery: the largest two units, so the text does not change width every tick. */
export function formatSyncDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function formatSyncProgressCounts(progress: { completed: number; total: number }): string {
  const percent = syncProgressPercent(progress);
  if (percent === null) return "";
  return `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} (${percent}%)`;
}

export interface SyncProgressView {
  phaseLabel: string;
  /** "1,234 / 17,251 (7%)", or "" while the batch size is still unknown. */
  counts: string;
  /** null renders an indeterminate bar rather than a misleading 0%. */
  percent: number | null;
  path: string;
  elapsed: string;
  stalled: boolean;
  /** "" unless stalled. Names the file, because that is the single most useful datum. */
  stallMessage: string;
  /**
   * Deliberately coarse. The visual counter changes 4x/sec; this is what a
   * screen reader is given, and callers only re-announce it when it changes.
   */
  announcement: string;
}

/**
 * The entire rendering decision for a progress tick, as a pure function, so the
 * wording and the stall arithmetic are testable without a DOM or a live sync.
 */
export function describeSyncProgress(progress: SyncStatusProgress, now: number): SyncProgressView {
  const phaseLabel = syncPhaseLabel(progress.phase);
  const percent = syncProgressPercent(progress);
  const counts = formatSyncProgressCounts(progress);
  const path = progress.currentPath ?? "";
  const elapsed = formatSyncDuration(Math.max(0, now - progress.startedAt));
  const stalledFor = syncStalledFor(progress, now);
  const stalled = stalledFor >= SYNC_STALL_THRESHOLD_MS;
  const stallMessage = stalled
    ? `No progress for ${formatSyncDuration(stalledFor)}${path ? ` — stuck on ${path}` : ""}. Sync has not been cancelled; it is still waiting.`
    : "";
  // Announcements are bucketed to 10% so a screen reader hears "30%", "40%" over
  // a long run instead of every one of 17,251 individual counter updates.
  const bucket = percent === null ? null : Math.floor(percent / 10) * 10;
  const announcement = stalled
    ? `Sync stalled. ${stallMessage}`
    : bucket === null
      ? `${phaseLabel}.`
      : `${phaseLabel}, ${bucket}% of ${progress.total.toLocaleString()} operations.`;
  return { phaseLabel, counts, percent, path, elapsed, stalled, stallMessage, announcement };
}
