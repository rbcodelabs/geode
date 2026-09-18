/**
 * The pure state machine behind the Web Viewer's popup/opener bridge.
 *
 * This depends on background tabs staying mounted. `TabGroup.revealActiveLeaf`
 * keeps every revealed leaf's element in `contentHostEl` and hides the
 * inactive ones with CSS, precisely because detaching an element destroys the
 * `<webview>` guest behind it. Before that invariant existed, activating the
 * popup's tab destroyed the opening page — handle, listeners and all — while
 * it was still blocked in the synchronous claim below, which crashed the app.
 * Anything that goes back to unmounting inactive leaves breaks this bridge,
 * not just its performance. See
 * docs/adr/0021-webviewer-popup-opener-bridge.md.
 *
 * Geode hosts web pages in `<webview>` guests, and main.ts's
 * `setWindowOpenHandler` always denies a real popup: the URL is instead
 * reparented into a brand-new Web Viewer tab in the host renderer (see
 * `openGuestWindowInTab` in src/renderer/app.ts). That keeps every hosted page
 * inside a tab the user can see and close, but it also severs the browsing
 * relationship the web platform guarantees — `window.open()` returns null in
 * the opener, and `window.opener` is null in the popup — which breaks the
 * single most common cross-window pattern on the web, the OAuth popup
 * handshake (`window.opener.postMessage(token, origin)`).
 *
 * This module owns the bookkeeping needed to *shim* that relationship back on
 * top of deny-and-reparent: which popup request belongs to which opener, which
 * reparented guest is standing in for which request, and which origins a
 * relayed `postMessage` is allowed to reach. It deliberately contains no
 * Electron imports and no I/O so the pairing rules — the security-relevant
 * part — are directly unit-testable (tests/unit/webviewer-popups.test.ts).
 * Every Electron-facing side effect lives in main.ts.
 *
 * Posture, unchanged from the rest of the Web Viewer bridge: main decides,
 * main never trusts the guest. No method here takes an origin, a window id, a
 * URL or an opener id *claimed by a page*; main derives all of those from
 * `event.sender` / `event.senderFrame`, or from the guest's own
 * `did-start-navigation`, before calling in. A page's only input to pairing is
 * asking whether it happens to be paired already.
 */

/**
 * How long a denied popup request stays claimable. Generous enough to cover a
 * slow reparented navigation (DNS, a cold TLS handshake, a redirect chain),
 * short enough that a stale request cannot be claimed by an unrelated tab the
 * user opens minutes later.
 */
export const POPUP_HANDLE_TTL_MS = 30_000;

/** Guest → main, synchronous. Opener side: "which popup did I just request?" */
export const POPUP_CLAIM_HANDLE_CHANNEL = "webviewer:popup:claim-handle";
/** Guest → main, synchronous. Popup side: "was I opened by another guest?" */
export const POPUP_CLAIM_OPENER_CHANNEL = "webviewer:popup:claim-opener";
/** Guest → main. A popup posting to `window.opener`. */
export const POPUP_POST_TO_OPENER_CHANNEL = "webviewer:popup:post-to-opener";
/** Guest → main. An opener posting to a handle returned by `window.open`. */
export const POPUP_POST_TO_POPUP_CHANNEL = "webviewer:popup:post-to-popup";
/** Guest → main. `close()` / `focus()` on a shimmed window handle. */
export const POPUP_CONTROL_CHANNEL = "webviewer:popup:control";
/** Main → guest. Delivered messages and lifecycle notifications. */
export const POPUP_RELAY_CHANNEL = "webviewer:popup:relay";

/** Main → guest payloads on POPUP_RELAY_CHANNEL. */
export type PopupRelayMessage =
  /** A relayed `postMessage`. `origin` is derived in main, never sent by the sender. */
  | { kind: "message"; from: "opener" | "popup"; handleId: string; data: unknown; origin: string }
  /** The paired popup guest is gone; the opener's handle reports `closed`. */
  | { kind: "popup-closed"; handleId: string }
  /** The opening guest is gone; the popup's `window.opener` becomes null. */
  | { kind: "opener-gone"; handleId: string };

/** Guest → main payload on POPUP_CONTROL_CHANNEL. */
export interface PopupControlRequest {
  /** Which end of the pair to act on, relative to the sender. */
  target: "popup" | "opener";
  /** Required for `target: "popup"`; ignored otherwise. */
  handleId?: string;
  action: "close" | "focus";
}

/** A denied `window.open` that has not yet been matched to a reparented guest. */
export interface PendingPopup {
  handleId: string;
  openerGuestId: number;
  /** BrowserWindow id. Pairing never crosses windows. */
  windowId: number;
  url: string;
  createdAt: number;
  /**
   * The attach-sequence watermark at the moment the request was made. A guest
   * may only claim this entry if it attached *after* that point — see
   * `noteGuestNavigationStart`. Named for the side that created it, not for
   * its value.
   */
  openerSeq: number;
  /** True once the opener's shimmed `window.open` has taken the handle. */
  handedOut: boolean;
}

export interface PopupPair {
  handleId: string;
  openerGuestId: number;
  popupGuestId: number;
}

export type ClaimOpenerResult =
  | { hasOpener: true; handleId: string }
  | { hasOpener: false };

/** What main must tell the surviving side of a pair after a guest dies. */
export interface GuestDestroyedOutcome {
  /** Openers whose popup went away: their handle's `closed` becomes true. */
  popupClosed: { guestId: number; handleId: string }[];
  /** Popups whose opener went away: their `window.opener` becomes null. */
  openerGone: { guestId: number; handleId: string }[];
}

export interface PopupRegistryOptions {
  /**
   * Required rather than defaulted: the registry is bundled into the
   * sandboxed guest preload alongside the channel constants above, where
   * `node:crypto` does not exist. Keeping the id source injected means this
   * module has no imports at all and cannot drag a Node builtin into that
   * bundle.
   */
  newHandleId: () => string;
  now?: () => number;
  ttlMs?: number;
}

/** The origin of a URL, or null if it has none (about:blank, data:, garbage). */
export function originOf(url: string): string | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  // Opaque origins serialize to the literal "null" and must never satisfy an
  // origin check — two unrelated about:blank documents would otherwise look
  // like the same origin to each other.
  return origin && origin !== "null" ? origin : null;
}

/**
 * `postMessage` targetOrigin semantics, as the web platform defines them:
 * `"*"` reaches any origin, `"/"` reaches the sender's own origin only, and
 * anything else must parse as a URL whose origin exactly equals the
 * receiver's *current* origin. A mismatch is dropped silently, exactly as a
 * browser drops it — the sender is not told, because telling it would leak
 * which origin the receiver has navigated to.
 */
export function shouldDeliverPostMessage(
  targetOrigin: string,
  senderOrigin: string,
  receiverOrigin: string,
): boolean {
  if (targetOrigin === "*") return true;
  if (targetOrigin === "/") return senderOrigin === receiverOrigin;
  const target = originOf(targetOrigin);
  return target !== null && target === receiverOrigin;
}

/**
 * URL identity for matching a reparented guest back to the request that
 * produced it. Compared in canonical form because the URL a page passes to
 * `window.open` and the URL Chromium later reports for the navigation differ
 * in normalization (a bare origin gains a trailing slash, default ports are
 * dropped) — the same reason src/renderer/views/web-view.ts keeps its own
 * `navigationKey`.
 */
function sameTarget(requested: string, navigating: string): boolean {
  if (requested === navigating) return true;
  try {
    return new URL(requested).href === new URL(navigating).href;
  } catch {
    return false;
  }
}

export class WebViewerPopupRegistry {
  private readonly newHandleId: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  private pending: PendingPopup[] = [];
  private readonly byPopupGuest = new Map<number, PopupPair>();
  private readonly byOpenerGuest = new Map<number, Set<string>>();
  private readonly byHandleId = new Map<string, PopupPair>();

  /**
   * Monotonic attach counter. Only the ordering matters: it answers "did this
   * guest exist before that popup was requested?" without needing wall-clock
   * timestamps, which a busy machine can report out of order at millisecond
   * resolution.
   */
  private attachSeq = 0;
  private readonly attachedAt = new Map<number, number>();

  /**
   * Guests that have already started a navigation with a real origin. Only
   * that first one may consume a pending request — see
   * `noteGuestNavigationStart`.
   */
  private readonly navigatedGuests = new Set<number>();

  constructor(options: PopupRegistryOptions) {
    this.newHandleId = options.newHandleId;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? POPUP_HANDLE_TTL_MS;
  }

  /** Called from `did-attach-webview` for every Web Viewer guest. */
  noteGuestAttached(guestId: number): void {
    this.attachSeq += 1;
    this.attachedAt.set(guestId, this.attachSeq);
  }

  /**
   * Record a denied `window.open`. Called from the window-open handler
   * *before* the host renderer is told to open a tab, so the opener's shimmed
   * `window.open` — which claims this entry on the very same turn its native
   * call returns — always finds it.
   */
  requestPopup(input: { openerGuestId: number; windowId: number; url: string }): PendingPopup {
    this.prune();
    const entry: PendingPopup = {
      handleId: this.newHandleId(),
      openerGuestId: input.openerGuestId,
      windowId: input.windowId,
      url: input.url,
      createdAt: this.now(),
      openerSeq: this.attachSeq,
      handedOut: false,
    };
    this.pending.push(entry);
    return entry;
  }

  /**
   * Opener side. Returns the most recent un-handed-out request made by this
   * guest, or null when there is none — in which case the shim returns the
   * native `window.open` result unchanged, so non-http schemes and genuinely
   * blocked popups keep behaving exactly as they did before this bridge
   * existed.
   *
   * Most recent, not oldest: a page that fires several `window.open` calls in
   * a row gets handles back in the order it asked for them, because each call
   * hands out the entry its own native call just created.
   */
  claimHandle(openerGuestId: number): { handleId: string; url: string } | null {
    this.prune();
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const entry = this.pending[i];
      if (entry.openerGuestId !== openerGuestId || entry.handedOut) continue;
      entry.handedOut = true;
      return { handleId: entry.handleId, url: entry.url };
    }
    return null;
  }

  /**
   * Popup side, and the *only* place a pairing is created. Called from main's
   * `did-start-navigation` on the guest, for main-frame, cross-document
   * navigations only.
   *
   * Pairing deliberately happens at navigation **start**, not at document
   * commit. The URL a navigation starts at is the URL that was requested; the
   * URL it commits at is wherever the server sent it. Opening `/auth/start`
   * when that path immediately 302s to an identity provider — the most common
   * real use of this whole bridge — never commits a document at the requested
   * URL at all, so a commit-time match silently handed that popup
   * `window.opener === null`.
   *
   * Returns the pair it created, or null when nothing matched. Null is the
   * normal case: it fires for every Web Viewer navigation in the app, and only
   * a reparented popup has a request waiting for it.
   *
   * A pending entry matches only when every one of these holds:
   *   - same owning BrowserWindow (pairing never crosses windows);
   *   - the URL being navigated to is the one that was requested;
   *   - the navigating guest attached *after* the request was recorded, so a
   *     tab that already existed cannot retroactively become the popup;
   *   - this is that guest's first navigation with a real origin, so a tab
   *     the user later steers onto the requested URL cannot claim it;
   *   - the navigator is not the opener itself;
   *   - the entry is still within its TTL.
   *
   * The first-navigation rule is why opaque-origin URLs are skipped *without*
   * spending it: every `<webview>` boots on `about:blank` before it is sent
   * anywhere (see `BOOTSTRAP_URL` in src/renderer/views/web-view.ts), and
   * counting that bootstrap would leave the real navigation looking like a
   * second one, which would pair nothing at all. An opaque origin can never
   * match a pending entry anyway — main only forwards http/https targets.
   *
   * Residual heuristic, stated honestly: a *brand-new* Web Viewer tab the user
   * happens to open to the exact same URL, in the same window, within the TTL,
   * could claim a pairing meant for the reparented guest. The impact is
   * bounded — such a tab is already on the requested origin, the relay still
   * stamps the true sender origin on every delivered message, and the web
   * platform requires the receiver to validate `event.origin` regardless — but
   * it is a heuristic, not a proof. Closing it properly means having the host
   * renderer report the guest id it created for a given request (the renderer
   * is trusted code, unlike the guest), which is tracked as follow-up work in
   * docs/adr/0021-webviewer-popup-opener-bridge.md.
   */
  noteGuestNavigationStart(guestId: number, windowId: number, url: string): PopupPair | null {
    if (this.byPopupGuest.has(guestId)) return null;
    // Skipped before the first-navigation budget is spent, not after.
    if (originOf(url) === null) return null;
    const popupSeq = this.attachedAt.get(guestId);
    if (popupSeq === undefined) return null;
    if (this.navigatedGuests.has(guestId)) return null;
    this.navigatedGuests.add(guestId);

    this.prune();
    const index = this.pending.findIndex((entry) =>
      entry.windowId === windowId &&
      entry.openerGuestId !== guestId &&
      popupSeq > entry.openerSeq &&
      sameTarget(entry.url, url));
    if (index === -1) return null;

    const [entry] = this.pending.splice(index, 1);
    const pair: PopupPair = {
      handleId: entry.handleId,
      openerGuestId: entry.openerGuestId,
      popupGuestId: guestId,
    };
    this.byPopupGuest.set(guestId, pair);
    this.byHandleId.set(pair.handleId, pair);
    let handles = this.byOpenerGuest.get(pair.openerGuestId);
    if (!handles) {
      handles = new Set();
      this.byOpenerGuest.set(pair.openerGuestId, handles);
    }
    handles.add(pair.handleId);
    return pair;
  }

  /**
   * Popup side, called from the guest preload on every navigation — but only
   * ever a *lookup*. The page asks "am I paired?" and gets an answer keyed by
   * the guest id main resolved from `event.sender`; nothing the page can say
   * or be showing influences it, and re-asking cannot consume a second pending
   * entry.
   *
   * This is what makes the pairing survive navigation: a preload re-runs for
   * each document, and an OAuth popup that has moved on to the provider's
   * consent page must keep its `window.opener`.
   */
  claimOpener(popupGuestId: number): ClaimOpenerResult {
    const existing = this.byPopupGuest.get(popupGuestId);
    return existing ? { hasOpener: true, handleId: existing.handleId } : { hasOpener: false };
  }

  /** The pair this guest belongs to as the popup, if any. */
  pairForPopup(popupGuestId: number): PopupPair | null {
    return this.byPopupGuest.get(popupGuestId) ?? null;
  }

  /**
   * The pair a handle names, but only when `openerGuestId` really is its
   * opener. The handle id travels through the guest, so this is the check
   * that stops one page from addressing another page's popup by guessing or
   * replaying an id.
   */
  pairForOpenerHandle(openerGuestId: number, handleId: unknown): PopupPair | null {
    if (typeof handleId !== "string") return null;
    const pair = this.byHandleId.get(handleId);
    return pair && pair.openerGuestId === openerGuestId ? pair : null;
  }

  /**
   * Tear down everything involving a dead guest and report who needs telling.
   * Both directions matter: a closed popup must flip its opener's
   * `handle.closed`, and a closed opener must null out the popup's
   * `window.opener` — which is what a real browser does when the opening
   * window goes away.
   */
  noteGuestDestroyed(guestId: number): GuestDestroyedOutcome {
    const outcome: GuestDestroyedOutcome = { popupClosed: [], openerGone: [] };
    this.attachedAt.delete(guestId);
    this.navigatedGuests.delete(guestId);
    this.pending = this.pending.filter((entry) => entry.openerGuestId !== guestId);

    const asPopup = this.byPopupGuest.get(guestId);
    if (asPopup) {
      outcome.popupClosed.push({ guestId: asPopup.openerGuestId, handleId: asPopup.handleId });
      this.forget(asPopup);
    }

    for (const handleId of [...(this.byOpenerGuest.get(guestId) ?? [])]) {
      const pair = this.byHandleId.get(handleId);
      if (!pair) continue;
      outcome.openerGone.push({ guestId: pair.popupGuestId, handleId: pair.handleId });
      this.forget(pair);
    }
    this.byOpenerGuest.delete(guestId);
    return outcome;
  }

  /** Test/diagnostic view of the unclaimed queue. */
  pendingCount(): number {
    this.prune();
    return this.pending.length;
  }

  private forget(pair: PopupPair): void {
    this.byPopupGuest.delete(pair.popupGuestId);
    this.byHandleId.delete(pair.handleId);
    this.byOpenerGuest.get(pair.openerGuestId)?.delete(pair.handleId);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    if (this.pending.length === 0) return;
    this.pending = this.pending.filter((entry) => entry.createdAt > cutoff);
  }
}
