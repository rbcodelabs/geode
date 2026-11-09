# ADR 0006: Artifact element inspector (host-owned preload) and the plugin feedback contract

Status: Proposed. Extends ADR 0004 (artifact sandbox). Consistent with ADR 0005:
Next.js (`nextjs`) artifacts get no inspector in this ADR; an inspector on the
loopback origin needs its own amendment to ADR 0005 (planned, not decided here).

Scope: Phase 1 of the Threads Design "element picker + comment-to-thread"
feature, static artifacts only. Pins, the comment rail, batching, direct text
edit, structured-context delivery and `nextjs` support are out of scope.

Note on numbering: `docs/adr/` already contains `0006-contextual-document-actions.md`
(the directory has several duplicate numbers). This file keeps the number 0006 because
the feature spec, the Compass solution and the plugin contract all cite "ADR 0006".

## Context

Users want to point at an element in a rendered artifact, type a comment, and have
the agent in the artifact's thread receive a precise reference to that element.
Today the artifact view has no path from the guest DOM back to anything else.

Constraints that shape the design:

- The guest page is untrusted (ADR 0004). It is agent-written and may be prompt
  injected. It must not be able to forge, observe, or suppress a selection, and
  nothing it controls may reach the agent as an instruction.
- The Design plugin (`threads-design`, a peer Geode/Obsidian-style plugin) owns
  thread delivery (Agent Threads public API v1 `threads.send`, a prompt string
  only), source hints, and sidecar files. Geode owns the guest, the view, and the
  screenshot. The plugin never receives a view, leaf, webview or DOM node.
- Plugins run in the same renderer as Geode with Node access. The contract below
  is a data-hygiene and injection-hygiene boundary toward a well-behaved plugin
  and the agent. It is not a sandbox against a malicious plugin, and does not
  claim to be.
- A Pick button must appear only when something can actually receive the
  feedback. Geode ships the feature and the plugin ships in lockstep, but either
  side may be older than the other and must degrade without errors.
- Phase 0 spikes (`threads-design-2026-11-08-p0-spike-{A,B,C}`) established:
  a session-level preload works under the unchanged CSP and does not displace the
  vault preload (`registerPreloadScript`); the isolated world resists a hostile
  page; hover must send tag + rect only; `.threads-design/` is served today and
  its writes reload the page, so the protocol and the watcher must both change.

## Decision

### D1. The interface is typed handler registration, not a workspace event

Geode adds a Geode-only registry, `app.artifactFeedback`, and a Geode-only
`Plugin.registerArtifactFeedbackHandler(handler)` that follows the existing
`Plugin.registerQuickSwitcherProvider` precedent (feature-detected by `typeof`,
auto-disposed on unload, faults isolated, never quarantines the plugin).

Why: the Pick button's visibility depends on whether a consumer exists, and a
workspace event cannot tell the emitter whether anyone listens. Registration also
gives a return value (accepted/rejected + a message for the popover), a timeout,
routing, an owner identity derived by Geode from the plugin manifest (not
self-declared), and automatic disposal on unload. An event is fire-and-forget:
none of those are expressible.

Rejected: the spec 5.5 workspace event `geode-artifact:feedback` (no presence, no
ack, no disposal, no error path, no way to show "queued" or "rejected").
Rejected: routing through Agent Threads (`ArtifactContribution.onFeedback`):
that is the P3 destination, needs an Agent Threads change, and would make a
Geode view depend on a peer plugin being loaded. The contract is shaped so that
P3 can later adapt it without changing the guest or the popover.

Normative surface (spec text; the implementation lives in
`src/artifacts/feedback-contract.ts`, types and constants only, no runtime
dependencies, so the plugin can vendor a verbatim copy):

```ts
export const ARTIFACT_FEEDBACK_CONTRACT_VERSIONS = [1] as const;   // what this Geode accepts
export const ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS = 15_000;

/** Geode-derived from the plugin manifest (id, name). Never self-declared. */
export interface ArtifactFeedbackOwner { readonly pluginId: string; readonly displayName: string }

/** Identifies the artifact for routing and the visibility check. Data only. */
export interface ArtifactFeedbackTarget {
  readonly root: string;             // absolute path as given to the view (plugin must realpath + contain it)
  readonly artifactId: string;       // manifest.id
  readonly title: string;
  readonly runtime: "static";        // v1 never offers nextjs
  readonly vaultRead: boolean;       // manifest permissions.vault === "read"
}

export interface ArtifactFeedbackHandler {
  /** Must equal a value in app.artifactFeedback.contractVersions. */
  readonly contractVersion: 1;
  /**
   * Optional, synchronous, side-effect free. Evaluated when a view loads, when the
   * registry changes, and when pick mode is toggled. Throwing or returning a
   * non-boolean counts as false. Omitted means "handles every static artifact".
   */
  canHandle?(target: ArtifactFeedbackTarget): boolean;
  /**
   * Called once per user Send (and again, with the SAME selectionId, if the user
   * retries). Resolves when the plugin has taken responsibility for the feedback,
   * NOT when the agent has finished. Must be idempotent per selection.selectionId.
   */
  submit(request: ArtifactFeedbackRequest, context: { readonly signal: AbortSignal }): Promise<ArtifactFeedbackResult>;
}

export type ArtifactFeedbackResult =
  | { readonly status: "accepted"; readonly message?: string }          // sent, or held in the plugin's pending slot
  | { readonly status: "rejected"; readonly reason: "busy" | "invalid" | "unsupported" | "unavailable" | "failed"; readonly message: string };

export type ArtifactFeedbackRegistration =
  | { readonly status: "registered"; dispose(): void }
  | { readonly status: "unsupported-version" | "conflict" | "invalid" | "unavailable"; readonly message: string; dispose(): void }; // dispose is an idempotent no-op here

/** Added to Plugin (Geode-only). Throws only when the plugin generation is inactive, like every Plugin.register*. */
// registerArtifactFeedbackHandler(handler: ArtifactFeedbackHandler): ArtifactFeedbackRegistration

/** app.artifactFeedback (read-only for plugins; register() is internal and used by Plugin and tests). */
export interface ArtifactFeedbackRegistry {
  readonly contractVersions: readonly number[];
  has(target: ArtifactFeedbackTarget): boolean;        // some handler's canHandle is true
  onDidChange(listener: () => void): () => void;       // returns unsubscribe
}
```

Rules:

- Capability detection (plugin side): the plugin treats the feature as available
  only if `typeof plugin.registerArtifactFeedbackHandler === "function"` AND
  `app.artifactFeedback?.contractVersions` includes the version it implements.
  Anything else means "Geode too old": it does nothing, silently (one
  `console.info`, no Notice; the feature is optional).
- Registration results are structured and never throw for caller mistakes:
  `unsupported-version` (handler.contractVersion not in the supported list),
  `conflict` (the same `pluginId` already has a live registration), `invalid`
  (handler is not an object with a `submit` function), `unavailable` (feature
  disabled on this host, e.g. mobile).
- The plugin registers only while it can actually deliver (Agent Threads API
  connected) and disposes on disconnect and on unload. Otherwise the Pick button
  would appear and then always reject.
- Multiple handlers/plugins: allowed, one registration per `pluginId`. Routing is
  deterministic: handlers are consulted in registration order and the first whose
  `canHandle(target)` is true receives the submission. Exactly one handler ever
  receives a given selection. There is no fan-out (two plugins sending one comment
  to the agent twice is a worse failure than a missing button). The Pick button
  is visible iff at least one handler passes `canHandle`.
- Disposal: unload or `dispose()` removes the handler immediately, fires
  `onDidChange`, hides the Pick button, exits pick mode in every view, and settles
  any in-flight `submit` for that handler as
  `{ rejected, unavailable, "<displayName> is no longer available." }` while
  aborting its `AbortSignal`. A late result from a disposed handler is dropped.
- Fault isolation (mirrors the quick-switcher precedent): a handler that throws,
  rejects, returns a malformed value, or exceeds the timeout never reaches the
  plugin `errorHandler` (which would quarantine the whole plugin). It is converted
  to a rejected outcome and logged with `console.warn`.
- Timeouts: `submit` has `ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS` (15 s, the same
  order as the vault bridge query timeout). On timeout Geode aborts the signal and
  shows an "unknown outcome, retry is safe" message (D8). `canHandle` is
  synchronous and has no timeout.
- Data only: `request` is plain structured-cloneable data (strings, numbers,
  booleans, arrays, plain objects, one `Uint8Array`). Geode builds a fresh object
  per call, freezes the plain parts, and keeps no reference to the screenshot bytes
  after the call settles. No DOM node, webview, event, `NativeImage`, function or
  class instance crosses.
- Return values are untrusted by Geode: `status` must be one of the two literals,
  `reason` one of the five, `message` is truncated to 500 UTF-16 units, control
  characters stripped, and rendered with `textContent` only.

### D2. Versioning and lockstep

- One integer, the contract version, governs the registration shape, the request
  envelope, the result type, and `ElementSelection.schemaVersion` (they bump
  together). The guest IPC protocol has its own integer (`inspect:v1` in channel
  names) and is internal to Geode (preload and embedder ship in one bundle).
- Compatibility policy: Geode may add optional fields within a version; the plugin
  must ignore unknown fields (tolerant reader). A removal, a type change or a
  semantic change bumps the version. When Geode adds v2 it keeps accepting v1 for
  at least one release and down-converts the request for v1 handlers. A plugin
  that requires a version Geode does not list degrades to "feature unavailable".
- Ordering: the Geode PR lands first and contains the registry, the protocol deny
  and the watcher ignore together, so no Geode build exposes the registry without
  the deny. The plugin PR second; it never writes `.threads-design/` unless the
  registry reported `registered`, so a new plugin on an old Geode writes nothing.
- Compatibility matrix:

  | Geode | Plugin | Result |
  |---|---|---|
  | without the registry | with feedback support | feature-detect fails; plugin no-ops; Design works as before |
  | with the registry | without feedback support | no handler; no Pick button; deny and watcher ignore are harmless |
  | v1 | v1 | feature works |
  | accepts [1, 2] | v1 | works through the v1 down-conversion |
  | accepts [1] | requires v2 | `unsupported-version`; plugin no-ops with `console.warn` |

### D3. Payload schema v1 and who sanitizes what

Two types exist. `GuestSelectMessage` (guest to embedder) is untrusted and holds
only the fields the page's DOM can supply. `ElementSelection` (embedder to plugin)
is the validated, completed form. In the table, origin E is produced by the
embedder (trusted), G comes from the guest (untrusted data, sanitized and
validated).

```ts
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface ElementSelection {
  readonly schemaVersion: 1;
  // ---- origin E (trusted) ----
  readonly selectionId: string;            // /^sel_[0-9a-f]{32}$/, 128 random bits from the embedder
  readonly artifactId: string;             // manifest.id
  readonly artifactRevision: number;       // the view's last observed runtime revision at selection time
  readonly viewSessionId: string;          // registrationId; the revision counter restarts per registration
  readonly viewportPreset: "desktop" | "tablet" | "mobile" | "custom" | "fill";
  readonly capturedAt: string;             // ISO 8601 UTC, embedder clock
  readonly redacted: boolean;              // true iff the artifact has vault: read (see below)
  // ---- origin G (UNTRUSTED data) ----
  readonly route: string;                  // location.pathname + location.hash, <= 512
  readonly tag: string;                    // lower-case local name, /^[a-z][a-z0-9:-]{0,31}$/
  readonly selector: string;               // <= 512; verified in the guest to resolve to this element
  readonly selectorAlternates: readonly string[];   // <= 3 entries, each <= 512, distinct
  readonly textAnchor: { readonly tag: string; readonly text: string };   // normalized text <= 80 ("" when redacted)
  readonly landmark: string | null;        // nearest heading text or data-variation value, <= 120
  readonly outerHTML: { readonly html: string; readonly truncated: boolean };   // <= 4096 UTF-16 units incl. marker
  readonly ancestors: readonly { readonly tag: string; readonly id: string | null; readonly classes: readonly string[] }[]; // <= 3; id <= 128; <= 8 classes of <= 64
  readonly computedStyles: Readonly<Record<string, string>>;   // keys only from the 40-name allowlist; values <= 200
  readonly boundingBox: { readonly viewport: Rect; readonly document: Rect };  // CSS px; document = viewport + scroll (derived by the embedder)
  readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number; readonly scrollX: number; readonly scrollY: number };
  readonly a11y: { readonly role: string | null; readonly name: string | null; readonly tabIndex: number | null };  // role <= 64, name <= 200 (null when redacted), tabIndex int in [-1, 32767]
}
```

Computed-style allowlist (exactly 40 names, defined once in
`src/artifacts/inspector-protocol.ts`; the embedder drops any other key):
`display, position, z-index, opacity, overflow, visibility, flex-direction,
flex-wrap, justify-content, align-items, gap, grid-template-columns, width,
height, margin-top, margin-right, margin-bottom, margin-left, padding-top,
padding-right, padding-bottom, padding-left, box-sizing, font-family, font-size,
font-weight, line-height, letter-spacing, text-align, text-transform,
text-decoration-line, color, background-color, background-image,
border-top-width, border-top-style, border-top-color, border-radius, box-shadow,
transform`.

Request envelope (what the plugin receives):

```ts
export type ScreenshotOmittedReason = "vault-read" | "too-large" | "capture-failed" | "empty-rect";

export interface ElementScreenshot {
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;              // 1..524288 bytes, PNG signature checked by Geode
  readonly width: number;                  // pixels of the PNG
  readonly height: number;
  readonly cssRect: Rect;                  // the crop in guest viewport CSS px (element + 8 px padding, clipped to the viewport)
  readonly devicePixelRatio: number;
  readonly downscaled: boolean;
}

export interface ArtifactFeedbackRequest {
  readonly contractVersion: 1;
  readonly artifact: ArtifactFeedbackTarget;
  /** TRUSTED: typed by the user in the embedder popover. 1..4000 UTF-16 units, trimmed, never seen by the guest. */
  readonly comment: string;
  /** UNTRUSTED data: every origin-G field inside. Only origin-E fields may be used outside a data fence. */
  readonly selection: ElementSelection;
  readonly screenshot: ElementScreenshot | null;
  readonly screenshotOmitted: ScreenshotOmittedReason | null;   // non-null iff screenshot is null
  readonly stale: boolean;                 // runtime revision advanced between selection and submit
  readonly submittedAt: string;            // ISO 8601 UTC
}
```

Sanitization responsibilities (each layer assumes the previous one failed):

| Layer | Duty |
|---|---|
| Guest preload (isolated world) | Bounded work: build `outerHTML` with a node/char/time-budgeted walker over the live element (never `el.outerHTML` then slice; a 50k-node subtree must not be serialized): strip `<script>` bodies, HTML comments, `data:` URIs (replace with `data:...elided`), `srcdoc`, attribute values over 200 units; truncate at 4096 with a marker. Elide `url(data:...)` in `background-image`. Normalize and truncate text. Compute selector, alternates, text anchor, styles, a11y only on click, never on hover. Verify the selector resolves to the element. When told `redactText`, apply redaction (below). |
| Embedder (`artifact-view`) | Accept `ipc-message` only when `event.target` is this view's `<webview>`, the matching mode is active, the channel/version is known, and the message is under 64 KB. Rebuild the object from an allowlist of keys ("construct, do not copy"; `__proto__`, `constructor`, `prototype` keys are dropped, never assigned). Enforce every type, length and numeric range above, finite numbers with magnitude at most 1e6, the style allowlist, `/^[a-z][a-z0-9:-]{0,31}$/` for tags. Rate limit: hover 30/s, select 4/s with at most one outstanding. Generate `selectionId`, `artifactRevision`, `viewSessionId`, `viewportPreset`, `capturedAt`, `redacted`; derive the document rect. Re-enforce redaction invariants (`redacted` implies empty `textAnchor.text`, null `a11y.name`, and `outerHTML` text nodes removed by a bounded linear pass). Treat everything as data: `textContent` only, never `innerHTML`, never evaluated. Drop the message on any violation (no partial acceptance). |
| Plugin | Re-validate the whole request independently (it may be fed by a future second embedder or a test). Validate `selectionId` against its regex before it touches a path. Place every origin-G field inside the data fence; only origin-E fields and `comment` may appear outside it. Neutralize `/escalate`, clickable URLs, and boundary look-alikes per the 13b delivery rules. |

Redaction for `vault: read` artifacts (resolves a spec inconsistency, see Consequences):
the embedder sends `redactText: true` in the mode message when the registration has
a vault grant. The guest then omits text and attribute values that can carry vault
data: text nodes in `outerHTML` become empty, attribute values are kept only for
`id, class, role, type, data-variation, data-testid` (other attributes keep their
name with value `...`), `textAnchor.text` is `""`, `a11y.name` is `null`. The
embedder never captures a screenshot for these artifacts (`screenshotOmitted:
"vault-read"`), and the plugin must not write one even if handed bytes. No opt-in UI
in P1.

The comment is trusted, and only the comment: it is typed in embedder DOM, so the
page cannot read it, and it is a separate top-level field so no code path can
confuse it with page data.

`selectionId` is generated by the embedder when a valid `select` arrives
(`"sel_" + 32 hex chars` from `crypto.getRandomValues`). The guest never supplies
an id: the id becomes a file name (`.threads-design/selections/<id>.{json,png}`)
and an idempotency handle, so a page-chosen id could overwrite or collide.

`artifactRevision` is the view's `this.revision` (the last value returned by the
400 ms `getArtifactState` poll) at selection time. It is an opaque counter that
restarts at 0 for each registration, so it is meaningful only together with
`viewSessionId`. It is a staleness hint (a lower bound on the revision of the DOM
that was picked), not an identity. `stale` is computed at submit time by comparing
the view's current revision (and session) with the one captured at selection.

`route` is `location.pathname + location.hash` per the spec, capped at 512; the
query string is excluded.

### D4. Guest protocol (preload to embedder, embedder to preload)

Channels are namespaced and versioned. Defined in
`src/artifacts/inspector-protocol.ts`, dependency-free like `guest-protocol.ts`.

| Direction | Channel | Payload |
|---|---|---|
| embedder to guest | `geode-artifact:inspect:v1:mode` | `{ mode: "off" \| "pick" \| "hold", redactText: boolean }` |
| embedder to guest | `geode-artifact:inspect:v1:key` | `{ key: "parent" \| "child" \| "select" }` (forwarded when focus is in the embedder chrome) |
| guest to embedder | `geode-artifact:inspect:v1:ready` | `{ protocol: 1 }` (sent at every document start) |
| guest to embedder | `geode-artifact:inspect:v1:hover` | `{ tag, rect, via: "pointer" \| "keyboard", label?: string }` (`label` only for `keyboard`, accessible name <= 80) |
| guest to embedder | `geode-artifact:inspect:v1:select` | `GuestSelectMessage` (the origin-G fields of `ElementSelection`) |
| guest to embedder | `geode-artifact:inspect:v1:cancel` | `{ reason: "escape" }` |

Modes: `off` (listens to nothing, no host element), `pick` (hover highlight and
click select), `hold` (intercepts clicks and keys but never highlights or
selects; used while the popover is open so the page cannot be activated and the
guest highlight cannot appear in the screenshot).

Normative guest behavior:

- Listeners are registered on `window` in the capture phase at document start.
  Events with `isTrusted === false` are ignored. While not `off`, the guest swallows
  (`preventDefault` + `stopImmediatePropagation`) `pointerdown, pointerup,
  mousedown, mouseup, click, dblclick, auxclick, contextmenu`; a trusted primary
  `click` while `pick` selects. Hover is driven by trusted `mousemove` throttled to
  one message per animation frame. Keys swallowed in `pick`: `[`, `]`, `Enter`,
  `Escape` only; every other key reaches the page.
- Keyboard walk: the candidate starts at the last hovered element, else
  `document.activeElement` when it is not `body`, else `document.body`. `[` moves to
  the parent (stopping at `body`), `]` to the first element child, `Enter` selects.
  Each candidate change draws the highlight and emits `hover` with `via: "keyboard"`
  and a label. Sibling arrows are P3.
- On select the guest hides its highlight, waits two animation frames, sends
  `select`, and enters local `hold` until the next `mode` message (so a second click
  cannot slip through before the embedder answers).
- Self-healing: the highlight host lives in a closed shadow root styled only with
  constructable stylesheets (`adoptedStyleSheets`) and CSSOM, never inline `style`
  attributes or `<style>` elements (those emit CSP console errors under a strict
  author CSP, spike A2). A `MutationObserver` re-attaches a removed host,
  coalesced per animation frame and capped at 20 re-attachments per second, after
  which the guest marks itself degraded until the mode changes (no spin under a
  removal storm). While not `off`, listeners are re-asserted every 1 s by re-calling
  `addEventListener` with the same function identities (idempotent when intact;
  restores them if the page called `document.open()`).
- The preload does nothing in sub-frames (`window !== window.top`). The embedder
  also verifies the frame of the message when Electron 42 exposes it (to verify
  during implementation).
- After every document start the guest sends `ready`; the embedder answers with the
  current `mode`. This is what keeps pick mode alive across the view's own reloads
  (the 400 ms revision poll reloads the page on any file change).
- Channels not in this table (the spec reserved `:rects` and `:textedit`) are
  ignored in P1.

### D5. Preload lifecycle

- `ArtifactRuntime.register()` calls
  `artifactSession.registerPreloadScript({ type: "frame", filePath: inspectorPreloadPath })`
  exactly once per artifact session, for static manifests only, after
  `configureSession` succeeds, and stores the returned id on `ActiveArtifact`.
  `dispose()` calls `unregisterPreloadScript(id)`. The bundle is a new,
  dependency-free entry (`src/main/artifact-inspector-preload.ts` to
  `dist/artifact-inspector-preload.js` in `esbuild.config.mjs`), injectable through
  the `ArtifactRuntime` constructor like `guestPreloadPath` so unit tests use a fake.
- It sits alongside the vault preload: `webPreferences.preload` stays exactly as
  today (set only when `active.vault`), and the inspector is a session preload.
  Spike A showed both coexist and the vault bridge keeps working. The inspector
  exposes nothing to the page (no `contextBridge`), uses no globals, and its IPC
  namespace (`inspect:v1`) is disjoint from the vault bridge's.
- The preload registration is not placed in `configureSession`, which is shared
  with `captureHeadless`. The capture session never gets it. Next.js sessions never
  get it (ADR 0005 stays true unchanged).
- If `registerPreloadScript` throws, the artifact still opens; registration returns
  without `inspector` and the view hides Pick. `ArtifactRegistration` gains
  `inspector?: { protocol: 1 }`, present iff the preload was registered. The Pick
  button depends on this flag, not on guesswork.
- The comment in `secureWebviewAttachment` ("every other artifact keeps preload
  undefined") remains true for `webPreferences.preload` but must be reworded so it
  does not read as "no preload at all".

Rejected: the single `webPreferences.preload` slot (displaces the vault bridge,
spike A), `session.setPreloads` (deprecated in Electron 42), one composed preload
with the vault half gated (larger review blast radius in one file), an
artifact-served `inspector.js` (page world, spoofable, agent-deletable, pollutes
export; the spec already rejected it), and a manifest flag (the artifact author
must not decide whether the user can inspect).

### D6. Screenshot flow

1. The guest `select` carries `boundingBox.viewport` (CSS px) and the viewport size.
2. The embedder builds the crop: the element rect padded by 8 px, intersected with
   `[0, 0, viewport.width, viewport.height]`. An empty intersection yields
   `screenshotOmitted: "empty-rect"`. Artifacts with a vault grant skip capture
   (`"vault-read"`).
3. The embedder calls `webview.capturePage(rect)` (the spike-verified path) with a
   2 s timeout, converts to PNG, and enforces a 512 KiB cap: if the PNG is larger it
   downscales (to widths 1024, then 640) and re-encodes; if still larger,
   `"too-large"`. A failure or timeout yields `"capture-failed"`. The crop happens
   at select time, so the pixels match the selection snapshot even if the user
   types for a minute. The guest highlight is hidden (D4), and the embedder popover
   is not part of the webview surface, so neither appears in the image.
4. Bytes cross as `Uint8Array` in `ElementScreenshot.bytes` (same renderer realm,
   no base64 inflation), with width, height, devicePixelRatio, crop rect and a
   `downscaled` flag. Geode checks the PNG signature and the size cap; the plugin
   re-checks both.
5. The plugin, not Geode, writes `<artifactRoot>/.threads-design/selections/<selectionId>.json`
   and `.png`, atomically (temp file, then rename), after `realpath` containment of
   `request.root` against the artifact it owns, refusing a symlinked or hardlinked
   `.threads-design`, and never the PNG when `artifact.vaultRead` is true. Geode does
   not write the sidecar (spec 13c assumption c).
6. The crop rect uses guest viewport CSS px as webview DIPs, which is correct when
   the guest zoom level is 0. DPR 2 on a Mac is NOT VERIFIED (spike A ran at DPR 1
   on Linux/Xvfb); it is a P1 verification item and the size caps are chosen so a
   2x crop of a typical card stays under the limit.

### D7. Reserving `.threads-design/`: protocol, watcher, entry

Reserved name: the directory `.threads-design` directly under the artifact root
(nested `sub/.threads-design/` is an ordinary directory, as in the spike controls).

Protocol handler. A request is denied with the exact same `404` and body
(`Artifact file not found.`) used for a missing file (no existence oracle) if any
layer matches:

1. Lexical: after the existing single URL decode, replace `\` with `/`, drop empty
   and `.` segments, take the first segment, strip trailing dots and spaces and
   zero-width/ignorable code points (U+00AD, U+200B-U+200D, U+2060, U+FEFF), then
   `normalize("NFKC").toLowerCase()`; deny if it equals `.threads-design`. NFKC is
   deliberate: case-insensitive volumes fold characters such as U+017F to `s`.
2. Realpath: after the existing containment check, resolve the target with the
   native-backed realpath and deny if it equals, or is inside, the real path of
   `<root>/.threads-design`. This closes symlink aliases and OS case aliasing. The
   JS `fs.realpathSync` keeps the typed case on macOS (spike A), so correctness must
   not depend on which realpath is used; layer 3 covers it.
3. Inode: `stat` the target and each ancestor up to the artifact root with
   `{ bigint: true }` and deny if any `(dev, ino)` equals the reserved directory's.
   The spike showed this layer alone denies case variants on APFS.

Also: the manifest `entry` is rejected at registration (`entry_invalid`) if layer 1
matches, and `captures/` behavior is unchanged. Denied requests use identical
headers to a missing file.

Watcher. The chokidar `ignored` predicate (today: first segment equals `captures`)
also ignores the lexical reserved name using the same shared pure predicate, so the
directory is neither watched nor reloaded on. Because chokidar follows symlinks, an
alias inside the artifact pointing into `.threads-design/` would still emit events
under the alias name (spike A4b). The `all` handler therefore re-checks each event
path: `realpath` it (falling back to the path on `ENOENT`) and skip the revision
bump if the result is reserved by layers 2 or 3. Residual: removing such an alias
produces one harmless extra reload. This handles the symlink-into-directory gap; it
does not need to be documented away.

Documented residuals: a hard link to a file inside `.threads-design/` placed
elsewhere in the artifact is not detected by layers 1-3 (a different path and
directory chain with the same file inode). Creating one needs write access in the
artifact plus a prior read of the sidecar, the page has no network (`connect-src
'none'`), and the sidecar holds only the user's own comments. It is accepted for P1.
HFS+/APFS ignorable-code-point and Windows 8.3 short-name aliasing are covered by
the realpath and inode layers, not by layer 1.

Export is plugin-side. Any static copy or zip of an artifact root must exclude
`.threads-design/` and `captures/`; the plugin owns that rule when it exports.

### D8. Pick UI contract (`artifact-view`)

To avoid growing the view further, the state machine lives in a new pure module
(`src/renderer/artifacts/pick-controller.ts`: modes, popover submit states, key
routing, timers injected) and the view only renders and wires it. The IPC handler
is new and independent of `attachVaultBridge` (it exists for non-vault artifacts).

- Toolbar toggle: a `clickable-icon` button with an icon-only label, `aria-label`
  "Pick element to comment", `aria-pressed`, using the `hidden` attribute (not
  disabled) when invisible. Visible iff `registration.runtime === "static"` AND
  `registration.inspector` AND `app.artifactFeedback.has(target)` AND the webview is
  attached with no load error. Re-evaluated on registry change, load, and when
  pick mode is toggled. A command is also registered through the existing actions
  mechanism for the palette and user-assigned hotkeys; P1 ships no default hotkey
  (the spec R1 "shortcut" is met by the command plus Esc/keys below).
- State (never persisted in `getState`, reset by `load()`/`release()`): `off`,
  `pick`, `popover` (with submit state `idle | pending | accepted | rejected`).
  Pick mode is single-shot: it exits after an accepted submission is dismissed, and
  Esc exits it when no popover is open. While pick mode is on, the toolbar status
  says "Pick mode: click an element, or use [ ] and Enter. Esc exits." and the Pick
  button shows its pressed state. The toolbar Capture button first turns pick mode
  off so the highlight cannot appear in a manual capture.
- Turning on by keyboard (Enter/Space on the toggle) calls `webview.focus()` so
  the guest receives native `[ ] Enter Esc`. When focus is in the toolbar (mouse
  user), the embedder forwards `[` and `]` as `key` messages; Enter is not
  forwarded because the focused button owns it. Esc handling, in order: popover
  `pending` ignores Esc; popover otherwise cancels (back to `pick`, guest told
  `pick`); `pick` without popover exits to `off` and returns focus to the toggle.
  A guest-native Esc arrives as `cancel` and follows the same rules.
- Popover: embedder DOM in an overlay layer above the webview, anchored below the
  selection rect (flipped above when it does not fit, clamped to the stage); it does
  not follow scrolling. `role="dialog"`, `aria-modal="false"`, labelled by its
  heading ("Comment on `<tag.class>`", `textContent`). Contents: a textarea
  (`aria-label` "Comment on the selected element", `maxlength` 4000), a collapsed
  `details` "Show what will be sent" that lists the comment, the selection fields
  (selector, bounding box, truncated outerHTML, a11y, redaction notice) and whether
  a screenshot is included, all `textContent`; a status line (`role="status"`,
  `aria-live="polite"`); buttons Send (primary, Cmd/Ctrl+Enter) and Cancel. Only Send
  and Cancel exist in P1 (no Pin). The disclosure shows what leaves the page and the
  comment. It cannot show the final prompt text because the plugin builds it with a
  per-message random boundary token at send time.
- Focus: on open, focus the textarea. On close, restore focus to what held it
  before the selection (the webview for a guest-originated pick, otherwise the
  toggle). Non-modal; Esc and Cancel always dismiss it unless `pending`.
- Popover states:
  - `idle`: Send enabled when the trimmed comment is non-empty.
  - `pending`: textarea read-only, Send reads "Sending...", `aria-busy`, Cancel
    disabled (prevents a phantom send after a visible cancel), status "Sending to
    {displayName}...". Bounded by the 15 s timeout.
  - `accepted`: status shows the plugin's message (default "Sent."), a "Done" button
    takes focus; Enter/Esc/Done closes and exits pick mode.
  - `rejected` (including synthetic timeout and unavailable): status
    (`role="alert"`) shows the plugin message; the text is kept, Send becomes
    "Retry", Cancel is enabled. Timeout copy: "No response from {displayName} in
    15 s. It may have been received; check the thread before retrying. Retry reuses
    the same selection id." If the handler disappeared, Send is disabled and the
    copy says so.
- Retry reuses the same `selectionId`; a new pick makes a new one. A page reload
  while the popover is open keeps the popover and appends "The page reloaded; this
  selection may be out of date." (the request carries `stale`).

### D9. Test seams

Geode, no plugin needed:
- Pure unit tests: `reserved-paths` predicate (the spike's 39-case matrix is the
  basis), `resolveArtifactFile` layers through the injectable `ArtifactPathFs`
  (extend with `lstat`/native realpath), `validateGuestSelection` (caps, unknown
  keys, `__proto__`, redaction invariants), registry (fake handler: routing order,
  `canHandle` throwing, conflict, version mismatch, disposal mid-flight, timeout
  with fake timers, malformed result), pick-controller state machine (every
  popover state, Esc order, retry id reuse), guest preload under jsdom with a mocked
  `ipcRenderer` (`isTrusted` false ignored, mode gating, walker budgets, redaction,
  listener re-assertion), and `ArtifactRuntime` with a fake `Session` (exactly one
  `registerPreloadScript` for static, zero for nextjs and capture sessions,
  `unregisterPreloadScript` on dispose).
- E2E (Playwright for Electron, `--workers=2`): a fake handler is registered through
  the same public path (a fixture plugin in the test vault, or `evaluate` on the app
  object as other specs do) and records requests. Cases: Pick absent with no
  handler, present after registering, absent again after dispose; the hostile page
  fixture from the spec (synthetic events, forged channel posts, patched prototypes,
  host removal storm, `document.open()`, 50k nodes, injection text); keyboard-only
  pick/comment/send; `.threads-design` 404 variants and no reload on a write and via
  a symlink alias; screenshot size and no CSP console errors under a strict author
  CSP; reload while pick mode is on.
Plugin, no Geode needed: a fake registry (`registerArtifactFeedbackHandler` stub
that captures the handler and returns `registered`) lets tests call `submit` with
fixture requests; the fake Agent Threads API covers delivery. Shared golden
fixtures (valid request, redacted request, over-cap, `__proto__`, hostile strings)
live in `tests/fixtures/artifact-feedback/` and are vendored verbatim into the
plugin; the contract version and a fixture checksum are recorded in the plugin
contract note so drift shows up in review.

## Rejected alternatives (summary)

- Workspace event instead of registration (D1).
- Fan-out to every handler (duplicate agent messages) and single-handler exclusivity
  (blocks other producers); chosen: first matching handler, one recipient.
- Base64 screenshot field (33 percent inflation and an encode/decode for no
  isolation benefit in one renderer) and Geode writing the PNG (violates plugin
  ownership of the sidecar).
- Capturing the screenshot at Send time (pixels can differ from the selection).
- Guest-supplied selection ids and guest-side `outerHTML` slicing (id collision;
  unbounded serialization cost).
- Sending selector/alternates on hover (50k-node p95 of 73.5 ms, spike A3).
- Persisting pick mode in view state (it would silently re-arm after restart).
- A modal popover (traps keyboard focus in a view that also hosts a webview).

## Threat model

Assets: the user's thread (agent actions follow its prompts), vault data rendered
by `vault: read` artifacts, the artifact files, Geode's renderer process.
Actors: a hostile or prompt-injected guest page; the agent that authored it; a
well-behaved but buggy plugin. A malicious plugin is out of scope: it already has
the renderer's privileges.

| Threat | Mitigation | Residual |
|---|---|---|
| Page forges a selection or hover | Preload in the isolated world exposes no API; page `postMessage`/`CustomEvent` cannot reach `ipcRenderer`; `isTrusted` filter; embedder checks sender, mode, channel version, schema, caps, rate | none known |
| Page reads what the user types | Comment is typed in embedder DOM and never sent to the guest | none |
| Page changes what the preload measures | Preload uses its own world's native prototypes (spike A2); selector verified in the guest | page controls its own DOM, so selected content is attacker-influenced by design: it is untrusted data |
| Prompt injection through element text, attributes, comments, screenshot text | Sanitization in the guest, schema in the embedder, fence and neutralization in the plugin, `comment` separated from `selection`, no auto-send, "Show what will be sent" | the host sends one user-role message with no provenance until P3; the fence is convention |
| Sidecar or comments read by the page | Layered protocol deny returning an indistinguishable 404; no network | hard-link residual (D7) |
| Page triggers reload churn through sidecar writes | Watcher ignore plus event-time realpath re-check | one extra reload when a symlink alias is deleted |
| Path traversal through `selectionId` | Embedder-generated, strict regex, re-validated by the plugin | none |
| Vault data leaves through payload or pixels | `redactText`, no screenshot for `vault: read`, plugin refuses the PNG | attribute values on the kept-name list can still carry data (`id`, `class`) |
| Page destroys or hides the picker | Re-attach with a rate cap, 1 Hz listener re-assertion, degraded state | the picker can be disabled by a page; this is availability only, never a forged selection |
| Page learns pick mode is on (host element is visible in the DOM) | accepted | a page may behave differently while inspected |
| Embedder XSS through payload or plugin message | `textContent` only; messages truncated and control-stripped | none |
| Renderer DoS (huge DOM, message flood) | Bounded walker with node/char/time budget, 64 KB message cap, rate limits, hover throttling | a pathological click on a huge DOM costs up to the time budget |
| Subframe forgery | Preload no-ops outside the top frame; `frame-src 'none'`; embedder frame check | frame identity check depends on an Electron 42 field (verify) |
| Hostile loopback page (nextjs) | Not applicable in P1: no inspector there | revisit in the ADR 0005 amendment |
| Preload becomes a privileged foothold | Sandboxed, `contextIsolation`, no Node, only `sendToHost`/`on`, no `eval`, no dependencies | n/a |

## Consequences

- Static artifacts gain an inspector without any manifest, CSP, request-filter or
  `isArtifactUrlAllowed` change (spike A empty-diff proof); those tests stay
  unchanged and must keep passing.
- Geode now owns a second, small preload and a new typed extension point that the
  plugin consumes. Contract changes need a version bump and a down-conversion for
  one release. The plugin must carry a vendored copy of the contract types.
- `.threads-design/` becomes a reserved name for every static artifact. A producer
  that already uses that directory for page-visible assets will see 404s.
- The popover can only show structured data, not the final prompt. The exact-prompt
  preview waits for P3's host-rendered context chip.
- Pick mode is single-shot, a UX default that is cheap to change later.
- Spec amendments this ADR makes (spec 13b wins where they conflict, and these
  refine rather than contradict it): hover may carry a label for keyboard walks;
  `vault: read` redaction extends beyond the screenshot (spec section 9 vs 13c(e));
  idempotency is enforced per `selectionId` at the contract level (the plugin's
  `sha256(finalPrompt)` key alone does not dedupe a retry when the prompt contains a
  fresh random boundary token; the plugin derives the boundary from an HMAC of the
  `selectionId` and also keeps an in-memory ledger); a second Send while an earlier
  comment is pending on the same artifact is rejected with `busy`, not silently
  replaced.
- Verification gaps that must end the phase VERIFIED or listed NOT VERIFIED: DPR 2
  crop on a Mac; webview coordinates under non-default zoom; Electron 42 frame id on
  `ipc-message`; highlight removal storm and `document.open()`; zero CSP console
  errors from the preload under a strict author CSP; Codex PNG-by-path; live
  `threads.send` and one smoke test per permission mode (plugin side).
- Gate: a `reviewer` security pass over the preload, the IPC handler, the validator,
  the deny layers and the registry before merge.

## Implementation map (informative)

New: `src/artifacts/feedback-contract.ts`, `src/artifacts/inspector-protocol.ts`
(channels, caps, style allowlist, guest message types), `src/artifacts/reserved-paths.ts`
(pure lexical predicate), `src/main/artifact-inspector-preload.ts`,
`src/renderer/artifacts/feedback-registry.ts`, `src/renderer/artifacts/pick-controller.ts`,
`src/renderer/artifacts/selection-validator.ts`.
Changed: `src/main/artifact-runtime.ts` (register/unregister preload, watcher ignore
and event re-check, protocol deny, `ArtifactRegistration.inspector`),
`src/main/artifact-paths.ts` (deny layers), `src/renderer/views/artifact-view.ts`
(toggle, overlay, popover, IPC handler), `src/renderer/plugin.ts`
(`registerArtifactFeedbackHandler`), `src/renderer/app.ts` (`artifactFeedback`),
`esbuild.config.mjs` (second preload entry).
