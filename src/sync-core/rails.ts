import type { HistoryControllerState } from "./history-controller";

/**
 * Safety rails shared by every host that syncs unattended: the headless CLI (`src/sync-node/wiki-sync.ts`)
 * and the desktop hub provider (`src/renderer/sync/sync-service.ts`). Pure and platform neutral. The numbers
 * live here once so the two hosts cannot drift apart. See ADR 0025.
 */
export const MIN_DELETE_LIMIT = 20;
export const DELETE_LIMIT_FRACTION = 0.01;
export const MIN_SCAN_RATIO = 0.5;
export const deleteLimitFor = (vaultFiles: number): number => Math.max(MIN_DELETE_LIMIT, Math.floor(vaultFiles * DELETE_LIMIT_FRACTION));

/** Content files this device already tracks. The scan rail compares the next scan against this. */
export const knownFileCount = (state: HistoryControllerState | null): number =>
  state ? Object.values(state.baseline).filter(entry => entry.present && entry.kind === "file" && entry.namespace === "content").length : 0;

export type SyncRailStatus = "approval-required" | "approval-stale" | "delete-limit-exceeded" | "scan-shrunk";

/** A safety rail refused the run. Nothing was changed. `override` names the explicit action that lifts it. */
export class SyncRailError extends Error {
  constructor(readonly status: SyncRailStatus, message: string, readonly detail: Record<string, unknown>, readonly override: string | null) {
    super(message); this.name = "SyncRailError";
  }
}

/** One-shot, explicit, per rail. There is deliberately no "force everything". */
export interface SyncRailOverrides {
  /** Allow up to this many deletions (replaces the limit; does not disable it). */
  deleteLimit?: number;
  /** Proceed although the scan found under half of the previously known files. */
  shrunkScan?: boolean;
}

export function shrunkScanRefusal(known: number, found: number): SyncRailError | null {
  if (known <= 0 || found >= known * MIN_SCAN_RATIO) return null;
  return new SyncRailError("scan-shrunk", `The scan found ${found} files but this device previously knew ${known} (under ${MIN_SCAN_RATIO * 100}%). Is the volume mounted and --root correct?`,
    { found, known, ratio: Number((found / known).toFixed(3)), minimumRatio: MIN_SCAN_RATIO }, "--override-shrunk-scan");
}

export function deleteLimitRefusal(plan: { deletions: number; uploads: number; downloads: number; signature: string }, vaultFiles: number, overrides: SyncRailOverrides = {}): SyncRailError | null {
  const limit = overrides.deleteLimit ?? deleteLimitFor(vaultFiles);
  if (plan.deletions <= limit) return null;
  return new SyncRailError("delete-limit-exceeded", `This run would delete ${plan.deletions} items, over the limit of ${limit} (max(${MIN_DELETE_LIMIT}, ${DELETE_LIMIT_FRACTION * 100}% of ${vaultFiles} files)). Review with \`sync preview\`.`,
    { deletions: plan.deletions, limit, vaultFiles, uploads: plan.uploads, downloads: plan.downloads, signature: plan.signature }, "--override-delete-limit <n>");
}
