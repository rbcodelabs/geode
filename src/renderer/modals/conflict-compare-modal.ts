import type { App } from "../app";
import { Modal } from "./modals";
import type {
  HistoryComparisonChoice,
  HistoryConflictComparison,
  HistoryResolution,
} from "../sync/history-controller";
import {
  SYNC_CONFLICT_CANCEL_LABEL,
  SYNC_CONFLICT_DIALOG_SUBTITLE,
  SYNC_CONFLICT_DIALOG_TITLE,
  SYNC_CONFLICT_KEEP_LOCAL_LABEL,
  SYNC_CONFLICT_LOADING_TEXT,
  SYNC_CONFLICT_LOCAL_PANEL_TITLE,
  SYNC_CONFLICT_REMOTE_PANEL_TITLE,
  SYNC_CONFLICT_STALE_HEADS_MESSAGE,
  SYNC_CONFLICT_UNDESCRIBED_DIALOG_FALLBACK,
  SYNC_CONFLICT_UNKNOWN_ERROR,
  SYNC_CONFLICT_USE_REMOTE_LABEL,
  describeComparisonBlockerForDialog,
  formatHeadLabels,
} from "../sync/conflict-presentation";

/** The read-only comparison surface this dialog needs, and nothing more. */
export interface ConflictCompareSyncApi {
  describeHistoryConflict(entityId: string): Promise<HistoryConflictComparison>;
  readHistoryConflictText(entityId: string, choice: HistoryComparisonChoice): Promise<string>;
  resolveHistoryConflict(resolution: HistoryResolution): Promise<unknown>;
}

export interface ConflictCompareOptions {
  entityId: string;
  path: string;
  sync: ConflictCompareSyncApi;
  /**
   * Lets ordinary autosave settle and reports a user-facing message when open
   * panes still hold edits for this path. Resolution must never pick silently
   * between dirty buffers, so a non-null return blocks it.
   */
  settleLocalEdits?: (path: string) => Promise<string | null>;
  /** Fired only after sync confirmed the resolution. */
  onResolved?: () => void;
}

const sameHeads = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join(",") === [...right].sort().join(",");

let dialogSequence = 0;

/**
 * Read-only, side-by-side comparison of the local file and one selected synced
 * head, with two explicit resolutions.
 *
 * The base `Modal` gives Escape and backdrop dismissal but no dialog semantics,
 * no focus trap and no focus restore. Those are added here rather than in the
 * base class so `PromptModal` and `SuggestModal` keep their existing behaviour
 * unchanged.
 */
export class ConflictCompareModal extends Modal {
  private readonly titleId = `sync-conflict-title-${++dialogSequence}`;
  private readonly messageEl: HTMLElement;
  private readonly localTextEl: HTMLElement;
  private readonly remoteTextEl: HTMLElement;
  private readonly selectEl: HTMLSelectElement;
  private readonly cancelEl: HTMLButtonElement;
  private readonly keepEl: HTMLButtonElement;
  private readonly useEl: HTMLButtonElement;
  /** Tab order inside the dialog; disabled entries are skipped at trap time. */
  private readonly interactive: HTMLElement[];

  private reviewedHeads: string[] = [];
  private reviewedLocalSha256?: string;
  private selectedRecordId: string | null = null;
  /** Bumped by every new read and by close, so stale reads never paint. */
  private readGeneration = 0;
  /** Tail of the serialized comparison-read chain; see read(). */
  private readChain: Promise<void> = Promise.resolve();
  private closed = false;
  private busy = false;
  private opener: HTMLElement | null = null;
  private readonly trap: (event: KeyboardEvent) => void;

  constructor(app: App, private readonly options: ConflictCompareOptions) {
    super(app);
    this.modalEl.classList.add("sync-conflict-modal");

    const header = document.createElement("div");
    header.className = "sync-conflict-header";
    const title = document.createElement("h2");
    title.className = "sync-conflict-title";
    title.setAttribute("id", this.titleId);
    title.textContent = SYNC_CONFLICT_DIALOG_TITLE;
    const subtitle = document.createElement("div");
    subtitle.className = "sync-conflict-subtitle";
    subtitle.textContent = SYNC_CONFLICT_DIALOG_SUBTITLE;
    header.append(title, subtitle);

    this.messageEl = document.createElement("div");
    this.messageEl.className = "sync-conflict-message";
    this.messageEl.setAttribute("role", "alert");
    this.messageEl.hidden = true;

    const compare = document.createElement("div");
    compare.className = "sync-conflict-compare";

    const local = this.buildPanel(SYNC_CONFLICT_LOCAL_PANEL_TITLE);
    this.localTextEl = local.textEl;

    this.selectEl = document.createElement("select");
    this.selectEl.className = "sync-conflict-version-select";
    this.selectEl.setAttribute("aria-label", "Synced version to compare");
    this.selectEl.disabled = true;
    this.selectEl.addEventListener("change", () => {
      this.selectedRecordId = this.selectEl.value;
      void this.loadSelected().catch((error) => {
        // Clear the loading placeholder too, or the panel keeps saying
        // "Loading…" forever next to the error explaining it never will.
        if (!this.closed) this.remoteTextEl.textContent = "";
        this.reportTerminal(this.messageOf(error));
      });
    });
    const remote = this.buildPanel(SYNC_CONFLICT_REMOTE_PANEL_TITLE, this.selectEl);
    this.remoteTextEl = remote.textEl;

    compare.append(local.el, remote.el);

    const actions = document.createElement("div");
    actions.className = "sync-conflict-actions";
    this.cancelEl = this.buildAction(SYNC_CONFLICT_CANCEL_LABEL, "mod-ghost", () => this.close());
    this.keepEl = this.buildAction(SYNC_CONFLICT_KEEP_LOCAL_LABEL, "mod-secondary", () => void this.resolve({ kind: "current" }));
    this.useEl = this.buildAction(SYNC_CONFLICT_USE_REMOTE_LABEL, "mod-cta", () => {
      const recordId = this.selectedRecordId;
      if (recordId) void this.resolve({ kind: "version", recordId });
    });
    this.keepEl.disabled = true;
    this.useEl.disabled = true;
    actions.append(this.cancelEl, this.keepEl, this.useEl);

    this.contentEl.append(header, this.messageEl, compare, actions);
    // DOM order, so trapped Tab matches the visual reading order. The two text
    // panels are tab stops because they scroll (see buildPanel).
    this.interactive = [this.localTextEl, this.selectEl, this.remoteTextEl, this.cancelEl, this.keepEl, this.useEl];

    this.trap = (event: KeyboardEvent) => this.onTab(event);
  }

  private buildPanel(titleText: string, control?: HTMLElement): { el: HTMLElement; textEl: HTMLElement } {
    const el = document.createElement("div");
    el.className = "sync-conflict-panel";
    const head = document.createElement("div");
    head.className = "sync-conflict-panel-head";
    const title = document.createElement("div");
    title.className = "sync-conflict-panel-title";
    title.textContent = titleText;
    head.appendChild(title);
    if (control) head.appendChild(control);
    const textEl = document.createElement("pre");
    textEl.className = "sync-conflict-panel-text";
    textEl.setAttribute("aria-readonly", "true");
    // Focusable: the panels are overflow:auto with a max-height, so a long note
    // is clipped. Without a tab stop a keyboard-only user could never scroll to
    // the rest of it — which would make the comparison unreadable for them.
    textEl.setAttribute("role", "region");
    textEl.setAttribute("aria-label", titleText);
    textEl.tabIndex = 0;
    textEl.textContent = SYNC_CONFLICT_LOADING_TEXT;
    el.append(head, textEl);
    return { el, textEl };
  }

  private buildAction(label: string, variant: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = variant;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle                                                         *
   * ---------------------------------------------------------------- */

  onOpen(): void {
    this.opener = (document.activeElement as HTMLElement | null) ?? null;
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.modalEl.setAttribute("aria-labelledby", this.titleId);
    this.modalEl.tabIndex = -1;
    document.addEventListener("keydown", this.trap, true);
    // Focus the dialog itself, not the first tab stop: that stop is a text
    // panel still reading "Loading…", which a screen reader would announce
    // instead of the dialog's name and purpose.
    this.modalEl.focus();
    void this.load();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    // Any comparison read still in flight is abandoned rather than painted.
    this.readGeneration++;
    document.removeEventListener("keydown", this.trap, true);
    const opener = this.opener;
    this.opener = null;
    opener?.focus?.();
  }

  /** Which conflict this dialog is showing, so callers can reconcile it. */
  get entityId(): string {
    return this.options.entityId;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Vault switch or provider unload: drop the dialog with nothing resolved. */
  cancel(): void {
    if (!this.closed) this.close();
  }

  /* ---------------------------------------------------------------- *
   * Focus management                                                  *
   * ---------------------------------------------------------------- */

  private focusable(): HTMLElement[] {
    return this.interactive.filter((el) => !(el as HTMLButtonElement).disabled && !el.hidden);
  }

  private onTab(event: KeyboardEvent): void {
    if (this.closed || event.key !== "Tab") return;
    event.preventDefault();
    const items = this.focusable();
    if (!items.length) {
      this.modalEl.focus?.();
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? index <= 0 ? items.length - 1 : index - 1
      : index === -1 || index === items.length - 1 ? 0 : index + 1;
    items[next].focus();
  }

  /* ---------------------------------------------------------------- *
   * Messages                                                          *
   * ---------------------------------------------------------------- */

  private setMessage(text: string): void {
    this.messageEl.textContent = text;
    this.messageEl.hidden = !text;
  }

  /** The comparison itself is unusable; resolution stays unavailable. */
  private reportTerminal(text: string): void {
    if (this.closed) return;
    // Nothing more will load, so no panel may be left claiming it is loading.
    // Otherwise a non-comparable conflict (a rename between two devices is
    // ordinary) leaves both panels reading "Loading…" forever beside the
    // message explaining that they never will.
    this.clearLoadingPlaceholders();
    this.setMessage(text);
    this.keepEl.disabled = true;
    this.useEl.disabled = true;
  }

  private clearLoadingPlaceholders(): void {
    for (const el of [this.localTextEl, this.remoteTextEl]) {
      if (el.textContent === SYNC_CONFLICT_LOADING_TEXT) el.textContent = "";
    }
  }

  /** A resolution attempt failed or was refused; the user may correct and retry. */
  private reportRetryable(text: string): void {
    if (this.closed) return;
    this.setMessage(text);
    this.keepEl.disabled = false;
    this.useEl.disabled = !this.selectedRecordId;
  }

  /** Never interpolates note content — only the sync layer's own messages. */
  private messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message.trim() : "";
    return message || SYNC_CONFLICT_UNKNOWN_ERROR;
  }

  /* ---------------------------------------------------------------- *
   * Loading                                                           *
   * ---------------------------------------------------------------- */

  private async load(): Promise<void> {
    try {
      if (this.options.settleLocalEdits) {
        const blocked = await this.options.settleLocalEdits(this.options.path);
        if (this.closed) return;
        if (blocked) {
          this.reportTerminal(blocked);
          return;
        }
      }
      const comparison = await this.options.sync.describeHistoryConflict(this.options.entityId);
      if (this.closed) return;
      this.reviewedHeads = comparison.heads.map((head) => head.recordId);
      this.reviewedLocalSha256 = comparison.local.sha256;
      if (!comparison.comparable) {
        this.reportTerminal(
          comparison.notComparable
            ? describeComparisonBlockerForDialog(comparison.notComparable)
            : SYNC_CONFLICT_UNDESCRIBED_DIALOG_FALLBACK,
        );
        return;
      }
      this.renderHeads(comparison);
      this.selectedRecordId = this.reviewedHeads[0] ?? null;
      this.keepEl.disabled = false;
      this.useEl.disabled = !this.selectedRecordId;
      // Sequential, never Promise.all: each read takes the sync controller's
      // single-owner slot, and SyncService.settled() only waits for work that
      // is *already* running. Issued concurrently from a quiet service, neither
      // call waits, the first claims the slot and the second is rejected by
      // withController with "Sync already running or disconnecting" — which
      // made the dialog fail every time against the real service.
      await this.loadLocal();
      if (this.closed) return;
      await this.loadSelected();
    } catch (error) {
      if (this.closed) return;
      this.reportTerminal(this.messageOf(error));
    }
  }

  private renderHeads(comparison: HistoryConflictComparison): void {
    const labels = formatHeadLabels(comparison.heads);
    this.selectEl.replaceChildren();
    comparison.heads.forEach((head, index) => {
      const option = document.createElement("option");
      option.value = head.recordId;
      option.textContent = labels[index];
      option.title = head.recordId;
      this.selectEl.appendChild(option);
    });
    this.selectEl.disabled = comparison.heads.length === 0;
    if (comparison.heads.length) this.selectEl.value = comparison.heads[0].recordId;
  }

  /**
   * Serializes every comparison read onto one chain.
   *
   * Each read takes the sync controller's single-owner slot, and
   * SyncService.settled() only waits for work that is *already* running — so
   * two reads issued from a quiet service do not queue behind each other, they
   * collide, and the loser is rejected outright. Changing the version selector
   * while a read is in flight is enough to trigger that, so the chain (not just
   * the readGeneration stale-result check) is what keeps the dialog working.
   */
  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.readChain.then(task);
    // Keep the chain alive after a rejection; callers handle their own errors.
    this.readChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Queued work that is pointless once the dialog is gone. */
  private read(task: () => Promise<void>): Promise<void> {
    return this.queue(() => (this.closed ? Promise.resolve() : task()));
  }

  private loadLocal(): Promise<void> {
    return this.read(async () => {
      const text = await this.options.sync.readHistoryConflictText(this.options.entityId, { kind: "current" });
      if (this.closed) return;
      this.localTextEl.textContent = text;
    });
  }

  private loadSelected(): Promise<void> {
    const recordId = this.selectedRecordId;
    if (!recordId) return Promise.resolve();
    const generation = ++this.readGeneration;
    this.remoteTextEl.textContent = SYNC_CONFLICT_LOADING_TEXT;
    return this.read(async () => {
      // A newer selection superseded this one while it waited for the slot.
      if (generation !== this.readGeneration) return;
      const text = await this.options.sync.readHistoryConflictText(this.options.entityId, { kind: "version", recordId });
      if (this.closed || generation !== this.readGeneration) return;
      this.remoteTextEl.textContent = text;
    });
  }

  /* ---------------------------------------------------------------- *
   * Resolution                                                        *
   * ---------------------------------------------------------------- */

  private async resolve(choice: HistoryComparisonChoice): Promise<void> {
    if (this.busy || this.closed || !this.reviewedHeads.length) return;
    this.busy = true;
    this.keepEl.disabled = true;
    this.useEl.disabled = true;
    // Freeze the selector too. describeHistoryConflict/resolveHistoryConflict
    // take the same single-owner slot as a comparison read, so a selection
    // changed during the settle window would race them and lose.
    this.selectEl.disabled = true;
    this.setMessage("");
    try {
      if (this.options.settleLocalEdits) {
        const blocked = await this.options.settleLocalEdits(this.options.path);
        if (this.closed) return;
        if (blocked) {
          this.reportRetryable(blocked);
          return;
        }
      }
      // An unseen head that arrived during comparison is still a conflict: the
      // user reviewed a set that no longer describes the entity, so refuse.
      // Queued, not merely ordered behind the chain: describeHistoryConflict
      // and resolveHistoryConflict take the same single-owner slot as a
      // comparison read. Disabling the selector stops a user reaching this
      // race, but that leans on browser semantics; queueing makes it
      // structural.
      const current = await this.queue(() => this.options.sync.describeHistoryConflict(this.options.entityId));
      if (this.closed) return;
      if (!sameHeads(current.heads.map((head) => head.recordId), this.reviewedHeads)) {
        this.reportTerminal(SYNC_CONFLICT_STALE_HEADS_MESSAGE);
        return;
      }
      await this.queue(() => this.options.sync.resolveHistoryConflict({
        entityId: this.options.entityId,
        heads: [...this.reviewedHeads],
        choice,
        // Phase 1 refuses the resolution if the local file moved on since the
        // hash the user actually reviewed.
        ...(this.reviewedLocalSha256 ? { reviewedLocalSha256: this.reviewedLocalSha256 } : {}),
      }));
      // The resolution really happened, so report it even if the resulting sync
      // status already closed this dialog. `close()` is idempotent.
      this.options.onResolved?.();
      this.close();
    } catch (error) {
      if (this.closed) return;
      this.reportRetryable(this.messageOf(error));
    } finally {
      this.busy = false;
      if (!this.closed) this.selectEl.disabled = this.reviewedHeads.length === 0;
    }
  }
}
