import {
  ARTIFACT_COMMENTS_CAPS,
  type AdoptCommentsInput,
  type AnchorReport,
  type ArtifactComment,
  type ArtifactCommentDetail,
  type ArtifactCommentsCapabilities,
  type ArtifactCommentsProvider,
  type ArtifactCommentsRejectReason,
  type ArtifactCommentsResult,
  type ArtifactCommentsSnapshot,
  type BatchSendReport,
  type RemoveCommentInput,
  type SavePinnedCommentInput,
  type SendCommentsInput,
  type UpdateCommentInput,
} from "../../artifacts/feedback-contract-v2";
import type { ArtifactFeedbackOwner, ArtifactFeedbackTarget } from "../../artifacts/feedback-contract";
import {
  checkAdopt,
  checkId,
  checkRemove,
  checkReports,
  checkSave,
  checkSend,
  checkUpdate,
  type Checked,
} from "./comments-input";
import {
  rebuildAdopted,
  rebuildApplied,
  rebuildBatchReport,
  rebuildChange,
  rebuildComment,
  rebuildDetail,
  rebuildRemoved,
  rebuildResult,
  rebuildSaved,
  rebuildSnapshot,
} from "./comments-rebuild";

/**
 * Geode's side of the v2 `comments` provider (ADR 0006 Addendum 1, A2.3 and A2.5): one client per open artifact view.
 *
 * It adds, around another plugin's provider: input validation before the call, a fresh frozen target and an abort
 * signal per call, a timeout (10 s, 15 s for sendBatch), an allowlist rebuild of every result (comments-rebuild.ts),
 * fault isolation (a throw, reject, junk or hang becomes a rejected result and a console.warn, never a throw), a cache
 * of the last good snapshot, and change-event handling (validated, deduplicated by revision, coalesced to one `list`
 * per frame). Nothing here is persisted; disposing the client drops everything.
 */

export interface ArtifactCommentsClient {
  readonly capabilities: ArtifactCommentsCapabilities;
  /** The last good snapshot (never an older revision of the same store), or null before the first successful list. */
  readonly cached: ArtifactCommentsSnapshot | null;
  /** True while a provider subscription is live. False after `onDidChange` when the per-artifact subscription cap was hit or subscribe failed: the view then gets no change events and must say so. */
  readonly liveUpdates: boolean;
  list(): Promise<ArtifactCommentsResult<ArtifactCommentsSnapshot>>;
  get(id: string): Promise<ArtifactCommentsResult<ArtifactCommentDetail>>;
  save(input: SavePinnedCommentInput): Promise<ArtifactCommentsResult<{ readonly comment: ArtifactComment; readonly created: boolean }>>;
  update(input: UpdateCommentInput): Promise<ArtifactCommentsResult<ArtifactComment>>;
  remove(input: RemoveCommentInput): Promise<ArtifactCommentsResult<{ readonly id: string }>>;
  adopt(input: AdoptCommentsInput): Promise<ArtifactCommentsResult<{ readonly adopted: readonly string[] }>>;
  sendBatch(input: SendCommentsInput): Promise<ArtifactCommentsResult<BatchSendReport>>;
  reportAnchors(reports: readonly AnchorReport[]): Promise<ArtifactCommentsResult<{ readonly applied: number }>>;
  /**
   * Called with the outcome of each refresh that a provider change event caused (at most one per frame). The
   * provider subscription is opened with the first listener and closed with the last. Returns the unsubscribe.
   */
  onDidChange(listener: (result: ArtifactCommentsResult<ArtifactCommentsSnapshot>) => void): () => void;
  /** Settles in-flight calls as unavailable (aborting them), drops the subscription and refuses further calls. Idempotent. */
  dispose(): void;
}

export interface CommentsClientDeps {
  readonly owner: ArtifactFeedbackOwner;
  readonly provider: ArtifactCommentsProvider;
  /** Read once by the registry at register; the client never reads `provider.capabilities` itself. */
  readonly capabilities: ArtifactCommentsCapabilities;
  /** Minimum time between the starts of two change-driven refreshes. */
  readonly minRefreshMs: number;
  /** Frozen allowlist copy of the routed target; the same object is passed to every provider call. */
  readonly target: ArtifactFeedbackTarget;
  readonly isLive: () => boolean;
  readonly callTimeoutMs: number;
  readonly sendTimeoutMs: number;
  /** Runs `callback` once on the next frame; returns a cancel function. */
  readonly scheduleFrame: (callback: () => void) => () => void;
  /** Per-root subscription budget (ARTIFACT_COMMENTS_CAPS.maxSubscribersPerRoot). */
  readonly acquireSubscriberSlot: () => boolean;
  readonly releaseSubscriberSlot: () => void;
  /** Called once when the client closes, so the service stops tracking it. */
  readonly onClosed: () => void;
}

interface Flight { settle(result: ArtifactCommentsResult<never>, abort: boolean): void }

const rejected = (reason: ArtifactCommentsRejectReason, message: string): ArtifactCommentsResult<never> => ({ status: "rejected", reason, message });

class CommentsClient implements ArtifactCommentsClient {
  readonly capabilities: ArtifactCommentsCapabilities;
  private snapshot: ArtifactCommentsSnapshot | null = null;
  private closed = false;
  private readonly flights = new Set<Flight>();
  private readonly listeners = new Set<(result: ArtifactCommentsResult<ArtifactCommentsSnapshot>) => void>();
  private subscription: { dispose(): void } | null = null;
  private slotHeld = false;
  private cancelFrame: (() => void) | null = null;
  private refreshing = false;
  private newerDuringRefresh = false;
  /** True from just before `provider.subscribe` is called: a change emitted synchronously inside it must count. */
  private subscribed = false;
  private lastRefreshStartedAt: number | null = null;

  constructor(private readonly deps: CommentsClientDeps) {
    let textEditMethods = false;
    try {
      textEditMethods = typeof deps.provider.commitTextEdit === "function" && typeof deps.provider.undoTextEdit === "function";
    } catch {
      textEditMethods = false;
    }
    this.capabilities = Object.freeze({ pins: true, batchSend: true, textEdit: deps.capabilities.textEdit && textEditMethods });
  }

  get cached(): ArtifactCommentsSnapshot | null { return this.snapshot; }

  get liveUpdates(): boolean { return this.subscription !== null; }

  list(): Promise<ArtifactCommentsResult<ArtifactCommentsSnapshot>> {
    return this.invoke("list", this.deps.callTimeoutMs, (ctx) => this.deps.provider.list(this.deps.target, ctx), rebuildSnapshot).then((result) => {
      if (result.status !== "ok") return result;
      this.remember(result.value);
      // A slower, older answer must not reach the caller (or a change listener) after a newer one was cached.
      const kept = this.snapshot;
      return kept !== null && kept !== result.value && kept.storeId === result.value.storeId && kept.revision > result.value.revision
        ? { status: "ok" as const, value: kept }
        : result;
    });
  }

  get(id: string): Promise<ArtifactCommentsResult<ArtifactCommentDetail>> {
    const checked = checkId(id);
    if (!checked.ok) return this.invalid(checked);
    return this.invoke("get", this.deps.callTimeoutMs, (ctx) => this.deps.provider.get(this.deps.target, checked.value, ctx),
      (raw) => { const detail = rebuildDetail(raw, this.deps.target); return detail !== null && detail.comment.id === checked.value ? detail : null; });
  }

  save(input: SavePinnedCommentInput): Promise<ArtifactCommentsResult<{ readonly comment: ArtifactComment; readonly created: boolean }>> {
    let checked: Checked<SavePinnedCommentInput>;
    try {
      checked = checkSave(input, this.deps.target);
    } catch {
      return Promise.resolve(rejected("invalid", "That request could not be read."));
    }
    if (!checked.ok) return this.invalid(checked);
    const selectionId = checked.value.request.selection.selectionId;
    return this.invoke("save", this.deps.callTimeoutMs, (ctx) => this.deps.provider.save(this.deps.target, checked.value, ctx),
      (raw) => { const saved = rebuildSaved(raw); return saved !== null && saved.comment.selectionId === selectionId ? saved : null; });
  }

  update(input: UpdateCommentInput): Promise<ArtifactCommentsResult<ArtifactComment>> {
    const checked = checkUpdate(input);
    if (!checked.ok) return this.invalid(checked);
    return this.invoke("update", this.deps.callTimeoutMs, (ctx) => this.deps.provider.update(this.deps.target, checked.value, ctx),
      (raw) => { const comment = rebuildComment(raw); return comment !== null && comment.id === checked.value.id ? comment : null; });
  }

  remove(input: RemoveCommentInput): Promise<ArtifactCommentsResult<{ readonly id: string }>> {
    const checked = checkRemove(input);
    if (!checked.ok) return this.invalid(checked);
    return this.invoke("remove", this.deps.callTimeoutMs, (ctx) => this.deps.provider.remove(this.deps.target, checked.value, ctx),
      (raw) => { const removed = rebuildRemoved(raw); return removed !== null && removed.id === checked.value.id ? removed : null; });
  }

  adopt(input: AdoptCommentsInput): Promise<ArtifactCommentsResult<{ readonly adopted: readonly string[] }>> {
    const checked = checkAdopt(input);
    if (!checked.ok) return this.invalid(checked);
    const asked = new Set(checked.value.ids);
    return this.invoke("adopt", this.deps.callTimeoutMs, (ctx) => this.deps.provider.adopt(this.deps.target, checked.value, ctx),
      (raw) => { const adopted = rebuildAdopted(raw); return adopted !== null && adopted.adopted.every((id) => asked.has(id)) ? adopted : null; });
  }

  sendBatch(input: SendCommentsInput): Promise<ArtifactCommentsResult<BatchSendReport>> {
    const checked = checkSend(input);
    if (!checked.ok) return this.invalid(checked);
    const asked = new Set(checked.value.ids);
    return this.invoke("sendBatch", this.deps.sendTimeoutMs, (ctx) => this.deps.provider.sendBatch(this.deps.target, checked.value, ctx),
      (raw) => {
        const report = rebuildBatchReport(raw);
        return report !== null && report.requestId === checked.value.requestId && report.items.every((item) => asked.has(item.id)) ? report : null;
      });
  }

  reportAnchors(reports: readonly AnchorReport[]): Promise<ArtifactCommentsResult<{ readonly applied: number }>> {
    const checked = checkReports(reports);
    if (!checked.ok) return this.invalid(checked);
    const provider = this.deps.provider;
    if (typeof provider.reportAnchors !== "function") {
      return Promise.resolve(rejected("unavailable", "This plugin does not accept anchor reports."));
    }
    return this.invoke("reportAnchors", this.deps.callTimeoutMs, (ctx) => provider.reportAnchors!(this.deps.target, checked.value, ctx), rebuildApplied);
  }

  onDidChange(listener: (result: ArtifactCommentsResult<ArtifactCommentsSnapshot>) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    if (!this.subscribed) this.openSubscription();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.closeSubscription();
    };
  }

  dispose(): void {
    this.close(`${this.deps.owner.displayName} comments are no longer available.`);
  }

  /** Called by the service when the handler is unregistered. */
  handlerGone(): void {
    this.close(`${this.deps.owner.displayName} was unloaded before it answered. Check the thread to see whether your comment arrived.`);
  }

  private close(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const flight of [...this.flights]) flight.settle(rejected("unavailable", message), true);
    this.closeSubscription();
    this.listeners.clear();
    this.deps.onClosed();
  }

  private invalid(checked: Extract<Checked<unknown>, { ok: false }>): Promise<ArtifactCommentsResult<never>> {
    return Promise.resolve(rejected("invalid", checked.message));
  }

  /** Keeps the cache monotonic: an older revision of the same store never replaces a newer one. */
  private remember(next: ArtifactCommentsSnapshot): void {
    const current = this.snapshot;
    if (current === null || current.storeId !== next.storeId || next.revision >= current.revision) this.snapshot = next;
  }

  private invoke<T>(
    label: string,
    timeoutMs: number,
    call: (ctx: { readonly signal: AbortSignal }) => Promise<unknown>,
    rebuild: (raw: unknown) => T | null,
  ): Promise<ArtifactCommentsResult<T>> {
    const name = this.deps.owner.displayName;
    if (this.closed || !this.deps.isLive()) return Promise.resolve(rejected("unavailable", `${name} comments are not available right now.`));
    return new Promise<ArtifactCommentsResult<T>>((resolve) => {
      const controller = new AbortController();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flight: Flight = {
        settle: (result, abort) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          this.flights.delete(flight);
          if (abort) controller.abort();
          resolve(result as ArtifactCommentsResult<T>);
        },
      };
      this.flights.add(flight);
      timer = setTimeout(() => {
        console.warn(`[artifact-comments] "${this.deps.owner.pluginId}" ${label} did not answer within ${timeoutMs} ms`);
        const waited = `No response from ${name} in ${Math.round(timeoutMs / 1000)} s.`;
        // A write may have reached the plugin even though no answer came back (v1 submit wording).
        const hint = label === "save" ? " It may have been received; check the thread before retrying. Retry reuses the same selection id."
          : label === "sendBatch" ? " It may have been received; check the thread before retrying. Retry reuses the same request id."
          : "";
        flight.settle(rejected("failed", waited + hint), true);
      }, timeoutMs);
      const failed = (error: unknown): void => {
        console.warn(`[artifact-comments] "${this.deps.owner.pluginId}" ${label} failed`, error);
        flight.settle(rejected("failed", `${name} could not complete that.`), false);
      };
      let promise: Promise<unknown>;
      try {
        promise = Promise.resolve(call({ signal: controller.signal }));
      } catch (error) {
        failed(error);
        return;
      }
      promise.then((raw) => {
        const result = rebuildResult(raw, rebuild);
        if (result === null) {
          console.warn(`[artifact-comments] "${this.deps.owner.pluginId}" ${label} returned a malformed result`);
          flight.settle(rejected("failed", `${name} returned an invalid response.`), false);
          return;
        }
        flight.settle(result as ArtifactCommentsResult<never>, false);
      }, failed);
    });
  }

  // ---- change events -----------------------------------------------------------------------------------------

  private openSubscription(): void {
    if (!this.deps.acquireSubscriberSlot()) {
      console.warn(`[artifact-comments] more than ${ARTIFACT_COMMENTS_CAPS.maxSubscribersPerRoot} subscriptions for one artifact; this one will not receive change events`);
      return;
    }
    this.slotHeld = true;
    this.subscribed = true;
    try {
      const subscription = this.deps.provider.subscribe(this.deps.target, (raw) => this.onProviderChange(raw));
      if (subscription === null || typeof subscription !== "object" || typeof subscription.dispose !== "function") {
        throw new Error("subscribe did not return a disposable");
      }
      this.subscription = subscription;
    } catch (error) {
      console.warn(`[artifact-comments] "${this.deps.owner.pluginId}" subscribe failed`, error);
      this.subscribed = false;
      this.cancelPending();
      this.releaseSlot();
    }
  }

  private cancelPending(): void {
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.newerDuringRefresh = false;
  }

  private closeSubscription(): void {
    this.subscribed = false;
    this.cancelPending();
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription !== null) {
      try { subscription.dispose(); } catch (error) { console.warn(`[artifact-comments] "${this.deps.owner.pluginId}" subscription dispose threw`, error); }
    }
    this.releaseSlot();
  }

  private releaseSlot(): void {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    this.deps.releaseSubscriberSlot();
  }

  /** Never throws: it runs inside the plugin's call stack. */
  private onProviderChange(raw: unknown): void {
    try {
      if (this.closed || !this.subscribed) return;
      const change = rebuildChange(raw);
      // A malformed event is not trusted for its content, but a plausible revision still means "something changed":
      // the list that follows is the authority (A8).
      const revision = change !== null ? change.revision : plausibleRevision(raw);
      if (change === null) {
        console.warn(`[artifact-comments] "${this.deps.owner.pluginId}" sent a malformed change event`);
        if (revision === null) return;
      }
      const current = this.snapshot;
      if (change !== null && current !== null && current.storeId === change.storeId && change.revision <= current.revision) return;
      if (change === null && current !== null && revision !== null && revision <= current.revision) return;
      if (this.refreshing) { this.newerDuringRefresh = true; return; }
      this.scheduleRefresh();
    } catch (error) {
      console.warn("[artifact-comments] change event handling failed", error);
    }
  }

  /** Coalesces to one refresh per frame and at most one per `minRefreshMs`. */
  private scheduleRefresh(): void {
    if (this.cancelFrame !== null) return;
    const wait = this.lastRefreshStartedAt === null ? 0 : Math.max(0, this.lastRefreshStartedAt + this.deps.minRefreshMs - Date.now());
    const run = (): void => {
      this.cancelFrame = this.deps.scheduleFrame(() => {
        this.cancelFrame = null;
        void this.refresh();
      });
    };
    if (wait === 0) { run(); return; }
    const timer = setTimeout(run, wait);
    this.cancelFrame = () => clearTimeout(timer);
  }

  private async refresh(): Promise<void> {
    if (this.closed || !this.subscribed) return;
    this.refreshing = true;
    this.newerDuringRefresh = false;
    this.lastRefreshStartedAt = Date.now();
    const result = await this.list();
    this.refreshing = false;
    if (this.closed) return;
    for (const listener of [...this.listeners]) {
      try { listener(result); } catch (error) { console.warn("[artifact-comments] onDidChange listener threw", error); }
    }
    // A failed refresh is not retried in a loop: the next event or the next load() tries again.
    if (result.status === "ok" && this.newerDuringRefresh && this.subscribed) this.scheduleRefresh();
    this.newerDuringRefresh = false;
  }
}

/** The revision of a change event that failed validation, when it is a plain non-negative integer. */
function plausibleRevision(raw: unknown): number | null {
  try {
    if (raw === null || typeof raw !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(raw, "revision");
    const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function createCommentsClient(deps: CommentsClientDeps): ArtifactCommentsClient & { handlerGone(): void } {
  return new CommentsClient(deps);
}
