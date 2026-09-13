import type { HistoryConflict } from "./history-controller";
import { SYNC_CONFLICT_BANNER_MESSAGE, SYNC_CONFLICT_COMPARE_LABEL } from "./conflict-presentation";

/** The minimum a pane needs to know about a conflict to offer a comparison. */
export interface SyncConflictBannerInfo {
  entityId: string;
  path: string;
  heads: string[];
  reason: string;
}

/**
 * Advisory, not blocking: this banner never makes the note read-only. The
 * external-edit recovery banner (`MarkdownView.presentConflict`) owns that, and
 * owns its own element in a different slot, so the two can be visible together.
 */
export function buildSyncConflictBanner(onCompare: () => void): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "sync-conflict-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-label", "Sync conflict");
  const message = document.createElement("span");
  message.className = "sync-conflict-banner-message";
  message.textContent = SYNC_CONFLICT_BANNER_MESSAGE;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "sync-conflict-banner-action";
  action.textContent = SYNC_CONFLICT_COMPARE_LABEL;
  action.addEventListener("click", () => onCompare());
  banner.append(message, action);
  return banner;
}

/**
 * Owns one banner element inside a view's container, mounted between the view
 * header and the view body. Split out of `MarkdownView` so the placement and
 * lifecycle can be unit-tested without standing up CodeMirror.
 */
export class SyncConflictBannerSlot {
  private el: HTMLElement | null = null;
  private signature: string | null = null;

  constructor(private readonly container: HTMLElement, private readonly before: HTMLElement) {}

  get element(): HTMLElement | null {
    return this.el;
  }

  present(info: SyncConflictBannerInfo, onCompare: () => void): void {
    const signature = `${info.entityId}\u0000${[...info.heads].sort().join(",")}`;
    // Reuse only while the element is still in the slot we put it in — a view
    // rebuild that drops it must produce a fresh mount, not a silent no-op.
    if (this.el && this.el.parentNode === this.container && this.signature === signature) return;
    this.clear();
    const banner = buildSyncConflictBanner(onCompare);
    this.container.insertBefore(banner, this.before);
    this.el = banner;
    this.signature = signature;
  }

  clear(): void {
    this.el?.remove();
    this.el = null;
    this.signature = null;
  }
}

/** The slice of a pane the controller reconciles against sync state. */
export interface SyncConflictBannerView {
  readonly file: { path: string } | null;
  presentSyncConflict(info: SyncConflictBannerInfo, onCompare: () => void): void;
  clearSyncConflict(): void;
}

export interface SyncConflictBannerDeps {
  /** Every currently open pane that can display a note. */
  views(): SyncConflictBannerView[];
  /** Unresolved conflicts from sync state; empty when sync is not append-only. */
  conflicts(): HistoryConflict[];
  compare(info: SyncConflictBannerInfo): void;
}

/**
 * Reconciles the banner across every open pane. Refresh is idempotent and
 * cheap, so it can be driven from sync status, file-open and layout events; the
 * slot itself skips rebuilding while the conflict identity is unchanged.
 */
export class SyncConflictBannerController {
  private disposed = false;

  constructor(private readonly deps: SyncConflictBannerDeps) {}

  refresh(): void {
    if (this.disposed) return;
    const byPath = new Map<string, HistoryConflict>();
    // Only vault content maps onto an open note. Portable-config conflicts are
    // resolved from Settings and must never claim a note pane.
    for (const conflict of this.deps.conflicts()) if (conflict.namespace === "content") byPath.set(conflict.path, conflict);
    for (const view of this.deps.views()) {
      const conflict = view.file ? byPath.get(view.file.path) : undefined;
      if (!conflict) {
        view.clearSyncConflict();
        continue;
      }
      const info: SyncConflictBannerInfo = { entityId: conflict.entityId, path: conflict.path, heads: conflict.heads, reason: conflict.reason };
      view.presentSyncConflict(info, () => this.deps.compare(info));
    }
  }

  /**
   * Vault switch, provider unload and app teardown: leave no banner behind, and
   * stay inert afterwards so a late event cannot re-mount one onto a torn-down
   * workspace.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const view of this.deps.views()) view.clearSyncConflict();
  }
}
