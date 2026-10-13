import type { SyncStatus } from "./types";

export interface StatusRefreshOptions {
  /** Subscribe to sync status events; returns the unsubscribe. */
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Whether the thing being redrawn is still on screen (and is the current render). */
  isLive(): boolean;
  /** True while the user is typing in a field of the panel: a redraw would eat their input, so it waits. */
  isEditing(): boolean;
  redraw(): void;
  debounceMs?: number;
  /** Re-check interval while the user is editing. */
  editingRetryMs?: number;
}

/** What a redraw would change on screen; progress ticks (which the progress widget paints itself) are deliberately not part of it. */
export const syncStatusKey = (status: SyncStatus): string => JSON.stringify([status.state, status.message ?? "", status.conflicts, status.providerId ?? ""]);

/**
 * Keeps a settings panel in step with the sync service: redraws (debounced) when the visible status changes, never mid-edit, and
 * stops itself the moment the panel is gone. Returns the stop function the panel's teardown must call.
 */
export function watchSyncStatus(initial: SyncStatus, options: StatusRefreshOptions): () => void {
  const debounce = options.debounceMs ?? 250, retry = options.editingRetryMs ?? 1000;
  let shown = syncStatusKey(initial), timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const stop = () => { stopped = true; clearTimeout(timer); unsubscribe(); };
  const attempt = () => {
    timer = undefined;
    if (stopped) return;
    if (!options.isLive()) { stop(); return; }
    if (options.isEditing()) { timer = setTimeout(attempt, retry); return; }
    stop(); // the redraw builds a new panel with its own watcher
    options.redraw();
  };
  const unsubscribe = options.subscribe(status => {
    if (stopped) return;
    if (!options.isLive()) { stop(); return; }
    if (syncStatusKey(status) === shown || timer !== undefined) return;
    shown = syncStatusKey(status);
    timer = setTimeout(attempt, debounce);
  });
  return stop;
}
