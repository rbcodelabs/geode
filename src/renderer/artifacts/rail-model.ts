import {
  ARTIFACT_COMMENTS_CAPS,
  type ArtifactAnchorState,
  type ArtifactComment,
  type ArtifactCommentStatus,
  type ArtifactCommentsSnapshot,
  type BatchSendReport,
} from "../../artifacts/feedback-contract-v2";
import type { InspectAnchorResult } from "../../artifacts/inspector-protocol";

/**
 * The comments rail view model (design 3.4, 3.6; ADR 0006 Addendum 1 A.5). A pure reducer: the plugin's snapshot,
 * Geode's anchor states, the filter and the selection go in; a plain view model comes out. No DOM, no I/O. Every string
 * that originated on a page or in a comments file (`label`, `text`) is passed through untouched; the DOM layer places
 * it with `textContent` only.
 */

export type RailFilter = "all" | "open" | "sent" | "resolved" | "dismissed";
export type RowAction = "jump" | "send" | "resend" | "resolve" | "dismiss" | "reopen" | "delete" | "adopt" | "unqueue";

export interface RailInput {
  readonly comments: readonly ArtifactComment[];
  readonly anchorStates: Readonly<Record<string, ArtifactAnchorState>>;
  readonly filter: RailFilter;
  readonly clusterIds: readonly string[] | null;
  /** The user's explicit selection; null until they touch a checkbox (the default is every open local comment). */
  readonly selected: ReadonlySet<string> | null;
  readonly notice: string | null;
  readonly health: ArtifactCommentsSnapshot["health"];
  readonly resultsLine: string | null;
  /** A failed send whose transport can be retried with the same request id (see the coordinator). */
  readonly retry?: boolean;
}

export interface RailRow {
  readonly id: string;
  readonly ordinal: number;
  readonly status: ArtifactCommentStatus;
  readonly statusLabel: string;
  readonly label: string;
  readonly text: string;
  readonly anchorState: ArtifactAnchorState;
  readonly anchorChip: string | null;
  readonly stateChips: readonly string[];
  readonly foreign: boolean;
  readonly greyed: boolean;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly selectLabel: string;
  readonly actions: readonly RowAction[];
}

export interface RailView {
  readonly heading: string;
  readonly filter: RailFilter;
  readonly filterCounts: Readonly<Record<RailFilter, number>>;
  readonly rows: readonly RailRow[];
  readonly clusterChip: string | null;
  readonly emptyText: string | null;
  readonly send: { readonly label: string; readonly count: number; readonly enabled: boolean; readonly overCap: boolean };
  readonly resolveSentCount: number;
  readonly pendingCount: number;
  readonly readOnly: boolean;
  readonly notice: string | null;
  readonly foreignBanner: { readonly count: number; readonly text: string } | null;
  readonly resultsLine: string | null;
  readonly retry: boolean;
}

const STATUS_LABEL: Record<ArtifactCommentStatus, string> = {
  open: "Open", pending: "Waiting for the agent", sent: "Sent", resolved: "Resolved", dismissed: "Dismissed",
};
const FILTERS: readonly RailFilter[] = ["all", "open", "sent", "resolved", "dismissed"];
const PLACED: ReadonlySet<ArtifactAnchorState> = new Set(["exact", "moved", "approximate"]);

/** The 3.3 mapping from a guest result to an embedder state. `agrees: false` means unconfirmed, so approximate. */
export function anchorStateFromResult(result: Pick<InspectAnchorResult, "match" | "agrees">): ArtifactAnchorState {
  switch (result.match) {
    case "detached": return "detached";
    case "other-route": return "other-route";
    case "selector": return result.agrees ? "exact" : "approximate";
    case "text": return result.agrees ? "moved" : "approximate";
    case "landmark": return "approximate";
    default: return "unknown";
  }
}

const isSendable = (c: ArtifactComment): boolean => c.provenance === "local" && c.status === "open";

/** The ids a batch send would carry: the explicit selection pruned to still-sendable comments, else every open local comment. */
export function effectiveSelection(comments: readonly ArtifactComment[], explicit: ReadonlySet<string> | null): ReadonlySet<string> {
  const sendable = comments.filter(isSendable);
  if (explicit === null) return new Set(sendable.map((c) => c.id));
  return new Set(sendable.filter((c) => explicit.has(c.id)).map((c) => c.id));
}

const matchesFilter = (c: ArtifactComment, filter: RailFilter): boolean =>
  filter === "all" || (filter === "open" ? c.status === "open" || c.status === "pending" : c.status === filter);

const ANCHOR_CHIP: Partial<Record<ArtifactAnchorState, string>> = {
  moved: "Moved",
  approximate: "Approximate: may not be the same element",
  detached: "Detached: the element was not found",
  "other-route": "On another page",
};

function actionsFor(c: ArtifactComment, state: ArtifactAnchorState, readOnly: boolean): RowAction[] {
  const jump: RowAction[] = PLACED.has(state) ? ["jump"] : [];
  if (readOnly) return jump;
  if (c.provenance === "foreign") return [...jump, "adopt", "delete"];
  switch (c.status) {
    case "open": return [...jump, "send", "resolve", "dismiss", "delete"];
    case "pending": return [...jump, "unqueue"];
    case "sent": return [...jump, "resend", "resolve", "dismiss", "reopen", "delete"];
    case "resolved":
    case "dismissed": return [...jump, "reopen", "delete"];
  }
}

export function buildRailView(input: RailInput): RailView {
  const { comments, anchorStates, filter } = input;
  const readOnly = input.health === "read-only";
  const ordered = [...comments].sort((a, b) => a.ordinal - b.ordinal);
  const selection = effectiveSelection(ordered, input.selected);
  const cluster = input.clusterIds ? new Set(input.clusterIds) : null;
  const rows: RailRow[] = [];
  for (const c of ordered) {
    if (cluster && !cluster.has(c.id)) continue;
    if (!matchesFilter(c, filter)) continue;
    const state = anchorStates[c.id] ?? "unknown";
    const selectable = !readOnly && isSendable(c);
    const chips: string[] = [];
    if (c.status === "pending") chips.push("Waiting for the agent");
    if (c.send.maybeSent) chips.push("May have been sent");
    if (c.provenance === "foreign") chips.push("From another install");
    rows.push({
      id: c.id,
      ordinal: c.ordinal,
      status: c.status,
      statusLabel: STATUS_LABEL[c.status],
      label: c.label,
      text: c.text,
      anchorState: state,
      anchorChip: ANCHOR_CHIP[state] ?? null,
      stateChips: chips,
      foreign: c.provenance === "foreign",
      greyed: state === "detached",
      selectable,
      selected: selectable && selection.has(c.id),
      selectLabel: `Select comment ${c.ordinal} for sending`,
      actions: actionsFor(c, state, readOnly),
    });
  }
  const filterCounts = Object.fromEntries(FILTERS.map((f) => [f, ordered.filter((c) => matchesFilter(c, f)).length])) as Record<RailFilter, number>;
  const count = readOnly ? 0 : selection.size;
  const overCap = count > ARTIFACT_COMMENTS_CAPS.maxBatch;
  const foreign = ordered.filter((c) => c.provenance === "foreign").length;
  return {
    heading: `Comments (${ordered.length})`,
    filter,
    filterCounts,
    rows,
    clusterChip: cluster ? `${cluster.size} ${cluster.size === 1 ? "comment" : "comments"} at this spot` : null,
    emptyText: rows.length === 0
      ? ordered.length === 0 ? "No comments yet. Pick an element and choose Pin to add one." : "No comments match this view."
      : null,
    send: { label: count > 0 ? `Send ${count}` : "Send", count, enabled: count > 0 && !overCap && !readOnly, overCap },
    resolveSentCount: readOnly ? 0 : ordered.filter((c) => c.provenance === "local" && c.status === "sent").length,
    pendingCount: ordered.filter((c) => c.status === "pending").length,
    readOnly,
    notice: input.notice,
    foreignBanner: foreign > 0 && !readOnly
      ? { count: foreign, text: `${foreign} ${foreign === 1 ? "comment came" : "comments came"} from another install. Read ${foreign === 1 ? "it" : "them"}, then adopt the ones you trust.` }
      : null,
    resultsLine: input.resultsLine,
    retry: input.retry === true,
  };
}

/** One plain sentence for the rail's status line, from the per-item results (the plugin's own message is the fallback). */
export function describeBatchReport(report: BatchSendReport): string {
  const count = (result: string): number => report.items.filter((i) => i.result === result).length;
  const parts: string[] = [];
  const sent = count("sent");
  const queued = count("queued");
  const deferred = count("deferred");
  const skipped = count("skipped");
  if (sent > 0) parts.push(`${sent} sent`);
  if (queued > 0) parts.push(`${queued} waiting for the agent`);
  if (deferred > 0) parts.push(`${deferred} left for the next send`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.length > 0 ? parts.join(", ") : report.message;
}

/** The pin's accessible name (3.7): ordinal, status, label, then the first 60 characters of the text. */
export function pinAccessibleName(c: ArtifactComment, state: ArtifactAnchorState): string {
  const approximate = state === "approximate" ? ", approximate position" : "";
  return `Comment ${c.ordinal}, ${c.status}${approximate}, on ${c.label}: ${c.text.slice(0, 60)}`;
}
