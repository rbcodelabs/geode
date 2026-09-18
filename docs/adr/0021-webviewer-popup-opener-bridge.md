# ADR-0021: Web Viewer popup/opener bridge

**Date:** 2026-09-18
**Status:** Accepted

## Context

Geode hosts web pages in Electron `<webview>` guests on the
`persist:webviewer` partition. `src/main/main.ts`'s `did-attach-webview`
handler installs a `setWindowOpenHandler` that always returns
`{ action: "deny" }` and instead IPC-sends `guest-window-open` to the host
renderer, which opens a brand-new Web Viewer tab at the same URL
(`openGuestWindowInTab` in `src/renderer/app.ts`).

The reparented tab is an unrelated browsing context that merely shares a URL,
so three web-platform guarantees were absent:

- `window.open(...)` returned `null` in the opener, so
  `const w = window.open(url); w.postMessage(...)` threw immediately.
- `window.opener` was `null` in the popup, so
  `window.opener.postMessage(token, origin)` — the classic OAuth popup
  handshake — silently did nothing.
- `window.close()` from the popup did not close the Geode tab.

Making these real would mean hosting tabs in `WebContentsView` rather than
`<webview>`, which is a much larger migration. This ADR records *shimming* the
opener relationship on top of deny-and-reparent instead.

## Prerequisite, now met

This bridge was first attempted while `LeafContainer.setActiveLeaf` activated a
tab with `contentHostEl.innerHTML = ""`, detaching the outgoing leaf's element.
Electron destroys a `<webview>` guest the instant its element leaves the
document. Measured then, opening tab A, then tab B, then returning to A:

| Step | Guests in the document | Guest WebContents id |
| --- | --- | --- |
| tab A active | `[/a]` | 2 |
| tab B active | `[/b]` | 3 |
| back to tab A | `[/a]` | **4** |

Returning to A produced a *new* guest and page state set before the switch was
gone — every Web Viewer tab silently reloaded whenever the user looked at
another tab. For this bridge that was fatal rather than merely wasteful: a
`window.open` produces `disposition: "foreground-tab"`, so activating the popup
tab destroyed the opening page — handle, listeners and all. It also crashed the
app outright, because the opener guest was torn down while blocked in the
synchronous claim that `window.open` requires:

```
DBG requestPopup http://…/popup from 2 disp=foreground-tab
DBG claim-handle in          <- never returns
DBG guest destroyed 2        <- tab activation destroys the opener mid-call
… Electron exits, window closed
```

`TabGroup.revealActiveLeaf` now keeps every revealed leaf mounted in
`contentHostEl` and hides inactive ones with CSS, so guest ids are stable
across tab switches and page state survives. Re-measured against that change,
the opener guest keeps id 2 while the popup attaches as id 3, both alive
simultaneously, and the opening page's JS state survives the popup opening.
That is what makes this bridge possible, and it is a hard dependency:
**anything that returns to unmounting inactive leaves breaks this bridge, not
just its performance.**

## Decision

Shim the opener relationship on top of deny-and-reparent. Keep deny-and-
reparent itself: every hosted page stays in a tab the user can see and close,
and no `<webview>` → `WebContentsView` migration is required.

**Pairing is decided in main and never trusted from the guest**, the same
posture as `trackWebViewerBridgeGuest`. The pure state machine lives in
`src/main/webviewer-popups.ts` — no Electron imports, no I/O, so the
security-relevant rules are directly unit-testable — and every Electron-facing
side effect lives in `main.ts`.

- The window-open handler records a pending request (`handleId`,
  `openerGuestId`, `windowId`, `url`, `createdAt`, attach watermark) *before*
  the renderer is told to open a tab.
- The opener claims it synchronously and single-use. No match means the shim
  returns the native `window.open` result unchanged, so non-http schemes,
  `_self` navigations and genuinely blocked popups behave exactly as before.
- **Pairing happens at the popup guest's first navigation start**, from
  `did-start-navigation` on the guest — never at document commit, and never
  when the page asks. The URL a navigation *starts* at is the URL that was
  requested; the URL it *commits* at is wherever the server sent it.
  `window.open('/auth/start')` where `/auth/start` 302s straight to an identity
  provider never commits a document at the requested URL at all, and that is
  the single most common real shape of this feature. A pending entry matches
  only on same window, same URL, within a 30s TTL, **the guest attached after
  the request was recorded** — which is what stops a pre-existing tab from
  stealing a pairing — and **that guest's first navigation with a real
  origin**, so a tab the user later steers onto the URL cannot claim it either.
  Every `<webview>` boots on `about:blank` first (`BOOTSTRAP_URL` in
  src/renderer/views/web-view.ts); an opaque origin is skipped without spending
  that one chance, or the bootstrap would consume it and nothing would ever
  pair.
- The popup asks "am I paired?" on every navigation, with no arguments and no
  URL — main answers from the guest id it read off `event.sender`. So an OAuth
  popup moving to a consent page keeps its `window.opener`, re-asking cannot
  consume a pending entry, and the page contributes nothing to the decision.
- Relay enforces `targetOrigin` with browser semantics (`*`, `/`, exact origin)
  against origins main derives itself, dropping mismatches silently — telling
  the sender would leak where the receiver has navigated.
- Teardown is two-way: a closed popup flips its opener's `handle.closed`; a
  closed opener nulls the popup's `window.opener`, as a real browser does.

**The shim is injected into the page's main world, not exposed through
contextBridge.** Measured on Electron 42 with `sandbox: true` /
`contextIsolation: true`:

- `contextBridge.exposeInMainWorld("opener", …)` throws *"Cannot bind an API on
  top of an existing property on the window object"*. `window.open` is likewise
  already defined.
- `webFrame.executeJavaScript` from a sandboxed preload evaluates in the main
  world, and lands before the page's own inline `<script>` tags run. That
  ordering is what lets `window.opener` exist for a page that reads it at parse
  time, and the E2E asserts it via a top-of-body inline script.
- From the main world, `window.open` can be overridden and `window.opener`
  redefined.
- `Object.defineProperty(messageEvent, "source", { value })` shadows the
  prototype getter, which is how `event.source === popupRef` and
  `event.source === window.opener` are made to pass — `MessageEvent`'s
  initializer only accepts a real `Window`/`MessagePort`.

`window.opener` is defined **only** when main reports the guest is paired.
Sites branch on `if (window.opener)` to detect popup-ness, so defining it on
every Web Viewer tab would be a real behavior regression; there is an E2E for
exactly that.

Separately, the `<webview>` `close` DOM event now detaches the leaf
(`src/renderer/views/web-view.ts`), so `window.close()` closes the tab. That
handling is unconditional, and knowingly more permissive than Chromium, which
ignores `window.close()` on a window script did not open. Deny-and-reparent
leaves no record of which tabs were script-opened, so there is nothing to gate
on; honoring every `window.close()` keeps self-closing pages working at the
cost of letting a page close a tab the user opened — visible and recoverable,
unlike the alternative of a permanently dead-looking tab.

## Limitations

- **No same-origin opener access.** Only the cross-origin `WindowProxy` surface
  (`postMessage`, `close`, `closed`, `focus`, `blur`) is offered.
  `opener.document` and arbitrary property reads have nothing real behind them
  — the two pages are separate, unrelated browsing contexts — and a fake would
  be worse than an honest absence.
- **No transferables.** The relay structured-clones through IPC;
  `MessagePort` and other transferables are not supported.
- **No subframe coverage.** Guest preloads do not run in subframes by default,
  so a popup opened from an iframe gets no shim.
- **`close()` is one-way.** A popup may `focus()` its opener but not close it,
  matching Chromium's refusal to let script close a window it did not open.
  `blur()` is a no-op: Geode tabs have no "send to back".
- **The internal bridge global stays visible to the page.** contextBridge
  installs properties `{ configurable: false, writable: false }`, measured on
  Electron 42 — `delete` returns `false` and `Object.defineProperty` throws
  *"Cannot redefine property"* — so the shim cannot hide
  `window.__geodePopupsInternal` after capturing it. This is not fought: main
  re-validates every call against `event.sender`/`event.senderFrame`, so the
  object grants a page nothing it could not already do. It does mean the
  surface must stay narrow, and that a page can fingerprint Geode by sniffing
  for it (as it already can via `window.__geode`).
- **Residual pairing heuristic.** A brand-new Web Viewer tab opened by the user
  to the exact same URL, in the same window, within the TTL, could claim a
  pairing meant for the reparented guest — its *first* navigation matches every
  rule. Bounded — such a tab is already on that origin, the relay still stamps
  the true sender origin, and receivers are required to validate `event.origin`
  regardless — but it is a heuristic, not a proof. Closing it properly means
  having the host renderer (trusted code, unlike the guest) report which guest
  id it created for a given request. There is an E2E that exercises exactly
  this tab (as the control in the cross-window isolation test), so the day the
  renderer starts reporting guest ids, that assertion is where the change
  surfaces.
- **Hard dependency on mounted background tabs**, as above.

## Options considered

| Option | Pros | Cons |
| --- | --- | --- |
| Leave `window.open`/`window.opener` broken | No work | OAuth popup handshake — the most common cross-window pattern on the web — cannot work in the Web Viewer |
| Migrate tab hosting to `WebContentsView` | Real popups, real opener, no shim, no heuristic | Much larger migration; replaces the whole tab-hosting mechanism |
| Let the guest report its own opener | Trivial pairing | The guest is untrusted; a page could claim any pairing it liked |
| Shim it, with pairing decided in main (**chosen**) | Works today, keeps deny-and-reparent, guest never trusted, pure rules unit-testable | Cross-origin surface only; one documented pairing heuristic |
