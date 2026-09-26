# ADR-0022: Extending the popup/opener bridge to Agent Browser guests

**Date:** 2026-09-26
**Status:** Proposed

## Context

ADR-0021 built a popup/opener bridge for the Web Viewer's `persist:webviewer`
`<webview>` guests: main denies every real `window.open()`, reparents the URL
into a new Web Viewer tab, and shims `window.open`/`window.opener` on top of
that deny-and-reparent so the OAuth-popup handshake
(`window.opener.postMessage(token, origin)`) keeps working. Read ADR-0021 in
full before this one — everything below assumes its mechanism, its
"main decides, main never trusts the guest" posture, and its documented
limitations, and does not re-explain them.

A second guest kind now needs the same handshake. The Claude Threads plugin
(a separate repo, `rbcodelabs/agent-threads`, out of scope for this ADR) runs
autonomous "Agent Browser" sessions in `<webview>` guests on their own
partition, `persist:agent-browser`. An agent driving a page toward a login
form hits exactly the popup-based OAuth flow ADR-0021 solved for human users —
but today it cannot work at all in that partition, for two independent
reasons:

1. **No preload runs there.** `will-attach-webview` in `src/main/main.ts` only
   forces safe `webPreferences` and installs `webviewer-bridge-preload.js`
   when `params.partition === WEBVIEWER_PARTITION`. Any other partition,
   including `persist:agent-browser`, attaches with whatever the `<webview>`
   tag itself asked for — no popup shim, and (see `AgentBrowserGuest.ts`'s own
   comment) that is deliberate: Geode's *general* event bridge
   (`window.__geode.postEvent`) must never reach an agent-driven,
   attacker-navigable page.
2. **Popups are blocked before any handler runs.** `AgentBrowserGuest.ts` sets
   `GUEST_WEBPREFERENCES` on the tag directly and does not set the `allowpopups`
   attribute (`web-view.ts` sets it for the Web Viewer's own tag, at line 210,
   as a plain HTML attribute — a decision distinct from `webPreferences`).
   Without it, Chromium's `<webview>` popup blocking rejects `window.open()`
   before `setWindowOpenHandler` is even invoked, so today's Agent Browser
   guests cannot produce a popup event at all, shimmed or not.

Threads intends to build an interactive login-handoff UI (take control, sign
in, hand control back) on top of whatever primitives Geode exposes for a
denied Agent Browser popup. That UI is not built yet and is not this repo's
concern. What Geode owes it is the same thing ADR-0021 gave the Web Viewer:
deny safely, tell someone what was requested, and make the pairing/relay/
focus/close primitives actually work once a guest attaches to stand in for
the request — without Geode inventing any Agent-Browser-specific UI of its
own, and without ever handing an adversarial page the general event bridge.

## Decision

Extend the existing mechanism to a second, fully independent guest kind,
rather than generalizing `persist:webviewer` to cover both. Five sub-decisions,
in the order the open questions were posed:

### 1. Preload strategy: factor the shim into a shared module

`webviewer-bridge-preload.ts` today does two unrelated things: lines 1–26
install the general bridge (`window.__geode.postEvent`), and lines 28–215 are
the popup/opener shim, which depends only on the channel constants in
`webviewer-popups.ts` — nothing in it name-checks "Web Viewer" or needs the
general bridge to exist first.

Pull lines 28–215 out into a new module, **`src/main/popup-opener-shim.ts`**,
exporting one function, `installPopupOpenerShim()`, containing exactly what
those lines already do (the `__geodePopupsInternal` contextBridge object, the
`MAIN_WORLD_SHIM` source string, and the `webFrame.executeJavaScript` call).
Both preloads then call it:

- `webviewer-bridge-preload.ts` keeps the `window.__geode.postEvent` bridge
  and adds one line, `installPopupOpenerShim()`.
- A new, deliberately minimal **`src/main/agent-browser-bridge-preload.ts`**
  calls `installPopupOpenerShim()` and does *nothing else* — no
  `contextBridge.exposeInMainWorld("__geode", …)`, ever. That omission is the
  entire security property `AGENT_BROWSER_PARTITION`'s comment asks for, and
  it is enforced by the file simply not containing the code, not by a runtime
  check.

Rejected: a second preload that duplicates the shim body (drifts the instant
one copy is patched and not the other), and a single preload with a
runtime `if (partition === …)` branch around the `__geode` bridge (the
branch condition would itself become an attacker-relevant fact to get right,
where "the code for it doesn't exist in this bundle" cannot be gotten wrong).

Needs a new `esbuild.config.mjs` entry, the same shape as the existing
`webviewer-bridge-preload.ts` entry (`platform: "node"`, `format: "cjs"`,
`external: ["electron"]`), emitting `dist/agent-browser-bridge-preload.js`.

### 2. Reparenting semantics: deny, emit a named event, leave the consumer to Threads

Web Viewer's handler denies and reparents into a Geode-owned tab because
Geode owns Web Viewer tabs. Geode does not own Agent Browser guests —
`agentBrowserHost.ts` makes that structural: they live in an off-screen
container appended straight to `document.body`, entirely outside the
workspace/tab system `app.ts` manages. So "reparent into a tab" has no
equivalent to reparent *into* here, and inventing one (a hidden Geode-owned
tab, a modal, anything UI-shaped) would be Geode building a feature it has no
product reason to own — the login-handoff UI is explicitly Threads' to build.

The smallest correct move: deny, and tell whoever is listening what was
denied. `did-attach-webview`'s window-open handler gets a second branch,
parallel to the existing Web Viewer one — when the denying guest is an Agent
Browser guest, main records a pending popup exactly as it does for Web
Viewer (`requestPopup`, on the Agent Browser registry — see §3) and sends a
new IPC message, **`agent-browser-window-open`**, to `win.webContents`, shaped
like the existing `GuestWindowOpenRequest` (`{ url, guestId, disposition }`).
Nothing in this repo consumes it yet; that is correct, not incomplete —
Threads does not have a consumer today, and building one is out of scope
here.

What matters is that this alone is enough for the *primitives* to work
end-to-end the moment Threads (or a test) attaches any Agent Browser guest to
that URL in that window, regardless of who or what triggered the attach:
`noteGuestNavigationStart` pairs on window + URL + attach-order, not on
"was this guest created in response to my event." A guest the pool admits for
an unrelated reason, that happens to navigate to a URL nobody requested,
simply finds no pending entry and pairs with nothing — the same
already-proven-safe behavior Web Viewer relies on for every ordinary
navigation. Threads' eventual login-handoff UI is then just: listen for
`agent-browser-window-open`, decide whether/how to show the user a guest at
that URL, and however it does that, `window.opener` will already work in it.

The default branch (artifact guests, canvas-preview guests) is unchanged:
they keep the existing unconditional `guest-window-open` + reparent-into-tab
behavior. Nothing about this ADR touches that.

### 3. Registry reuse: two independent instances, not one shared one

`WebViewerPopupRegistry` keys pairing on `windowId`, not on partition —
there was only ever one guest kind attaching to a given `BrowserWindow`
before now. That stops being true the moment Agent Browser guests exist:
they are hosted inside the *same* `BrowserWindow` as Web Viewer tabs (one
off-screen container in the same renderer document), so `windowId` provides
**zero** separation between the two guest kinds. Concretely, with one shared
registry: a Web Viewer guest opens `window.open(url)` in window 1
(`requestPopup` logs `{openerGuestId, windowId: 1, url}`); if any Agent
Browser guest in that same window later starts navigating to that same `url`
within the 30s TTL — coincidentally, or because both features commonly hit
the same OAuth callback path — `noteGuestNavigationStart`'s matching rules
(same window, same URL, attached-after, first-real-navigation) are satisfied
regardless of guest kind, and the shim would hand an attacker-navigable,
agent-driven page a live `window.opener` onto the user's Web Viewer tab (and
vice versa: the user's tab could `focus()`/read `closed` on the agent's
guest). That is a cross-security-domain leak the registry's own rules cannot
prevent, because nothing about them is partition-aware.

Decision: instantiate `WebViewerPopupRegistry` **twice** — the existing
`webViewerPopups` for `persist:webviewer`, and a new `agentBrowserPopups` for
`persist:agent-browser` — with independent guest-lookup maps
(`webViewerGuests` stays; add `agentBrowserGuests`) so `deliverPopupMessage`/
`notifyPopupGuest`'s send target can never resolve into the other partition
either. This makes cross-pairing structurally impossible rather than
heuristically unlikely, which is the same bar ADR-0021 already holds itself
to elsewhere (e.g. `windowId`-scoped pairing itself, before this ADR).

Reusing the *class* (and its channel constants) for both is safe and correct,
not just convenient: every handler in `trackWebViewerPopupGuest` is
registered on `guest.ipc` — a WebContents-scoped `IpcMain` — so an Agent
Browser guest's messages on `POPUP_CLAIM_HANDLE_CHANNEL` etc. only ever reach
the listeners `trackAgentBrowserPopupGuest` (§ implementation notes)
registers on *that* guest's own `guest.ipc`, never the Web Viewer guest's.
Channel-name reuse across partitions introduces no cross-talk; only sharing
the *registry instance* would have.

`webviewer-popups.ts` itself needs no code changes — its rules never
referenced "Web Viewer" beyond prose; `guestId`/`windowId`/`url` are already
opaque to it. Its top-of-file comment should be loosened to describe being
instantiated once per guest kind rather than assuming Web Viewer specifically
(a docs-only touch-up, not a rename — renaming a heavily cross-referenced,
already-correct class is exactly the complexity this ADR should not add).

### 4. `will-attach-webview` floor (Gap G3)

Add an `else if (params.partition === AGENT_BROWSER_PARTITION)` branch beside
the existing `WEBVIEWER_PARTITION` one, forcing the same fields
`artifact-runtime.ts`'s `secureWebviewAttachment` and the Web Viewer branch
already force: `nodeIntegration = false`, `nodeIntegrationInSubFrames = false`,
`contextIsolation = true`, `sandbox = true`, `webSecurity = true`,
`allowRunningInsecureContent = false`, and
`preload = agent-browser-bridge-preload.js`. This is exactly Gap G3 as the
plugin's own comment describes it: today that partition "attaches with
whatever the element asks for," and `AgentBrowserGuest.ts` says plainly that
a host-side floor, not the tag, should be the enforcement point.

This composes cleanly with what the tag already sets. `will-attach-webview`
mutates the parsed `webPreferences` object; anything this new branch does not
touch is left exactly as the tag requested. In particular
**`backgroundThrottling` is deliberately not touched** — `AgentBrowserGuest.ts`
sets `backgroundThrottling=no` on the tag for a real, load-bearing reason (an
occlusion-throttled off-screen guest looks exactly like a hung page), and
since neither this branch nor the Web Viewer branch it mirrors mentions that
field, it survives untouched. The new branch only forces the same
security-relevant subset the Web Viewer branch already forces — no more.

**`allowpopups` is explicitly out of scope for this branch and stays the
plugin's responsibility**, mirroring how `web-view.ts:210` sets it for its
own tag (`webview.setAttribute("allowpopups", "")`) rather than main forcing
it via `will-attach-webview`. `params` in that handler is read-only in this
codebase today — `secureWebviewAttachment` only ever mutates `webPreferences`,
never `params` — and `allowpopups` is a tag attribute, not a `webPreferences`
field. This has a real consequence, called out plainly rather than papered
over: **until the Threads plugin adds `allowpopups` to its `<webview>` tag,
`window.open()` inside an Agent Browser guest stays fully blocked before
Geode's `setWindowOpenHandler` ever runs**, and nothing in this ADR changes
that. That is a Threads-side follow-up, not a gap in this design — it lives
in the other repo, but it is the one external prerequisite this whole bridge
needs to actually activate, and it should be flagged to whoever picks up the
Threads-side consumer.

### 5. What ships now vs. deferred

Ships in this change: the shared shim module, the slim Agent Browser
preload, the second registry instance and its guest map, the
`will-attach-webview` floor, and the `agent-browser-window-open` /
`agent-browser-window-close` / `agent-browser-window-focus` IPC primitives —
wired end-to-end so that any guest attaching on `persist:agent-browser` and
navigating to a previously-denied URL gets a working `window.opener` shim,
exactly as a Web Viewer popup does today.

Explicitly deferred, inheriting ADR-0021's own limitations list rather than
re-litigating them: no same-origin `opener` access, no transferables, no
subframe coverage, `close()` remains one-way, the internal bridge global
stays visible to the page, and the residual "a same-URL guest attaching
within the TTL can claim a pairing" heuristic — now scoped separately per
partition instead of one shared occurrence. Also explicitly deferred: any
Threads-side consumer of the three new IPC events (not this repo's code to
write), per-thread partition isolation (there is one shared
`persist:agent-browser` cookie jar across all threads today, unchanged by
this ADR), and the `allowpopups` tag change described in §4, which belongs to
`agent-threads`.

One dependency this ADR does **not** inherit from ADR-0021: the "hard
dependency on mounted background tabs" (`TabGroup.revealActiveLeaf` keeping
inactive leaves attached) does not apply here. Agent Browser guests are
never detached in the first place — `agentBrowserHost.ts` parks them
off-screen in a container appended directly to `document.body` and keeps
them mounted permanently, specifically so a tab switch elsewhere in Geode
can never destroy one. Noted here as a simplification this guest kind gets
for free, not a risk it inherits.

## Limitations

All of ADR-0021's limitations apply unchanged to Agent Browser guests (no
same-origin access, no transferables, no subframe coverage, one-way `close()`,
a visible-but-re-validated internal bridge global, and the residual
same-URL/TTL pairing heuristic — now bounded to within one partition instead
of shared across both). Additionally, specific to this extension:

- **Inert until Threads sets `allowpopups`.** Everything in this ADR is
  necessary but not sufficient: without the tag-level `allowpopups` change in
  `agent-threads`, no Agent Browser `window.open()` ever reaches
  `setWindowOpenHandler`, so none of this fires. See §4.
- **No consumer for the new IPC events.** `agent-browser-window-open/close/
  focus` are primitives with no listener anywhere in this repo or in
  `agent-threads` today. They are inert wiring until Threads' login-handoff
  UI is built.
- **One shared `persist:agent-browser` cookie jar.** As today, unchanged —
  this ADR keeps `persist:agent-browser` and `persist:webviewer` fully
  separate from each other, but does not introduce per-thread isolation
  within the Agent Browser partition itself.

## Options considered

| Option | Pros | Cons |
| --- | --- | --- |
| Do nothing; Agent Browser popups stay fully broken | No work | Threads cannot build any OAuth-style login handoff at all |
| Generalize `persist:webviewer`'s existing code path to branch internally, without a shared shim module (duplicate the shim body in a second preload) | Fewer new files | The 190-line main-world shim drifts the moment one copy is patched and not the other; the exact bug class ADR-0021's own comments warn about elsewhere |
| One shared `WebViewerPopupRegistry` instance across both partitions | Less bookkeeping, one map instead of two | Structurally allows cross-partition pairing (see §3) — a real, not theoretical, security leak given both guest kinds share one `BrowserWindow` |
| Geode builds its own Agent-Browser popup UI (a hidden tab, a modal) instead of emitting an event | Fully self-contained, no dependency on Threads shipping a consumer | Geode does not own Agent Browser guests or their UI; this duplicates work Threads is already scoped to build, and invents UI Geode has no product reason to own |
| Shared shim module + two independent registries + deny-and-emit-a-named-event (**chosen**) | Matches ADR-0021's proven mechanism exactly; guest never trusted; pairing cannot cross security domains by construction; Threads gets working primitives without Geode building UI it doesn't own | `allowpopups` and the consumer UI are both real prerequisites this ADR cannot satisfy alone, and must be flagged as follow-up in the other repo |

## Implementation notes (seeds the engineering task; not authoritative code)

**New files**

- `src/main/popup-opener-shim.ts` — `installPopupOpenerShim()`, extracted
  verbatim from `webviewer-bridge-preload.ts` lines 28–215 (the
  `__geodePopupsInternal` contextBridge object, `MAIN_WORLD_SHIM`, and the
  `webFrame.executeJavaScript` call). No behavior change, pure extraction.
- `src/main/agent-browser-bridge-preload.ts` — imports and calls
  `installPopupOpenerShim()`. Nothing else. No `contextBridge.exposeInMainWorld("__geode", …)`.

**Modified files**

- `src/main/webviewer-bridge-preload.ts` — keep lines 1–26 (`__geode.postEvent`)
  unchanged; replace lines 28–215 with an import of and call to
  `installPopupOpenerShim()`.
- `esbuild.config.mjs` — add a build entry for
  `src/main/agent-browser-bridge-preload.ts` → `dist/agent-browser-bridge-preload.js`,
  matching the existing `webviewer-bridge-preload.ts` entry's shape
  (`platform: "node"`, `format: "cjs"`, `external: ["electron"]`).
- `src/main/main.ts`:
  - Add `const AGENT_BROWSER_PARTITION = "persist:agent-browser";` next to
    `WEBVIEWER_PARTITION` (independent literal, same pattern — Geode cannot
    import the plugin's own constant across repos, exactly as
    `WEBVIEWER_PARTITION` is already an independent literal kept in sync with
    `web-view.ts`'s `setAttribute("partition", …)` by convention/comment, not
    by import).
  - Add `isAgentBrowserGuest()`, mirroring `isWebViewerGuest()`
    (exact-instance check against `session.fromPartition(AGENT_BROWSER_PARTITION)`).
  - Add `const agentBrowserGuests = new Map<number, Electron.WebContents>();`
    and `const agentBrowserPopups = new WebViewerPopupRegistry({ newHandleId: randomUUID });`
    beside the existing `webViewerGuests`/`webViewerPopups`.
  - Generalize `deliverPopupMessage`/`notifyPopupGuest` to take the guest map
    and registry as parameters (or duplicate them once, scoped, the way
    `trackWebViewerPopupGuest` itself will be duplicated below) — either is
    fine; the point is the send-target lookup must go through
    `agentBrowserGuests`, never `webViewerGuests`, for Agent Browser messages.
  - Add `trackAgentBrowserPopupGuest(win, guest)`, structurally mirroring
    `trackWebViewerPopupGuest` but gated on `isAgentBrowserGuest`, wired to
    `agentBrowserPopups`/`agentBrowserGuests`, and sending
    `agent-browser-window-close`/`agent-browser-window-focus` (new channel
    names, not the existing `guest-window-close`/`guest-window-focus` —
    those are consumed by `app.ts`'s tab-owning logic, which has no notion of
    an Agent Browser guest).
  - In the `will-attach-webview` handler, add the `AGENT_BROWSER_PARTITION`
    branch described in §4.
  - In `did-attach-webview`: call `trackAgentBrowserPopupGuest(win, guest)`
    alongside the existing `trackWebViewerPopupGuest(win, guest)` call; and in
    `setWindowOpenHandler`, add an `isAgentBrowserGuest(guest)` branch that
    calls `agentBrowserPopups.requestPopup(...)` and sends
    `"agent-browser-window-open"` instead of `"guest-window-open"` — leaving
    the existing `isWebViewerGuest` branch and the unconditional
    artifact/canvas-preview default path exactly as they are today.
- `src/main/preload.ts` — optionally add `onAgentBrowserWindowOpen` (mirroring
  `onGuestWindowOpen`, ~line 308) for API discoverability. Not strictly
  required: the host window runs with `nodeIntegration: true` /
  `contextIsolation: false`, so a plugin can listen on
  `ipcRenderer.on("agent-browser-window-open", …)` directly without a
  preload-exposed wrapper. Recommended anyway, for symmetry with the existing
  `onGuestWindowOpen`/`GuestWindowOpenRequest` surface plugin authors already
  read as the documented pattern.
- `src/main/webviewer-popups.ts` — no code changes. Optional: loosen the
  top-of-file doc comment to describe being instantiated once per guest kind
  (see §3), rather than assuming Web Viewer specifically.

**New/updated tests**

- `tests/unit/webviewer-popups.test.ts` needs no changes to exercise the
  class itself — it already tests the pure registry with arbitrary
  `windowId`/`guestId` values, and a second instance is just a second
  `new WebViewerPopupRegistry(...)` call with its own state. Worth adding one
  explicit test asserting that two independently constructed registries never
  share pending/paired state, as a regression guard for the §3 decision
  itself (cheap to write, and it is the one property this ADR most depends
  on).
- A `will-attach-webview`/`did-attach-webview` integration test (E2E or a
  main-process unit harness, whichever this repo's existing coverage for the
  Web Viewer branch uses) asserting: (a) an `AGENT_BROWSER_PARTITION` guest
  gets the forced `webPreferences` floor and the new preload path; (b) a
  denied popup in that partition emits `agent-browser-window-open`, not
  `guest-window-open`; (c) a Web Viewer popup request and a same-URL,
  same-window Agent Browser guest attach never pair with each other.
