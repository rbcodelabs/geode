import { beforeEach, describe, expect, it } from "vitest";
import {
  originOf,
  shouldDeliverPostMessage,
  WebViewerPopupRegistry,
  POPUP_HANDLE_TTL_MS,
} from "../../src/main/webviewer-popups";

const WINDOW_A = 1;
const WINDOW_B = 2;
const POPUP_URL = "https://provider.example/authorize?client=x";

/** Deterministic clock + handle ids: pairing rules are the thing under test. */
function makeRegistry(options: { ttlMs?: number } = {}) {
  let clock = 1_000_000;
  let counter = 0;
  const registry = new WebViewerPopupRegistry({
    newHandleId: () => `handle-${++counter}`,
    now: () => clock,
    ttlMs: options.ttlMs,
  });
  return {
    registry,
    advance: (ms: number) => { clock += ms; },
  };
}

/** The common case: opener attaches, requests a popup, a new guest attaches. */
function pairedRegistry() {
  const harness = makeRegistry();
  const { registry } = harness;
  registry.noteGuestAttached(10);
  const pending = registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
  registry.noteGuestAttached(20);
  return { ...harness, pending };
}

/**
 * Every `<webview>` boots on `about:blank` before it is sent anywhere (see
 * `BOOTSTRAP_URL` in src/renderer/views/web-view.ts), so the real navigation
 * main sees is never a guest's literally-first one. Tests that care about the
 * first-navigation rule replay that bootstrap rather than assuming it away.
 */
function bootstrap(registry: WebViewerPopupRegistry, guestId: number, windowId = WINDOW_A) {
  registry.noteGuestNavigationStart(guestId, windowId, "about:blank");
}

describe("originOf", () => {
  it("returns the serialized origin of a web URL", () => {
    expect(originOf("https://provider.example/authorize?a=1#b")).toBe("https://provider.example");
  });

  it("drops the default port, matching how Chromium reports committed URLs", () => {
    expect(originOf("https://provider.example:443/")).toBe("https://provider.example");
    expect(originOf("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
  });

  it("returns null for an opaque origin rather than the string \"null\"", () => {
    expect(originOf("about:blank")).toBeNull();
    expect(originOf("data:text/html,<p>hi")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(originOf("not a url")).toBeNull();
    expect(originOf("")).toBeNull();
  });
});

describe("shouldDeliverPostMessage", () => {
  const sender = "https://opener.example";
  const receiver = "https://provider.example";

  it("delivers a wildcard target to any receiver", () => {
    expect(shouldDeliverPostMessage("*", sender, receiver)).toBe(true);
  });

  it("delivers an exactly matching origin", () => {
    expect(shouldDeliverPostMessage("https://provider.example", sender, receiver)).toBe(true);
  });

  it("accepts a target written as a full URL, comparing origins", () => {
    expect(shouldDeliverPostMessage("https://provider.example/callback", sender, receiver)).toBe(true);
  });

  it("drops a scheme mismatch", () => {
    expect(shouldDeliverPostMessage("http://provider.example", sender, receiver)).toBe(false);
  });

  it("drops a host mismatch, including a confusable suffix", () => {
    expect(shouldDeliverPostMessage("https://provider.example.evil.com", sender, receiver)).toBe(false);
    expect(shouldDeliverPostMessage("https://evilprovider.example", sender, receiver)).toBe(false);
  });

  it("drops a port mismatch", () => {
    expect(shouldDeliverPostMessage("https://provider.example:8443", sender, receiver)).toBe(false);
  });

  it("treats \"/\" as same-origin-as-sender", () => {
    expect(shouldDeliverPostMessage("/", sender, receiver)).toBe(false);
    expect(shouldDeliverPostMessage("/", receiver, receiver)).toBe(true);
  });

  it("drops an unparseable target origin", () => {
    expect(shouldDeliverPostMessage("provider.example", sender, receiver)).toBe(false);
    expect(shouldDeliverPostMessage("", sender, receiver)).toBe(false);
  });
});

describe("WebViewerPopupRegistry — opener side (claimHandle)", () => {
  let harness: ReturnType<typeof makeRegistry>;

  beforeEach(() => {
    harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
  });

  it("hands the requesting guest the handle it just created", () => {
    const pending = harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(harness.registry.claimHandle(10)).toEqual({ handleId: pending.handleId, url: POPUP_URL });
  });

  it("returns null when this guest has no outstanding request", () => {
    expect(harness.registry.claimHandle(10)).toBeNull();
  });

  it("never hands a request to a guest that did not make it", () => {
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(harness.registry.claimHandle(11)).toBeNull();
  });

  it("hands out each request exactly once", () => {
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(harness.registry.claimHandle(10)).not.toBeNull();
    expect(harness.registry.claimHandle(10)).toBeNull();
  });

  it("hands back-to-back requests out in the order they were made", () => {
    const first = harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: "https://a.example/" });
    expect(harness.registry.claimHandle(10)?.handleId).toBe(first.handleId);
    const second = harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: "https://b.example/" });
    expect(harness.registry.claimHandle(10)?.handleId).toBe(second.handleId);
  });

  it("stops handing out a request once it has expired", () => {
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    harness.advance(POPUP_HANDLE_TTL_MS + 1);
    expect(harness.registry.claimHandle(10)).toBeNull();
    expect(harness.registry.pendingCount()).toBe(0);
  });
});

describe("WebViewerPopupRegistry — popup side (noteGuestNavigationStart)", () => {
  it("pairs a guest that attached after the request and navigates to its URL", () => {
    const { registry, pending } = pairedRegistry();
    bootstrap(registry, 20);
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toEqual({
      handleId: pending.handleId,
      openerGuestId: 10,
      popupGuestId: 20,
    });
    expect(registry.claimOpener(20)).toEqual({ hasOpener: true, handleId: pending.handleId });
    expect(registry.pairForPopup(20)).toEqual({
      handleId: pending.handleId,
      openerGuestId: 10,
      popupGuestId: 20,
    });
  });

  it("pairs on the URL the navigation started at, before any redirect", () => {
    // The shape the whole navigation-start rule exists for: the requested URL
    // 302s and never commits a document, so the popup's first document is
    // already somewhere the opener never named.
    const { registry, pending } = pairedRegistry();
    bootstrap(registry, 20);
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);
    // The redirect target arrives as a later navigation; the pairing holds.
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, "https://idp.example/login")).toBeNull();
    expect(registry.claimOpener(20)).toEqual({ hasOpener: true, handleId: pending.handleId });
  });

  it("matches a URL that Chromium reported in canonical form", () => {
    const harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: "https://provider.example:443" });
    harness.registry.noteGuestAttached(20);
    expect(harness.registry.noteGuestNavigationStart(20, WINDOW_A, "https://provider.example/")).not.toBeNull();
  });

  it("consumes the request, so a second guest cannot also claim it", () => {
    const { registry } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);
    registry.noteGuestAttached(21);
    expect(registry.noteGuestNavigationStart(21, WINDOW_A, POPUP_URL)).toBeNull();
    expect(registry.claimOpener(21)).toEqual({ hasOpener: false });
  });

  it("refuses a guest that already existed when the popup was requested", () => {
    const harness = makeRegistry();
    // Attach order is the whole point: guest 20 is an unrelated tab the user
    // already had open on the same URL.
    harness.registry.noteGuestAttached(10);
    harness.registry.noteGuestAttached(20);
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(harness.registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toBeNull();
  });

  it("refuses a guest in a different window", () => {
    const { registry } = pairedRegistry();
    expect(registry.noteGuestNavigationStart(20, WINDOW_B, POPUP_URL)).toBeNull();
  });

  it("refuses a URL the opener never asked for", () => {
    const { registry } = pairedRegistry();
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, "https://elsewhere.example/")).toBeNull();
  });

  it("gives a guest exactly one chance, so a later navigation cannot pair", () => {
    // A tab that went somewhere else first is a tab the user is steering, not
    // a reparented popup — even if it later lands on the requested URL inside
    // the TTL.
    const { registry } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, "https://elsewhere.example/");
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toBeNull();
    expect(registry.claimOpener(20)).toEqual({ hasOpener: false });
  });

  it("does not spend that chance on the about:blank bootstrap", () => {
    const { registry, pending } = pairedRegistry();
    bootstrap(registry, 20);
    bootstrap(registry, 20);
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)?.handleId).toBe(pending.handleId);
  });

  it("refuses the opener itself", () => {
    const harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    // An opener that navigates itself to the URL it just asked for must not
    // become its own popup.
    expect(harness.registry.noteGuestNavigationStart(10, WINDOW_A, POPUP_URL)).toBeNull();
  });

  it("refuses a guest that never attached", () => {
    const harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(harness.registry.noteGuestNavigationStart(99, WINDOW_A, POPUP_URL)).toBeNull();
  });

  it("refuses an expired request", () => {
    const { registry, advance } = pairedRegistry();
    advance(POPUP_HANDLE_TTL_MS + 1);
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toBeNull();
  });

  it("keeps the pairing across navigation, without consuming another request", () => {
    const { registry, pending } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);
    // A second outstanding request from the same opener, to the same URL: the
    // navigating popup must keep reporting its existing pairing rather than
    // eat the new entry.
    const second = registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toBeNull();
    expect(registry.claimOpener(20)).toEqual({ hasOpener: true, handleId: pending.handleId });
    expect(registry.pendingCount()).toBe(1);
    registry.noteGuestAttached(21);
    expect(registry.noteGuestNavigationStart(21, WINDOW_A, POPUP_URL)?.handleId).toBe(second.handleId);
  });

  it("pairs the oldest matching request first when several are outstanding", () => {
    const harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
    const first = harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    harness.registry.noteGuestAttached(20);
    expect(harness.registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)?.handleId).toBe(first.handleId);
  });
});

describe("WebViewerPopupRegistry — popup side (claimOpener)", () => {
  it("is a lookup only: an unpaired guest never becomes paired by asking", () => {
    const { registry } = pairedRegistry();
    expect(registry.claimOpener(20)).toEqual({ hasOpener: false });
    expect(registry.claimOpener(20)).toEqual({ hasOpener: false });
    expect(registry.pendingCount()).toBe(1);
  });

  it("keeps answering for as long as the pairing lives, TTL included", () => {
    const { registry, advance, pending } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);
    // The TTL bounds how long an *unclaimed request* stays claimable, not how
    // long an established pairing lasts — an OAuth flow may sit on a consent
    // screen far longer than that.
    advance(POPUP_HANDLE_TTL_MS * 10);
    expect(registry.claimOpener(20)).toEqual({ hasOpener: true, handleId: pending.handleId });
  });
});

describe("WebViewerPopupRegistry — handle ownership", () => {
  it("resolves a handle only for the guest that owns it", () => {
    const { registry, pending } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);
    expect(registry.pairForOpenerHandle(10, pending.handleId)?.popupGuestId).toBe(20);
    expect(registry.pairForOpenerHandle(20, pending.handleId)).toBeNull();
    expect(registry.pairForOpenerHandle(999, pending.handleId)).toBeNull();
  });

  it("rejects an unknown or non-string handle id", () => {
    const { registry } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);
    expect(registry.pairForOpenerHandle(10, "handle-does-not-exist")).toBeNull();
    expect(registry.pairForOpenerHandle(10, undefined)).toBeNull();
    expect(registry.pairForOpenerHandle(10, { handleId: "handle-1" })).toBeNull();
  });
});

describe("WebViewerPopupRegistry — teardown", () => {
  it("tells the opener when its popup goes away, and forgets the pair", () => {
    const { registry, pending } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);

    const outcome = registry.noteGuestDestroyed(20);
    expect(outcome.popupClosed).toEqual([{ guestId: 10, handleId: pending.handleId }]);
    expect(outcome.openerGone).toEqual([]);
    expect(registry.pairForPopup(20)).toBeNull();
    expect(registry.pairForOpenerHandle(10, pending.handleId)).toBeNull();
  });

  it("tells the popup when its opener goes away, and forgets the pair", () => {
    const { registry, pending } = pairedRegistry();
    registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL);

    const outcome = registry.noteGuestDestroyed(10);
    expect(outcome.openerGone).toEqual([{ guestId: 20, handleId: pending.handleId }]);
    expect(outcome.popupClosed).toEqual([]);
    expect(registry.pairForPopup(20)).toBeNull();
  });

  it("notifies every popup an opener had", () => {
    const harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: "https://a.example/" });
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: "https://b.example/" });
    harness.registry.noteGuestAttached(20);
    harness.registry.noteGuestAttached(21);
    harness.registry.noteGuestNavigationStart(20, WINDOW_A, "https://a.example/");
    harness.registry.noteGuestNavigationStart(21, WINDOW_A, "https://b.example/");

    const outcome = harness.registry.noteGuestDestroyed(10);
    expect(outcome.openerGone.map((entry) => entry.guestId).sort()).toEqual([20, 21]);
  });

  it("drops a dead opener's unclaimed requests so no later guest can claim them", () => {
    const harness = makeRegistry();
    harness.registry.noteGuestAttached(10);
    harness.registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    harness.registry.noteGuestDestroyed(10);
    harness.registry.noteGuestAttached(20);
    expect(harness.registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toBeNull();
    expect(harness.registry.pendingCount()).toBe(0);
  });

  it("is a no-op for a guest that was never involved in a pairing", () => {
    const { registry } = pairedRegistry();
    expect(registry.noteGuestDestroyed(77)).toEqual({ popupClosed: [], openerGone: [] });
  });

  it("frees the attach record, so a recycled guest id cannot inherit a pairing", () => {
    const { registry } = pairedRegistry();
    registry.noteGuestDestroyed(20);
    // Guest 20 is gone; a request made now, then a re-appearance of that id
    // without a fresh attach, must not pair.
    registry.requestPopup({ openerGuestId: 10, windowId: WINDOW_A, url: POPUP_URL });
    expect(registry.noteGuestNavigationStart(20, WINDOW_A, POPUP_URL)).toBeNull();
  });
});
