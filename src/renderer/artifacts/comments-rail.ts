import type { RailFilter, RailRow, RailView, RowAction } from "./rail-model";

/**
 * The comments rail (design 3.6, 3.7; ADR 0006 Addendum 1 A.5): an `aside` with filters, a multi-select Send, per-row
 * actions and a status line. Plain embedder DOM rendered from a `RailView`; every string that came from a page or a
 * comments file (`label`, `text`) is placed with `textContent` only, and no HTML string is ever parsed here. Rows render
 * in chunks of 50 so a 200-comment artifact never builds 200 rows at once.
 */

export interface RailCallbacks {
  onFilter(filter: RailFilter): void;
  onClearCluster(): void;
  onToggleSelect(id: string, selected: boolean): void;
  onAction(id: string, action: RowAction): void;
  onSendSelected(): void;
  onResolveSent(): void;
  onAdoptAll(): void;
  onRetry(): void;
  onClose(): void;
}

export const RAIL_CHUNK = 50;
const FILTER_LABEL: Record<RailFilter, string> = { all: "All", open: "Open", sent: "Sent", resolved: "Resolved", dismissed: "Dismissed" };
const FILTERS: readonly RailFilter[] = ["all", "open", "sent", "resolved", "dismissed"];
const ACTION_TEXT: Record<RowAction, string> = {
  jump: "Jump", send: "Send", resend: "Send again", resolve: "Resolve", dismiss: "Dismiss", reopen: "Reopen", delete: "Delete", adopt: "Adopt", unqueue: "Cancel send",
};
const actionName = (action: RowAction, n: number): string => {
  switch (action) {
    case "jump": return `Jump to comment ${n}`;
    case "resend": return `Send comment ${n} again`;
    case "unqueue": return `Cancel queued send for comment ${n}`;
    default: return `${ACTION_TEXT[action]} comment ${n}`;
  }
};
const NEEDS_CONFIRM: ReadonlySet<RowAction> = new Set<RowAction>(["delete", "unqueue"]);

export class CommentsRail {
  readonly el: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly foreign: HTMLElement;
  private readonly foreignText: HTMLElement;
  private readonly filterButtons = new Map<RailFilter, HTMLButtonElement>();
  private readonly clusterChip: HTMLElement;
  private readonly clusterText: HTMLElement;
  private readonly send: HTMLButtonElement;
  private readonly resolveSent: HTMLButtonElement;
  private readonly results: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly more: HTMLButtonElement;
  private view: RailView | null = null;
  private shown = RAIL_CHUNK;
  private listSignature = "";
  private rowIds: string[] = [];
  private activeRow: string | null = null;
  private confirming: { id: string; action: RowAction } | null = null;

  constructor(private readonly doc: Document, private readonly callbacks: RailCallbacks) {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    };
    const button = (className: string, text: string): HTMLButtonElement => {
      const b = make("button", className);
      b.type = "button";
      b.textContent = text;
      return b;
    };
    this.el = make("aside", "comments-rail");
    this.el.setAttribute("aria-label", "Design comments");

    const header = make("div", "comments-rail-header");
    this.heading = make("h2", "comments-rail-heading");
    this.heading.tabIndex = -1;
    const close = button("comments-rail-close clickable-icon", "×");
    close.setAttribute("aria-label", "Close comments");
    close.addEventListener("click", () => this.callbacks.onClose());
    header.append(this.heading, close);

    this.notice = make("div", "comments-rail-notice");
    this.notice.hidden = true;

    this.foreign = make("div", "comments-rail-foreign");
    this.foreignText = make("span");
    const adopt = button("comments-rail-adopt-all", "Adopt all");
    adopt.addEventListener("click", () => this.callbacks.onAdoptAll());
    this.foreign.append(this.foreignText, adopt);
    this.foreign.hidden = true;

    const filters = make("div", "comments-rail-filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filter comments");
    for (const filter of FILTERS) {
      const b = button("comments-rail-filter", FILTER_LABEL[filter]);
      b.setAttribute("aria-pressed", "false");
      b.dataset.filter = filter;
      b.addEventListener("click", () => this.callbacks.onFilter(filter));
      this.filterButtons.set(filter, b);
      filters.append(b);
    }

    this.clusterChip = make("div", "comments-rail-cluster-chip");
    this.clusterText = make("span");
    const clear = button("comments-rail-cluster-clear clickable-icon", "×");
    clear.setAttribute("aria-label", "Show all comments");
    clear.addEventListener("click", () => this.callbacks.onClearCluster());
    this.clusterChip.append(this.clusterText, clear);
    this.clusterChip.hidden = true;

    const bar = make("div", "comments-rail-bar");
    this.send = button("mod-cta comments-rail-send", "Send");
    this.send.addEventListener("click", () => this.callbacks.onSendSelected());
    this.resolveSent = button("comments-rail-resolve-sent", "Resolve sent");
    this.resolveSent.hidden = true;
    this.resolveSent.addEventListener("click", () => this.callbacks.onResolveSent());
    bar.append(this.send, this.resolveSent);

    const statusRow = make("div", "comments-rail-statusrow");
    this.results = make("div", "comments-rail-results");
    this.results.setAttribute("role", "status");
    this.results.setAttribute("aria-live", "polite");
    this.retry = button("comments-rail-retry", "Retry");
    this.retry.hidden = true;
    this.retry.addEventListener("click", () => this.callbacks.onRetry());
    statusRow.append(this.results, this.retry);

    this.list = make("ul", "comments-rail-list");
    this.list.tabIndex = -1;
    this.empty = make("p", "comments-rail-empty");
    this.empty.hidden = true;
    this.more = button("comments-rail-more", "Show more");
    this.more.addEventListener("click", () => {
      this.shown += RAIL_CHUNK;
      if (this.view) this.renderList(this.view, null);
    });

    this.el.append(header, this.notice, this.foreign, filters, this.clusterChip, bar, statusRow, this.list, this.empty);
    this.el.addEventListener("keydown", (event) => this.onKeydown(event));
    this.list.addEventListener("keydown", (event) => this.onListKeydown(event));
  }

  /** Below the narrow breakpoint the view lays the rail out as a sheet over the pane. */
  setNarrow(narrow: boolean): void { this.el.classList.toggle("is-sheet", narrow); }

  focusHeading(): void { this.heading.focus(); }

  /** Focuses a row, rendering further chunks first when it is not yet in the DOM. False when the row is not in the current view. */
  focusRow(id: string): boolean {
    const view = this.view;
    if (!view) return false;
    const index = view.rows.findIndex((r) => r.id === id);
    if (index < 0) return false;
    if (index >= this.shown) { this.shown = Math.ceil((index + 1) / RAIL_CHUNK) * RAIL_CHUNK; this.renderList(view, null); }
    this.activeRow = id;
    this.syncRowStops();
    const row = this.rowEl(id);
    if (!row) return false;
    row.focus();
    return true;
  }

  render(view: RailView): void {
    const previous = this.view;
    this.view = view;
    this.heading.textContent = view.heading;
    this.notice.hidden = view.notice === null || view.notice === "";
    this.notice.textContent = view.notice ?? "";
    this.foreign.hidden = view.foreignBanner === null;
    this.foreignText.textContent = view.foreignBanner?.text ?? "";
    for (const [filter, b] of this.filterButtons) {
      b.setAttribute("aria-pressed", String(view.filter === filter));
      b.textContent = `${FILTER_LABEL[filter]} ${view.filterCounts[filter]}`;
    }
    this.clusterChip.hidden = view.clusterChip === null;
    this.clusterText.textContent = view.clusterChip ?? "";
    this.send.textContent = view.send.label;
    this.send.disabled = !view.send.enabled;
    this.send.setAttribute("aria-label", view.send.count > 0 ? `Send ${view.send.count} selected comments` : "Send selected comments");
    this.send.title = view.send.overCap ? "At most 20 comments can be sent at once. Deselect some." : "";
    this.resolveSent.hidden = view.resolveSentCount === 0;
    this.resolveSent.textContent = view.resolveSentCount > 0 ? `Resolve sent (${view.resolveSentCount})` : "Resolve sent";
    this.results.textContent = view.resultsLine ?? "";
    this.retry.hidden = !view.retry;
    this.empty.hidden = view.emptyText === null;
    this.empty.textContent = view.emptyText ?? "";

    const signature = `${view.filter}|${view.clusterChip ?? ""}`;
    if (signature !== this.listSignature) { this.listSignature = signature; this.shown = RAIL_CHUNK; }
    if (this.confirming && !view.rows.some((r) => r.id === this.confirming!.id)) this.confirming = null;
    this.renderList(view, previous);
  }

  private renderList(view: RailView, _previous: RailView | null): void {
    const focus = this.captureFocus();
    const before = this.rowIds;
    const visible = view.rows.slice(0, this.shown);
    this.rowIds = visible.map((r) => r.id);
    if (this.activeRow === null || !this.rowIds.includes(this.activeRow)) this.activeRow = this.rowIds[0] ?? null;
    this.list.replaceChildren(...visible.map((row) => this.renderRow(row, view)));
    this.more.remove();
    const remaining = view.rows.length - visible.length;
    if (remaining > 0) {
      this.more.textContent = `Show ${Math.min(RAIL_CHUNK, remaining)} more`;
      this.list.after(this.more);
    }
    this.syncRowStops();
    this.restoreFocus(focus, before);
  }

  private renderRow(row: RailRow, view: RailView): HTMLElement {
    const doc = this.doc;
    const li = doc.createElement("li");
    li.className = `comments-rail-row${row.greyed ? " is-greyed" : ""}`;
    li.dataset.id = row.id;
    li.dataset.status = row.status;
    li.tabIndex = row.id === this.activeRow ? 0 : -1;
    li.addEventListener("focus", () => { if (this.activeRow !== row.id) { this.activeRow = row.id; this.syncRowStops(); } });

    const head = doc.createElement("div");
    head.className = "comments-rail-row-head";
    if (row.selectable) {
      const box = doc.createElement("input");
      box.type = "checkbox";
      box.className = "comments-rail-select";
      box.checked = row.selected;
      box.setAttribute("aria-label", row.selectLabel);
      box.addEventListener("change", () => this.callbacks.onToggleSelect(row.id, box.checked));
      head.append(box);
    }
    const ordinal = doc.createElement("span");
    ordinal.className = "comments-rail-ordinal";
    ordinal.textContent = String(row.ordinal);
    const status = doc.createElement("span");
    status.className = "comments-rail-status";
    status.textContent = row.statusLabel;
    const label = doc.createElement("span");
    label.className = "comments-rail-label";
    label.textContent = row.label;
    head.append(ordinal, status, label);

    const text = doc.createElement("p");
    text.className = "comments-rail-text";
    text.textContent = row.text;

    li.append(head, text);
    const chips = [...(row.anchorChip ? [row.anchorChip] : []), ...row.stateChips];
    if (chips.length > 0) {
      const chipRow = doc.createElement("div");
      chipRow.className = "comments-rail-chips";
      for (const c of chips) {
        const chip = doc.createElement("span");
        chip.className = "comments-rail-chip";
        chip.textContent = c;
        chipRow.append(chip);
      }
      li.append(chipRow);
    }

    if (this.confirming && this.confirming.id === row.id) {
      li.append(this.renderConfirm(row, view, this.confirming.action));
    } else if (row.actions.length > 0) {
      const actions = doc.createElement("div");
      actions.className = "comments-rail-actions";
      for (const action of row.actions) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "comments-rail-action";
        b.dataset.action = action;
        b.textContent = ACTION_TEXT[action];
        b.setAttribute("aria-label", actionName(action, row.ordinal));
        b.addEventListener("click", () => {
          if (NEEDS_CONFIRM.has(action)) { this.confirming = { id: row.id, action }; if (this.view) this.renderList(this.view, null); this.focusConfirm(row.id); return; }
          this.callbacks.onAction(row.id, action);
        });
        actions.append(b);
      }
      li.append(actions);
    }
    return li;
  }

  private renderConfirm(row: RailRow, view: RailView, action: RowAction): HTMLElement {
    const doc = this.doc;
    const box = doc.createElement("div");
    box.className = "comments-rail-confirm";
    box.setAttribute("role", "group");
    const text = doc.createElement("span");
    text.textContent = action === "delete"
      ? `Delete comment ${row.ordinal}? This cannot be undone.`
      : `Cancels the queued send of ${view.pendingCount} ${view.pendingCount === 1 ? "comment" : "comments"}.`;
    const yes = doc.createElement("button");
    yes.type = "button";
    yes.className = "comments-rail-confirm-yes";
    yes.textContent = action === "delete" ? "Delete" : "Cancel send";
    yes.addEventListener("click", () => { this.confirming = null; this.callbacks.onAction(row.id, action); if (this.view) this.renderList(this.view, null); });
    const no = doc.createElement("button");
    no.type = "button";
    no.className = "comments-rail-confirm-no";
    no.textContent = "Keep";
    no.addEventListener("click", () => { this.confirming = null; if (this.view) this.renderList(this.view, null); this.rowEl(row.id)?.focus(); });
    box.append(text, yes, no);
    return box;
  }

  private focusConfirm(id: string): void {
    this.rowEl(id)?.querySelector<HTMLButtonElement>(".comments-rail-confirm-no")?.focus();
  }

  // ---- focus ----

  private rowEl(id: string): HTMLElement | null {
    for (const el of this.list.children) if ((el as HTMLElement).dataset.id === id) return el as HTMLElement;
    return null;
  }

  private captureFocus(): { id: string; action: string | null } | null {
    const active = this.doc.activeElement as HTMLElement | null;
    if (!active || !this.list.contains(active)) return null;
    const row = active.closest<HTMLElement>("li.comments-rail-row");
    if (!row?.dataset.id) return null;
    return { id: row.dataset.id, action: active.dataset?.action ?? null };
  }

  /** The same control when it survived; else the next row, else the previous, else the list container. */
  private restoreFocus(focus: { id: string; action: string | null } | null, before: readonly string[]): void {
    if (!focus) return;
    const same = this.rowEl(focus.id);
    if (same) {
      const control = focus.action ? same.querySelector<HTMLElement>(`[data-action="${focus.action}"]`) : null;
      (control ?? same).focus();
      return;
    }
    const index = before.indexOf(focus.id);
    const current = new Set(this.rowIds);
    const next = before.slice(index + 1).find((id) => current.has(id));
    const previous = [...before.slice(0, Math.max(index, 0))].reverse().find((id) => current.has(id));
    const target = next ?? previous;
    if (target) { this.activeRow = target; this.syncRowStops(); this.rowEl(target)?.focus(); } else this.list.focus();
  }

  private syncRowStops(): void {
    for (const el of this.list.children) (el as HTMLElement).tabIndex = (el as HTMLElement).dataset.id === this.activeRow ? 0 : -1;
  }

  private onListKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (event.isComposing || !target.classList?.contains("comments-rail-row")) return;
    const index = this.rowIds.indexOf(target.dataset.id ?? "");
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = Math.min(index + 1, this.rowIds.length - 1); break;
      case "ArrowUp": next = Math.max(index - 1, 0); break;
      case "Home": next = 0; break;
      case "End": next = this.rowIds.length - 1; break;
      default: return;
    }
    event.preventDefault();
    this.activeRow = this.rowIds[next]!;
    this.syncRowStops();
    this.rowEl(this.activeRow)?.focus();
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.confirming) {
      const id = this.confirming.id;
      this.confirming = null;
      if (this.view) this.renderList(this.view, null);
      this.rowEl(id)?.focus();
      return;
    }
    if (this.view?.clusterChip) this.callbacks.onClearCluster();
    else this.callbacks.onClose();
  }
}
