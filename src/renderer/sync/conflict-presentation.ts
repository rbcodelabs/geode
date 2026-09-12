import type { HistoryComparisonBlocker, HistoryConflict, HistoryConflictComparison } from "./history-controller";

/* ------------------------------------------------------------------ *
 * Copy                                                                *
 * ------------------------------------------------------------------ */

export const SYNC_CONFLICT_BANNER_MESSAGE = "This note has conflicting versions. Review them before choosing which to sync.";
export const SYNC_CONFLICT_COMPARE_LABEL = "Compare & resolve";

/**
 * How many Settings conflict rows are offered the side-by-side comparison.
 * Each comparison takes the sync controller's single-owner slot, so the
 * upgrade pass is bounded. Rows past this bound keep the original
 * keep-local / accept-version workflow and say why — every conflict is still
 * listed and still resolvable.
 */
export const SYNC_CONFLICT_COMPARE_ROW_LIMIT = 100;

export const SYNC_CONFLICT_DIALOG_TITLE = "Compare & resolve conflicting versions";
export const SYNC_CONFLICT_DIALOG_SUBTITLE =
  "Both versions are shown read-only. Nothing is synced until you choose one of the actions below.";
export const SYNC_CONFLICT_LOCAL_PANEL_TITLE = "This device's saved version";
export const SYNC_CONFLICT_REMOTE_PANEL_TITLE = "Synced version";

export const SYNC_CONFLICT_CANCEL_LABEL = "Cancel";
export const SYNC_CONFLICT_KEEP_LOCAL_LABEL = "Keep this device's version";
export const SYNC_CONFLICT_USE_REMOTE_LABEL = "Use selected synced version";

export const SYNC_CONFLICT_LOADING_TEXT = "Loading…";
export const SYNC_CONFLICT_STALE_HEADS_MESSAGE =
  "Another version arrived while you were comparing. Close this dialog and compare again.";
export const SYNC_CONFLICT_UNKNOWN_ERROR = "This version could not be loaded. Nothing has been synced; close and try again.";

/**
 * Conflict rows in Settings that cannot be compared keep the original
 * keep-local / accept-version workflow, so the description has to say what the
 * remaining buttons still do as well as why comparison is unavailable.
 */
const BUTTON_FALLBACK = "Keep local publishes this device's current content; Accept version publishes that explicit immutable version.";

const BLOCKER_REASON: Record<HistoryComparisonBlocker, string> = {
  "portable-config": "This is a synced app-configuration file, not a note, so there is no text comparison.",
  folder: "One of the conflicting versions is a folder, so there is no text to compare.",
  "deleted-version": "One of the conflicting versions deletes this item, so there is no text to compare.",
  "rename-or-move": "The conflicting versions disagree about this item's name or folder, so a same-path comparison would be misleading.",
  "non-markdown": "Only Markdown notes can be compared as text.",
  "missing-content": "The content of at least one version is not available on this device yet.",
  oversize: "This file is too large to load into a comparison view.",
};

export function describeComparisonBlocker(blocker: HistoryComparisonBlocker): string {
  return `${BLOCKER_REASON[blocker]} ${BUTTON_FALLBACK}`;
}

/** Shown when the comparison itself could not be described (e.g. read failure). */
export const SYNC_CONFLICT_UNDESCRIBED_FALLBACK =
  `Comparison is unavailable for this conflict right now. ${BUTTON_FALLBACK}`;

/*
 * Dialog variants.
 *
 * The banner cannot know whether a conflict is comparable without an async
 * describe, so it offers "Compare & resolve" for every content conflict and the
 * dialog may discover the answer is no. At that point the Settings wording above
 * is actively misleading: it names Keep local / Accept version, which are not in
 * the dialog, are disabled, and are not on screen. Point at where they live
 * instead, or the user is left at a dead end.
 */
const DIALOG_FALLBACK =
  "Nothing has been synced. Resolve this conflict from Settings → Sync, where this note is listed.";

export function describeComparisonBlockerForDialog(blocker: HistoryComparisonBlocker): string {
  return `${BLOCKER_REASON[blocker]} ${DIALOG_FALLBACK}`;
}

export const SYNC_CONFLICT_UNDESCRIBED_DIALOG_FALLBACK =
  `Comparison is unavailable for this conflict right now. ${DIALOG_FALLBACK}`;

/* ------------------------------------------------------------------ *
 * Head labels                                                         *
 * ------------------------------------------------------------------ */

/**
 * Records carry an opaque `deviceId` and nothing else identifying — no friendly
 * device name, no author, and no clock we could trust across devices. Labels are
 * therefore a short hex fragment only: enough to tell two heads apart, with no
 * implied authorship, recency or ordering.
 */
const shortId = (id: string): string => {
  const hex = id.replace(/[^0-9a-fA-F]/g, "").slice(0, 4).toUpperCase();
  return hex.length === 4 ? hex : hex.padEnd(4, "0");
};

export function formatHeadLabels(heads: ReadonlyArray<{ recordId: string; deviceId: string }>): string[] {
  const base = heads.map((head) => `Device ${shortId(head.deviceId)}`);
  const counts = new Map<string, number>();
  for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);
  // Two heads can legitimately share a device (a device that published twice on
  // divergent parents), so fall back to a record fragment rather than a counter,
  // which would read as an ordering.
  return base.map((label, index) => (counts.get(label)! > 1 ? `${label} · version ${shortId(heads[index].recordId)}` : label));
}

/* ------------------------------------------------------------------ *
 * Settings row plan                                                   *
 * ------------------------------------------------------------------ */

export interface ConflictRowPlan {
  /** `setting-item` description text. */
  description: string;
  /** `compare` replaces the per-head buttons with a single compare action. */
  mode: "compare" | "fallback";
  /** Extra explanatory line rendered only in `fallback` mode. */
  fallback: string | null;
}

const FALLBACK_DESCRIPTION = "Choose the current local content or an explicit immutable version; unseen concurrent versions remain conflicts.";
const COMPARE_DESCRIPTION = "Review both versions side by side before choosing which one to sync; unseen concurrent versions remain conflicts.";

export function planConflictRow(
  conflict: HistoryConflict,
  comparison: HistoryConflictComparison | null | undefined,
): ConflictRowPlan {
  if (comparison?.comparable) return { description: `${conflict.reason}. ${COMPARE_DESCRIPTION}`, mode: "compare", fallback: null };
  const fallback = comparison?.notComparable ? describeComparisonBlocker(comparison.notComparable) : SYNC_CONFLICT_UNDESCRIBED_FALLBACK;
  return { description: `${conflict.reason}. ${FALLBACK_DESCRIPTION}`, mode: "fallback", fallback };
}
