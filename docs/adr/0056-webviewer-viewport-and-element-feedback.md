# ADR 0056 — Web Viewer Viewport Presets and Element Pick-to-Thread Feedback

Status: Accepted
Date: 2026-11-15
Compass: SOL-33 / TASK-48
Builds on [ADR 0021](0021-webviewer-popup-bridge.md) and [ADR 0022](0022-agent-browser-popup-bridge.md)
(`persist:webviewer` guest isolation and preload boundaries).

## Context

Users previewing local dev servers (`localhost`, `127.0.0.1`, `[::1]`) and remote staging/preview URLs inside
Geode's built-in Web Viewer need two capabilities already familiar from Artifact Preview:

1. **Responsive viewport presets** (`Fill`, `Desktop 1440×900`, `Tablet 768×1024`, `Mobile 390×844`) so layout
   breakpoints can be inspected inside a single tab while keeping `{ url }` state compatibility with Obsidian's
   `webviewer` leaf state.
2. **Element pick-to-thread feedback** (Phase 1: single-shot Pick + Send / Queue, no persistent pins) routed to
   a user-chosen Claude Threads conversation (or `+ New thread`) without exposing host globals to untrusted web
   pages or coupling Web Viewer pages to `ArtifactRegistration`.

Unlike static artifacts, Web Viewer tabs navigate across arbitrary HTTP(S) origins, carry cookies in
`persist:webviewer`, and already run `webviewer-bridge-preload.js` via `<webview>` `webPreferences.preload`.

## Decision

### 1. Session-level frame preload on `persist:webviewer` alongside `webviewer-bridge-preload.js`

After `app.whenReady()`, the main process registers `dist/artifact-inspector-preload.js` on
`session.fromPartition("persist:webviewer")` via `registerPreloadScript({ type: "frame", filePath })` (guarded by
`fs.existsSync(filePath)`).

- **Additive, not a replacement:** Electron's `webPreferences.preload` on the `<webview>` tag continues to load
  `webviewer-bridge-preload.js` (`window.__geode.postEvent` + popup/opener shim) unchanged. Session-registered
  frame preloads execute in addition to `webPreferences.preload`.
- **Zero guest surface:** `artifact-inspector-preload.js` runs in Chromium's isolated preload world (`sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`), exposes zero `window` globals or `contextBridge` APIs,
  ignores synthetic DOM events (`event.isTrusted === false`), self-gates to `window === window.top`, and remains
  inert while `mode === "off"`.
- **Strict partition scoping:** Neither `persist:canvas-preview` nor `persist:agent-browser` receives the
  inspector preload.

### 2. Host-verified `committedHealthyUrl` (Origin-E page identity)

A guest page must never supply or influence the URL or origin attributed to an element selection. `WebView`
tracks a host-owned `committedHealthyUrl: string | null` state machine:

- Starts `null` while the neutral `about:blank` bootstrap guest initializes.
- Set **only** on main-frame `did-navigate` and `did-navigate-in-page` when `parseHttpPageUrl(event.url)`
  succeeds (`http:` or `https:` scheme, non-opaque RFC 6454 `origin`, `<= 2048` UTF-16 units). Non-HTTP(S)
  documents (`about:blank`, `file:`, `data:`) leave `committedHealthyUrl = null`, hiding and disabling Pick.
- Cleared immediately to `null` (automatically exiting any active Pick or open `PickPopover`) on cross-document
  main-frame `did-start-navigation` (`!isInPlace`), main-frame `did-fail-load` (`errorCode !== -3`), and guest
  termination (`render-process-gone` / `crashed`).
- Re-verified at both **select** time and **submit** time against live `webview.getURL()`:
  - If the page navigated to `null` or a different `origin` before Send, `WebViewerInspectorBridge.submit(...)`
    rejects locally with `reason: "unavailable"` (`"The page navigated before feedback was sent. Pick the element again."`)
    before calling any plugin handler.
  - If `target.url !== selectedUrl` within the same origin (in-page SPA route/hash navigation), or if
    `documentGeneration` or the selected element's layout mutated between pick and send, `request.stale` is set
    to `true`.

### 3. Prominent external-origin indicator in `PickPopover`

Because `persist:webviewer` can browse authenticated third-party sites as well as local dev servers, the user
must see clearly which origin's DOM snippet and cropped screenshot will be sent to the agent thread:

- `PickPopover` renders a host-verified origin header row (`[data-testid="pick-popover-origin-row"]`) via
  `textContent` (`[data-testid="pick-popover-origin"]`).
- Whenever `!isLoopbackOrigin(origin)` — i.e., the hostname is anything other than `localhost`, `127.0.0.1`,
  `[::1]`, or `::1` over `http:`/`https:` — `PickPopover` displays a prominent `"External origin"` badge
  (`[data-testid="pick-popover-external-origin"]`).

### 4. Dedicated `app.webViewerFeedback` contract and fault-isolated `WebViewerFeedbackService`

Web Viewer feedback uses a dedicated contract (`src/web-viewer/feedback-contract.ts`, contract version `1`,
vendored byte-for-byte in `agent-threads`) rather than overloading `app.artifactFeedback`:

- **Target & routing:** `WebViewerPageTarget` (`{ url, origin, title }`) replaces `ArtifactFeedbackTarget`, and
  each `WebViewerFeedbackRequest` carries an explicit destination `threadId` (either a thread ID returned by
  `handler.listThreads` or `WEB_VIEWER_NEW_THREAD_ID = "__new__"`).
- **Capability separation:** `app.webViewerFeedback` exposes only `{ contractVersions, has, onDidChange }`
  (frozen); registration goes exclusively through `Plugin.registerWebViewerFeedbackHandler(handler)`, which
  stamps `{ pluginId, displayName }` from the plugin manifest and disposes on plugin unload. Mobile hosts pass
  `enabled: false` (`host.capabilities.embeddedWebContent === false`) with zero Electron/Node imports in the
  renderer bundle.
- **Fault isolation (never quarantines the plugin):** `canHandle`, `listThreads` (`5_000 ms` timeout), and
  `submit` (`15_000 ms` timeout) are wrapped in `try/catch` + `Promise.resolve` + `AbortController` +
  `console.warn` and are deliberately **not** wrapped in `Plugin.guard()` / `errorHandler`.
- **Hostile-return hardening:** `listThreads` rebuilds thread options strictly from own data descriptors
  (`Object.getOwnPropertyDescriptor` checking `"value" in desc` so getter traps never execute), strips C0/DEL
  and Unicode bidi control characters (`\u202a-\u202e`, `\u2066-\u2069`, `\u061c`, `\u200e`, `\u200f`), filters
  reserved `"__new__"`, empty `id`/`title`, and duplicate `id`s, caps the list at 50 threads, and freezes the
  result. `submit` deep-freezes requests and passes a fresh `screenshot.bytes.slice()` copy per attempt so
  buffer mutation or transfer cannot corrupt retries.
