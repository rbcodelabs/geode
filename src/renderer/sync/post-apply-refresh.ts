import type { SyncApplyOutcome } from "../../shared/sync-safety";
import type { ReconcileChange } from "../reconciliation";

export interface PostApplyRefreshDeps {
  hasFile(path: string): boolean;
  hasFolder(path: string): boolean;
  /** Refresh editors and the live vault model for exactly these changes. No scan, no manifest. Resolves when done (or failed: see `successCount`). */
  refreshChanges(changes: ReconcileChange[]): Promise<void>;
  /** A full vault rescan; used only when the host cannot say what its apply changed. */
  refreshAll(): Promise<void>;
  /** A full reconcile that is running right now, if any: scoped refreshes never overlap it. */
  fullInFlight(): Promise<unknown> | null;
  /** Counts refreshes that really completed; a refresh that fails internally leaves it unchanged. */
  successCount(): number;
  reloadPortableSettings(): Promise<void>;
  /** Make every view read-only until a refresh completes (the hold is lifted by that refresh, not by this module). */
  holdStale(token: string): void;
  finishGuard(token: string): void;
  /** Throws if the vault window this guard belonged to is gone. */
  assertLive(): void;
  /** How long a release waits for its refresh before handing the hold to the refresh itself. Default 4000. */
  slowMs?: number;
}

/**
 * What runs when a guarded sync apply releases its editor guard. The guard exists so no editor writes over (or keeps showing)
 * bytes that sync just changed on disk, so release must not complete until the editors have been refreshed.
 *
 * - A host that reports what it changed (the mobile host) gets a refresh of that path alone, queued by path and drained in
 *   batches, instead of one rescan of the whole vault per applied file. On a 10,000-file vault a rescan takes longer than
 *   the guard's patience, which used to fail every apply and with it the run.
 * - A host that cannot say (desktop) still rescans, exactly as before.
 * - Slow is not failed. When the refresh outlasts `slowMs` the release returns normally, views are made inert (`holdStale`)
 *   and the refresh itself lifts that hold when it completes. Writers therefore stay read-only until a refresh really
 *   completed, whether or not the sync waited for it. A refresh that FAILS still fails the apply, as before: the sync
 *   retries and the hold stays.
 */
export class PostApplyRefresh {
  private pending = new Map<string, ReconcileChange>();
  private drain: Promise<void> | null = null;
  constructor(private readonly deps: PostApplyRefreshDeps) {}

  /** The change a guarded apply amounts to, from its own report (no scan). Null: nothing to refresh. */
  changeFor(outcome: SyncApplyOutcome): ReconcileChange | null {
    const path = outcome.path, now = Date.now();
    if (outcome.kind === "trash") {
      if (this.deps.hasFile(path)) return { event: "delete", path };
      return this.deps.hasFolder(path) ? { event: "delete-folder", path } : null;
    }
    if (outcome.kind === "mkdir") return this.deps.hasFolder(path) ? null : { event: "create-folder", path, entry: { path, isFolder: true, mtime: now, ctime: now, size: 0 } };
    return { event: this.deps.hasFile(path) ? "modify" : "create", path, entry: { path, isFolder: false, mtime: now, ctime: now, size: outcome.size ?? 0 } };
  }

  /** Queue by path (a later change replaces an earlier one) and let one drain apply whatever has accumulated. */
  private enqueue(change: ReconcileChange): Promise<void> {
    this.pending.set(change.path, change);
    if (!this.drain) {
      const drain = (async () => {
        try {
          while (this.pending.size) {
            const running = this.deps.fullInFlight();
            if (running) await running.catch(() => {});
            const batch = [...this.pending.values()]; this.pending.clear();
            await this.deps.refreshChanges(batch);
          }
        } finally { this.drain = null; }
      })();
      this.drain = drain;
    }
    return this.drain;
  }

  async release(token: string, outcome?: SyncApplyOutcome): Promise<void> {
    const deps = this.deps;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const before = deps.successCount();
    try {
      if (outcome?.namespace === "portable-config") {
        // Settings and theme assets are not vault files: nothing to rescan, only the settings to re-read.
        await deps.reloadPortableSettings();
        deps.finishGuard(token);
        return;
      }
      if (outcome && !outcome.changed) { deps.finishGuard(token); return; } // the apply failed and left the path alone
      const change = outcome ? this.changeFor(outcome) : null;
      if (outcome && !change) { deps.finishGuard(token); return; }
      const refresh = change ? this.enqueue(change) : deps.refreshAll();
      const state = await Promise.race([refresh.then(() => "done" as const), new Promise<"slow">(resolve => { timeout = setTimeout(() => resolve("slow"), deps.slowMs ?? 4000); })]);
      if (state === "slow") { deps.assertLive(); deps.holdStale(token); return; }
      if (deps.successCount() === before) throw new Error("Editor refresh incomplete");
      deps.assertLive();
      if (!outcome) await deps.reloadPortableSettings();
      deps.finishGuard(token);
    } catch (error) {
      deps.assertLive();
      deps.holdStale(token);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
