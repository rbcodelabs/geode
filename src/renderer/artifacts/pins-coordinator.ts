import {
  ARTIFACT_COMMENTS_CAPS,
  type ArtifactAnchorState,
  type ArtifactComment,
  type ArtifactCommentsSnapshot,
  type SendCommentsInput,
} from "../../artifacts/feedback-contract-v2";
import type {
  InspectAnchorFocusBehavior,
  InspectAnchorRectsMessage,
  InspectAnchorResultsMessage,
} from "../../artifacts/inspector-protocol";
import type { AnchorSetOutcome } from "../views/artifact-inspector-bridge";
import type { ArtifactCommentsClient } from "./comments-client";
import {
  PIN_BADGE,
  badgeAnchorPoint,
  collapsePins,
  guestRectToStage,
  intersectsStage,
  type BoxRect,
  type FrameOrigin,
  type PlacedPin,
} from "./pin-collapse";
import type { PinBadgeView } from "./pin-overlay";
import {
  anchorStateFromResult,
  buildRailView,
  describeBatchReport,
  effectiveSelection,
  pinAccessibleName,
  type RailFilter,
  type RailView,
  type RowAction,
} from "./rail-model";

/**
 * The wiring between one open artifact's comments client, the guest anchor channels and the rail / pin layer (design
 * 3.4, 3.8; ADR 0006 Addendum 1 A.5). DOM-free: it owns the data flow, the view (`PinsUi`) owns the elements.
 *
 *   plugin store --list/subscribe--> client --> snapshot --+--> rail view model --> ui.renderRail
 *                                                          +--> anchor queries (ids/selectors only) --> bridge.setAnchors
 *   guest --anchor-results/rects--> placements --> collapse --> ui.renderPins
 *
 * What the page process receives is only the allowlisted query fields; comment text, ids, statuses and ordinals never
 * leave the embedder (T9).
 *
 * Send rule (plugin P2b QA): every user click on Send / Send again mints a NEW request id. A request id is reused only
 * by `retryLastSend`, the transport-level retry of that one click after a timeout or abort.
 */

export interface PinsGeometry {
  readonly frame: FrameOrigin;
  readonly stage: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

export interface PinsUi {
  renderRail(view: RailView): void;
  renderPins(badges: readonly PinBadgeView[], busy: boolean): void;
  /** Text for the polite live region. */
  announce(text: string): void;
  availability(state: { readonly pin: boolean; readonly rail: boolean; readonly count: number }): void;
  focusRail(target: { readonly type: "heading" } | { readonly type: "row"; readonly id: string }): void;
  geometry(): PinsGeometry | null;
  railOpenChanged?(open: boolean): void;
}

export interface PinsBridge {
  setAnchors(queries: readonly unknown[]): AnchorSetOutcome;
  focusAnchor(key: string, behavior: InspectAnchorFocusBehavior): boolean;
}

export interface PinsCoordinatorDeps {
  /** The routed v2 handler's client, read at call time; null for a v1 handler or none. */
  readonly getClient: () => ArtifactCommentsClient | null;
  readonly bridge: PinsBridge;
  readonly ui: PinsUi;
  /** Runs the callback on the next frame; returns a cancel function. */
  readonly scheduleFrame: (callback: () => void) => () => void;
  /** `req_` plus 32 hex digits. */
  readonly newRequestId: () => string;
}

interface Placement { state: ArtifactAnchorState; rect: BoxRect | null; visible: boolean }
interface SendClick { readonly requestId: string; readonly ids: readonly string[]; readonly resend: boolean }
export interface PinBadgeTarget { readonly key: string; readonly kind: "pin" | "cluster"; readonly ids: readonly string[] }

const PLACED: ReadonlySet<ArtifactAnchorState> = new Set(["exact", "moved", "approximate"]);
const LIVE = new Set(["open", "pending", "sent"]);
const PAST: Record<string, string> = { resolve: "resolved", dismiss: "dismissed", reopen: "reopened", unqueue: "returned to open" };
const INTENDED: Record<string, string> = { resolve: "resolved", dismiss: "dismissed", reopen: "open", unqueue: "open" };
const SUMMARY_DELAY_MS = 1000;

export interface PinsCoordinator {
  readonly pinAvailable: boolean;
  readonly railAvailable: boolean;
  readonly railOpen: boolean;
  start(): Promise<void>;
  refresh(): Promise<void>;
  openRail(options?: { focus?: { readonly type: "heading" } | { readonly type: "row"; readonly id: string } }): Promise<void>;
  closeRail(): void;
  toggleRail(): Promise<void>;
  escapeRail(): "cluster" | "closed" | "none";
  onAnchorResults(message: InspectAnchorResultsMessage): void;
  onAnchorRects(message: InspectAnchorRectsMessage): void;
  onAnchorsSent(epoch: number): void;
  layoutChanged(): void;
  setFilter(filter: RailFilter): void;
  clearCluster(): void;
  toggleSelect(id: string, selected: boolean): void;
  activateBadge(badge: PinBadgeTarget): void;
  runAction(id: string, action: RowAction): Promise<void>;
  sendSelected(): Promise<void>;
  retryLastSend(): Promise<void>;
  resolveSent(): Promise<void>;
  adoptAll(): Promise<void>;
  pinned(selectionId: string): Promise<void>;
  focusTargetAfterPin(): { readonly type: "badge"; readonly id: string } | { readonly type: "toggle" };
  dispose(): void;
}

export function createPinsCoordinator(deps: PinsCoordinatorDeps): PinsCoordinator {
  const { bridge, ui } = deps;
  let snapshot: ArtifactCommentsSnapshot | null = null;
  let listError: string | null = null;
  let filter: RailFilter = "all";
  let clusterIds: readonly string[] | null = null;
  let selected: ReadonlySet<string> | null = null;
  let resultsLine: string | null = null;
  let lastSend: SendClick | null = null;
  let sending = false;
  let railOpen = false;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let pinAvailable = false;
  let railAvailable = false;

  const placements = new Map<string, Placement>();
  const keyToId = new Map<string, string>();
  const idToKey = new Map<string, string>();
  let signature: string | null = null;
  let epoch = 0;
  let busy = false;
  let assignment: ReadonlyMap<string, string> | null = null;
  let lastBadges: readonly PinBadgeView[] = [];
  let lastPinnedId: string | null = null;

  let cancelFrame: (() => void) | null = null;
  let railDirty = false;
  let summaryTimer: ReturnType<typeof setTimeout> | null = null;
  let changedSinceSummary = { moved: 0, detached: 0 };

  const client = (): ArtifactCommentsClient | null => deps.getClient();
  const comments = (): readonly ArtifactComment[] => snapshot?.comments ?? [];
  const byId = (id: string): ArtifactComment | undefined => comments().find((c) => c.id === id);
  const stateOf = (id: string): ArtifactAnchorState => placements.get(id)?.state ?? "unknown";

  // ---- rendering ----

  function railView(): RailView {
    const anchorStates: Record<string, ArtifactAnchorState> = {};
    for (const c of comments()) anchorStates[c.id] = stateOf(c.id);
    return buildRailView({
      comments: comments(),
      anchorStates,
      filter,
      clusterIds,
      selected,
      notice: listError ?? snapshot?.notice ?? null,
      health: snapshot?.health ?? "ok",
      resultsLine,
      retry: lastSend !== null,
    });
  }

  function renderRail(): void {
    railDirty = false;
    if (!disposed) ui.renderRail(railView());
  }

  const showsOnCanvas = (c: ArtifactComment): boolean => LIVE.has(c.status) || filter === c.status;

  function renderPins(): void {
    if (disposed) return;
    const geometry = ui.geometry();
    const placed: PlacedPin[] = [];
    const byPinId = new Map<string, ArtifactComment>();
    if (geometry && !busyUnavailable()) {
      for (const c of comments()) {
        if (c.kind !== "pin" || !showsOnCanvas(c)) continue;
        const p = placements.get(c.id);
        if (!p || p.rect === null || !p.visible || !PLACED.has(p.state)) continue;
        const box = guestRectToStage(p.rect, geometry.frame, geometry.stage);
        if (!intersectsStage(box, geometry.stage)) continue;
        const point = badgeAnchorPoint(box, geometry.stage);
        placed.push({ id: c.id, ordinal: c.ordinal, status: c.status, x: point.x, y: point.y, approximate: p.state === "approximate" });
        byPinId.set(c.id, c);
      }
    }
    const collapsed = collapsePins(placed, assignment);
    assignment = collapsed.assignment;
    lastBadges = collapsed.badges.map((badge): PinBadgeView => {
      if (badge.kind === "cluster") {
        return { key: badge.key, kind: "cluster", ids: badge.ids, x: badge.x, y: badge.y, text: String(badge.count), label: `${badge.count} comments here. Activate to list`, status: badge.status, approximate: badge.approximate, z: badge.z };
      }
      const c = byPinId.get(badge.ids[0]!)!;
      return { key: badge.key, kind: "pin", ids: badge.ids, x: badge.x, y: badge.y, text: String(c.ordinal), label: pinAccessibleName(c, stateOf(c.id)), status: badge.status, approximate: badge.approximate, z: badge.z };
    });
    ui.renderPins(lastBadges, busy);
  }
  const busyUnavailable = (): boolean => false;

  function scheduleRender(rail = false): void {
    if (disposed) return;
    if (rail) railDirty = true;
    if (cancelFrame !== null) return;
    cancelFrame = deps.scheduleFrame(() => {
      cancelFrame = null;
      if (railDirty) renderRail();
      renderPins();
    });
  }

  // ---- data ----

  function updateAvailability(): void {
    const c = client();
    const live = comments().length < ARTIFACT_COMMENTS_CAPS.maxComments;
    railAvailable = c !== null;
    pinAvailable = c !== null && snapshot !== null && listError === null && (snapshot.health === "ok" || snapshot.health === "recovered") && live;
    ui.availability({ pin: pinAvailable, rail: railAvailable, count: comments().length });
  }

  function syncAnchors(): void {
    const list = [...comments().filter((c) => c.kind === "pin")]
      .sort((a, b) => Number(!LIVE.has(a.status)) - Number(!LIVE.has(b.status)) || a.ordinal - b.ordinal)
      .slice(0, PIN_BADGE.maxPins);
    // Built field by field: exactly the allowlist the guest accepts, nothing the embedder knows about the comments.
    const queries = list.map((c, i) => ({
      key: `a${i}`,
      route: c.anchor.route,
      tag: c.anchor.tag,
      selector: c.anchor.selector,
      alternates: [...c.anchor.selectorAlternates],
      textAnchor: { tag: c.anchor.textAnchor.tag, text: c.anchor.textAnchor.text },
      landmark: c.anchor.landmark,
    }));
    const next = JSON.stringify(queries.map((q) => [q.route, q.tag, q.selector, q.alternates, q.textAnchor, q.landmark]));
    if (next === (signature ?? "[]")) { signature = next; return; }
    signature = next;
    keyToId.clear();
    idToKey.clear();
    list.forEach((c, i) => { keyToId.set(`a${i}`, c.id); idToKey.set(c.id, `a${i}`); });
    for (const id of [...placements.keys()]) if (!idToKey.has(id)) placements.delete(id);
    const outcome = bridge.setAnchors(queries);
    epoch = outcome.epoch;
    for (const key of outcome.rejected) {
      const id = keyToId.get(key);
      if (id) placements.set(id, { state: "detached", rect: null, visible: false });
    }
    busy = outcome.sent > 0;
  }

  function afterData(): void {
    if (disposed) return;
    if (client() === null) {
      if (signature !== null && signature !== "[]") { signature = "[]"; keyToId.clear(); idToKey.clear(); placements.clear(); bridge.setAnchors([]); busy = false; }
      snapshot = null;
    } else syncAnchors();
    updateAvailability();
    renderRail();
    scheduleRender();
  }

  async function list(): Promise<boolean> {
    const c = client();
    if (c === null) { afterData(); return false; }
    const result = await c.list();
    if (disposed) return false;
    if (result.status === "ok") { snapshot = result.value; listError = null; } else listError = result.message;
    afterData();
    return result.status === "ok";
  }

  function subscribe(): void {
    if (unsubscribe !== null) return;
    const c = client();
    if (c === null) return;
    unsubscribe = c.onDidChange((result) => {
      if (disposed || !railOpen) return;
      if (result.status === "ok") { snapshot = result.value; listError = null; } else listError = result.message;
      afterData();
    });
  }

  function unsubscribeNow(): void {
    const off = unsubscribe;
    unsubscribe = null;
    try { off?.(); } catch { /* the client is already gone */ }
  }

  // ---- anchor feedback from the guest ----

  function noteTransition(id: string, before: ArtifactAnchorState, after: ArtifactAnchorState): void {
    if (before === "unknown" || before === after) return;
    if (after === "moved" || after === "approximate") changedSinceSummary.moved++;
    else if (after === "detached") changedSinceSummary.detached++;
    else return;
    if (summaryTimer !== null) return;
    summaryTimer = setTimeout(() => {
      summaryTimer = null;
      const { moved, detached } = changedSinceSummary;
      changedSinceSummary = { moved: 0, detached: 0 };
      const parts = [moved > 0 ? `${moved} ${moved === 1 ? "comment" : "comments"} moved` : "", detached > 0 ? `${detached} detached` : ""].filter(Boolean);
      if (parts.length > 0 && !disposed) ui.announce(parts.join(", "));
    }, SUMMARY_DELAY_MS);
    (summaryTimer as { unref?: () => void }).unref?.();
    void id;
  }

  function onAnchorResults(message: InspectAnchorResultsMessage): void {
    if (disposed || message.epoch !== epoch) return;
    for (const r of message.results) {
      const id = keyToId.get(r.key);
      if (!id) continue;
      const state = anchorStateFromResult(r);
      noteTransition(id, stateOf(id), state);
      placements.set(id, { state, rect: r.rect, visible: r.visible });
    }
    busy = false;
    scheduleRender(true);
  }

  function onAnchorRects(message: InspectAnchorRectsMessage): void {
    if (disposed || message.epoch !== epoch) return;
    let stateChanged = false;
    for (const r of message.rects) {
      const id = keyToId.get(r.key);
      const current = id ? placements.get(id) : undefined;
      if (!id || !current) continue;
      if (r.rect === null) {
        if (current.state !== "detached") { noteTransition(id, current.state, "detached"); stateChanged = true; }
        placements.set(id, { state: "detached", rect: null, visible: false });
      } else {
        placements.set(id, { state: current.state === "detached" ? "approximate" : current.state, rect: r.rect, visible: r.visible });
        if (current.state === "detached") stateChanged = true;
      }
    }
    scheduleRender(stateChanged);
  }

  // ---- the rail ----

  async function openRail(options?: { focus?: { type: "heading" } | { type: "row"; id: string } }): Promise<void> {
    if (disposed || client() === null) return;
    const wasOpen = railOpen;
    railOpen = true;
    if (!wasOpen) {
      ui.railOpenChanged?.(true);
      subscribe();
      // A change between the list at load and the subscription must not be missed: list again once subscribed.
      await list();
    }
    if (disposed) return;
    ui.focusRail(options?.focus ?? { type: "heading" });
  }

  function closeRail(): void {
    if (!railOpen) return;
    railOpen = false;
    clusterIds = null;
    unsubscribeNow();
    if (!disposed) { renderRail(); scheduleRender(); }
    ui.railOpenChanged?.(false);
  }

  function activateBadge(badge: PinBadgeTarget): void {
    if (badge.kind === "pin") {
      const id = badge.ids[0];
      if (!id) return;
      filter = "all";
      clusterIds = null;
      const key = idToKey.get(id);
      void openRail({ focus: { type: "row", id } }).then(() => { if (key !== undefined) bridge.focusAnchor(key, "scroll"); });
      if (railOpen) { renderRail(); }
      return;
    }
    filter = "all";
    clusterIds = [...badge.ids];
    if (railOpen) renderRail();
    void openRail({ focus: { type: "heading" } });
  }

  // ---- actions ----

  async function mutate(c: ArtifactComment, action: "resolve" | "dismiss" | "reopen" | "unqueue"): Promise<boolean> {
    const cl = client();
    if (cl === null) return false;
    const result = await cl.update({ id: c.id, expectedVersion: c.version, change: { action } });
    if (disposed) return false;
    if (result.status === "ok") { ui.announce(`Comment ${c.ordinal} ${PAST[action]}.`); await list(); return true; }
    if (result.reason === "conflict") {
      await list();
      ui.announce(`Comment ${c.ordinal} changed elsewhere. The list was refreshed; try again.`);
      return false;
    }
    await list();
    if (result.reason === "invalid-transition" && byId(c.id)?.status === INTENDED[action]) {
      ui.announce(`Comment ${c.ordinal} ${PAST[action]}.`);
      return true;
    }
    ui.announce(result.message);
    return false;
  }

  async function dispatchSend(click: SendClick): Promise<void> {
    const cl = client();
    if (cl === null || sending) return;
    sending = true;
    try {
      const anchorStates: Record<string, ArtifactAnchorState> = {};
      for (const id of click.ids) anchorStates[id] = stateOf(id);
      const input: SendCommentsInput = { requestId: click.requestId, ids: click.ids, resend: click.resend, anchorStates };
      const result = await cl.sendBatch(input);
      if (disposed) return;
      if (result.status === "ok") {
        lastSend = null;
        resultsLine = describeBatchReport(result.value);
      } else {
        resultsLine = result.message;
        // Only a transport failure (timeout, abort) is retried with the same request id; everything else needs a new click.
        lastSend = result.reason === "failed" ? click : null;
      }
      ui.announce(resultsLine);
    } finally {
      sending = false;
    }
    await list();
  }

  function mintClick(ids: readonly string[], resend: boolean): SendClick {
    const order = new Map(comments().map((c) => [c.id, c.ordinal]));
    const sorted = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return { requestId: deps.newRequestId(), ids: sorted, resend };
  }

  return {
    get pinAvailable() { return pinAvailable; },
    get railAvailable() { return railAvailable; },
    get railOpen() { return railOpen; },

    start: async () => { await list(); },
    refresh: async () => { await list(); },
    openRail,
    closeRail,
    toggleRail: async () => { if (railOpen) closeRail(); else await openRail(); },
    escapeRail() {
      if (!railOpen) return "none";
      if (clusterIds !== null) { clusterIds = null; renderRail(); scheduleRender(); return "cluster"; }
      closeRail();
      return "closed";
    },
    onAnchorResults,
    onAnchorRects,
    onAnchorsSent(sentEpoch) {
      if (disposed) return;
      epoch = sentEpoch;
      busy = keyToId.size > 0;
      scheduleRender();
    },
    layoutChanged: () => scheduleRender(),
    setFilter(next) { filter = next; clusterIds = null; renderRail(); scheduleRender(); },
    clearCluster() { clusterIds = null; renderRail(); },
    toggleSelect(id, on) {
      const next = new Set(effectiveSelection(comments(), selected));
      if (on) next.add(id); else next.delete(id);
      selected = next;
      renderRail();
    },
    activateBadge,

    async runAction(id, action) {
      const c = byId(id);
      const cl = client();
      if (!c || cl === null || disposed) return;
      switch (action) {
        case "jump": {
          const key = idToKey.get(id);
          if (key !== undefined) { bridge.focusAnchor(key, "scroll"); bridge.focusAnchor(key, "flash"); }
          return;
        }
        case "send":
        case "resend":
          lastSend = null;
          await dispatchSend(mintClick([id], action === "resend"));
          return;
        case "adopt": {
          const result = await cl.adopt({ ids: [id] });
          if (disposed) return;
          ui.announce(result.status === "ok" ? `Comment ${c.ordinal} adopted.` : result.message);
          await list();
          return;
        }
        case "delete": {
          const result = await cl.remove({ id, expectedVersion: c.version });
          if (disposed) return;
          ui.announce(result.status === "ok" ? `Comment ${c.ordinal} deleted.` : result.message);
          await list();
          return;
        }
        default:
          await mutate(c, action);
      }
    },

    async sendSelected() {
      if (disposed || client() === null) return;
      const ids = [...effectiveSelection(comments(), selected)];
      if (ids.length === 0) return;
      if (ids.length > ARTIFACT_COMMENTS_CAPS.maxBatch) {
        ui.announce(`Select at most ${ARTIFACT_COMMENTS_CAPS.maxBatch} comments per send.`);
        return;
      }
      lastSend = null;
      await dispatchSend(mintClick(ids, false));
    },

    async retryLastSend() {
      const click = lastSend;
      if (click === null || disposed) return;
      await dispatchSend(click);
    },

    async resolveSent() {
      const targets = comments().filter((c) => c.provenance === "local" && c.status === "sent").sort((a, b) => a.ordinal - b.ordinal);
      let done = 0;
      for (const c of targets) {
        const cl = client();
        if (cl === null || disposed) return;
        const result = await cl.update({ id: c.id, expectedVersion: c.version, change: { action: "resolve" } });
        if (result.status !== "ok") { ui.announce(result.message); break; }
        done++;
      }
      if (done > 0) ui.announce(`Resolved ${done} ${done === 1 ? "comment" : "comments"}.`);
      await list();
    },

    async adoptAll() {
      const cl = client();
      if (cl === null) return;
      const ids = comments().filter((c) => c.provenance === "foreign").map((c) => c.id);
      let adopted = 0;
      for (let i = 0; i < ids.length; i += ARTIFACT_COMMENTS_CAPS.maxBatch) {
        const result = await cl.adopt({ ids: ids.slice(i, i + ARTIFACT_COMMENTS_CAPS.maxBatch) });
        if (disposed) return;
        if (result.status !== "ok") { ui.announce(result.message); break; }
        adopted += result.value.adopted.length;
      }
      if (adopted > 0) ui.announce(`Adopted ${adopted} ${adopted === 1 ? "comment" : "comments"}.`);
      await list();
    },

    async pinned(selectionId) {
      lastPinnedId = `cmt_${selectionId.slice(4)}`;
      await list();
    },

    focusTargetAfterPin() {
      const id = lastPinnedId;
      if (id !== null && lastBadges.some((b) => b.ids.includes(id))) return { type: "badge", id };
      return { type: "toggle" };
    },

    dispose() {
      if (disposed) return;
      unsubscribeNow();
      cancelFrame?.();
      cancelFrame = null;
      if (summaryTimer !== null) clearTimeout(summaryTimer);
      summaryTimer = null;
      if (signature !== null && signature !== "[]") bridge.setAnchors([]);
      disposed = true;
    },
  };
}
