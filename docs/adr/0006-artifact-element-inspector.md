# ADR 0006: Artifact element inspector (host-owned preload) and the plugin feedback contract

Status: Proposed. Extends ADR 0004 (artifact sandbox). Consistent with ADR 0005:
Next.js (`nextjs`) artifacts get no inspector in this ADR; an inspector on the
loopback origin needs its own amendment to ADR 0005 (planned, not decided here).

Scope: Phase 1 of the Threads Design "element picker + comment-to-thread"
feature, static artifacts only. Pins, the comment rail, batching, direct text
edit, structured-context delivery and `nextjs` support are out of scope.

Note on numbering: `docs/adr/` already contains `0006-contextual-document-actions.md`
(the directory has several duplicate numbers). This file keeps the number 0006 because
the feature spec, the product tracking item and the plugin contract all cite "ADR 0006".

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
- Phase 0 spikes (three throwaway experiments, not part of this repository) established:
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

Implementation (P1 deny). Layer 1 is `src/artifacts/reserved-paths.ts` (pure; additionally percent-decodes up to
4 rounds and checks every form, resolves `..`, treats `\\` as a separator, strips default-ignorable code points
anywhere in the name, and checks any segment that ever sits directly under the root, even if a later `..` removes
it). Layers 2 and 3 are `src/main/artifact-reserved-dir.ts` (`isReservedOnDisk`). Both run inside
`resolveArtifactFile`, so the protocol handler (`src/main/artifact-static-handler.ts`) and the manifest `entry`
check (`reserved_path`, surfaced as `entry_invalid`) share one gate and one 404. The watcher is
`src/main/artifact-watcher.ts`. The hard-link residual below is unchanged and untested by design.

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

## Implementation notes: Phase 1 part 1 (contract, registry, preload, bridge)

Everything except the visible UI. Settled details and deviations, in the order a
reviewer will meet them:

**Files.** `src/artifacts/feedback-contract.ts` (verbatim contract types, no imports) and
`src/artifacts/inspector-protocol.ts` (channels, caps, the 40-name style allowlist, guest message types);
`src/renderer/artifacts/feedback-registry.ts` (`ArtifactFeedbackService`, `app.artifactFeedback`);
`Plugin.registerArtifactFeedbackHandler` in `src/renderer/plugin.ts`;
`src/main/artifact-inspector-guest.ts` (all guest logic, no Electron import, runs under jsdom) with the thin
`src/main/artifact-inspector-preload.ts` entry (esbuild entry added);
`src/renderer/artifacts/selection-validator.ts` (pure validator) and
`src/renderer/views/artifact-inspector-bridge.ts` (bridge). The ADR's map named
`artifact-view.ts` for the IPC handler; the bridge file lives in `views/` as the task asked, the view only instantiates it.

**New dev dependency: `jsdom` (devDependency, tests only).** D9 specifies the preload is tested under jsdom
and the unit suite had none (it used hand-rolled fakes). jsdom 31 supports constructable stylesheets,
`adoptedStyleSheets`, closed shadow roots and iframes, which is what the preload tests need. The guest harness
mints `isTrusted === true` events through a deep import of jsdom's internal `lib/generated/idl/utils.js`
(`dispatchEvent()` resets `isTrusted` to false); that is test-only and will need a touch on a jsdom major bump.

**Registry.**
- `ArtifactFeedbackService.submit()` resolves to `ArtifactFeedbackOutcome`, a `ArtifactFeedbackResult` plus
  `source: "handler" | "timeout" | "disposed" | "no-handler" | "invalid-result"`. The contract types are untouched;
  `source` lets the popover word "no response in 15 s" differently from "the plugin said no", as D8 requires.
- Timeout and a thrown/rejected submit map to `rejected, reason: "failed"`; disposal to `unavailable`; no
  matching handler to `unavailable` with `source: "no-handler"`.
- `enabled` is `host.capabilities.artifacts`, so the browser/mobile host registers as `unavailable`.
- `Plugin.registerArtifactFeedbackHandler` returns `unavailable` (never throws) when the host has no
  `app.artifactFeedback`, and throws only for an inactive plugin generation.
- Owner id and display name come from the manifest; a handler cannot override them.

**Guest.**
- Listeners are registered at document start and stay registered in every mode; in `off` the handler returns
  immediately and never calls `preventDefault`. "Off listens to nothing" in D4 is therefore "inert", not
  "absent" (removing and re-adding would let a page listener registered in between run first).
- The highlight host exists only in `pick` (removed in `hold` and `off`) and is moved with
  `CSSStyleSheet.replaceSync` of a one-rule sheet, not by mutating an inline style.
- Escape sends `cancel` in `pick` and `hold`; the embedder decides what it means (a pending popover ignores it).
- `selector` can be the empty string when no candidate verifies (for example 2000+ siblings: sibling counting is
  bounded). Selector candidates in order: `[data-testid]`, unique `#id`, `tag.class.class`, `of-type` path anchored at
  a unique ancestor id, `nth-child` path; the first verified is primary, up to 3 more are alternates.
- `outerHTML` budgets: 600 nodes, 25 ms, 4096 units; iterative (a 4000-deep tree does not recurse); text is HTML-escaped
  so page text cannot forge tags; on* and srcdoc values, data: URIs, script bodies and comments are elided.
- `tabIndex` is the explicit attribute, else the natural value when focusable, else null.
- Keyboard hover `label` is omitted for redacted artifacts.

**Bridge and validator.**
- A hostile own key (`__proto__`, `constructor`, `prototype`) at any validated level REJECTS the message. D3 said
  "dropped"; rejecting is stricter and costs nothing (a benign guest never sends one).
- Non-allowlisted `computedStyles` keys are dropped silently; a message with more than 80 raw style keys is rejected.
- Redaction invariants are enforced by scrubbing (empty text anchor, null name, `redactHtml` pass over `outerHTML`),
  not by rejecting, so a selection on a vault artifact still works.
- Rate limits: 30 inspector messages per second in total (`ready` included) and 4 selects per second, counted on a
  1 s sliding window. "One outstanding select" is implemented by the bridge entering `hold` on the first accepted
  select, before the screenshot is taken; the UI returns to `pick` with `setMode("pick")`.
- Selections are immutable (`freezePlain`) and carry no guest-supplied identity. `stale` is true when the
  runtime revision advanced OR the guest announced a new document (`ready`) since the selection; the
  revision alone would miss a manual reload.
- Empty selector is accepted; an `isMainFrame === false` flag on the `ipc-message` event drops the message when
  Electron supplies it (NOT VERIFIED that Electron 42 does; the sender check is `event.target === webview`).

**Seams for the UI engineer** (all in `artifact-inspector-bridge.ts`):
`artifactFeedbackTarget(registration, root)`, `isPickAvailable(registration, app.artifactFeedback, target)` (add the
view-local "webview attached, no load error"), `new ArtifactInspectorBridge({ webview, registration, target,
registry: app.artifactFeedback, getRevision, getViewportPreset, callbacks })`, `setMode`, `sendKey`, `submit`, `dispose`.
The webview element needs `capturePage(rect)` (already a `<webview>` method) and `addEventListener("ipc-message")`.
Create the bridge in `load()` for static artifacts with `registration.inspector`, dispose it in `release()`/`load()`.
`onSelect` means the bridge is in `hold`; call `setMode("pick")` on cancel and `setMode("off")` to leave pick.
`onCancel` carries no state; apply the D8 Esc rules in the view.
`app.artifactFeedback.onDidChange` and `has(target)` drive Pick visibility; the registry already settles in-flight
submits as `unavailable` on disposal.

## Implementation notes: Phase 1 part 2 (pick UI and Electron e2e)

**Files.** `src/renderer/artifacts/pick-controller.ts` (pure state machine, host surface: `setGuestMode`, `submit`,
`focus`, `changed`), `src/renderer/artifacts/pick-popover.ts` (popover DOM, `popoverPosition`, `popoverStatus`,
`describeSelectionForDisclosure`), wiring in `src/renderer/views/artifact-view.ts` (`attachInspector`/`detachInspector`,
created in `load()` for `runtime === "static"` with `registration.inspector`, disposed in `release()`), the
`artifact.toggle-pick` action and "Toggle element picker" command in `src/renderer/app.ts` (no default hotkey; available
only while the Pick button is visible), CSS next to the other `.artifact-view-*` rules in `styles/app.css`.
e2e: `tests/e2e/artifact-element-picker.spec.ts`, fixtures in `tests/e2e/helpers/artifact-picker-fixtures.ts`, and the fake
handler plugin `tests/fixtures/plugins/artifact-feedback-probe/` (registers through the public
`Plugin.registerArtifactFeedbackHandler`, records every request).

**Deviations and settled details.**
- Accepted state is the ADR's: the status shows the plugin message ("Sent." by default), Done takes focus, Enter/Esc/Done
  close it and end pick mode. It does not auto-close.
- The popover heading is `Comment on <tag>`. The selection carries no per-element class list (only ancestors do), so the
  `.class` suffix of D8 is replaced by a second line with the accessible name or text and the selector.
- Focus after Done/Cancel restores what held it before the selection (`FocusOrigin`: the webview for a pick that began in
  the page, else the toggle); Esc with no popover and the toggle itself return focus to the toggle.
- A pointer hover is shown in a small toolbar readout (`.artifact-view-hover`, `<tag> w x h`); a keyboard walk shows the
  label and is `aria-live="polite"`. This is also the embedder-observable hover state the e2e asserts on.
- Visibility also requires the guest to have finished loading once and no main-frame load failure; `ERR_ABORTED` (-3, a
  reload racing the previous load) is ignored so the 400 ms revision reload does not hide the toggle or end pick mode.
- Esc and `[`/`]` from the embedder chrome are handled by one `keydown` listener on the view container (bubble phase, so
  the popover's own Esc handler runs first). `[`/`]` are not forwarded from the textarea. Enter is never forwarded.
- The popover stays open across a reload and goes stale on `dom-ready`; pick mode re-arms because the bridge re-sends the
  mode on the guest's `ready`.
- `ArtifactFeedbackService.describeHandler(target)` was added (internal, not in the plugin contract) so the copy can say
  "Sending to {displayName}...".
- The popover also shows Send and Cancel in DOM order Send, Cancel (tab order) and lays them out reversed with CSS.

**Test seams used.** The 15 s submit timeout is shortened in e2e by assigning `app.artifactFeedback.timeoutMs` (a plain
TypeScript-private field); the 15 s wording and the abort are unit tested in the registry tests. Guest input comes from
`webContents.sendInputEvent` on the artifact guest (trusted events), highlight pixels from `guest.capturePage`.
Playwright's CDP page screenshot does not composite the `<webview>` guest under Xvfb, so the visual evidence uses the
window's own `webContents.capturePage`.

**Verified in real Electron (Linux, Xvfb).** The host preload attaches to a live webview and select/hover/cancel/ready
round-trip; highlight draws and recovers when the page removes its host every 100 ms; a 1000/s removal flood does not
spin the renderer and Esc still exits; `document.open()` is healed by the 1 Hz listener re-assertion; forged
`postMessage`/`MessageEvent`/`CustomEvent` traffic with the real channel names, synthetic mouse/pointer events, patched
`getBoundingClientRect`/`getComputedStyle`/`attachShadow` produce no selection; the page's own capture and bubble
listeners see no trusted press/release/click during pick (a bare `mousemove` still reaches the page by design, D4); a
real click yields exactly one selection with the true rect; `.threads-design/` is unreadable by `img`, `script` and
navigation (case, percent-encoded, `..` and backslash variants), a write there neither bumps the revision nor reloads,
a write to `index.html` does; hover on a 5k-node page measured p50 7 ms and p95 17 ms (80 trusted mouse moves, loaded
shared host; recorded, not gated).

**Still NOT verified:** DPR 2 capture on a real Retina display; webview coordinates under non-default zoom (the popover
anchor assumes zoom 1); `isMainFrame` on `ipc-message` in Electron 42 (the bridge drops sub-frame messages only when
the flag is present); zero CSP console errors from the preload under a strict author CSP; macOS (all e2e ran on Linux).

## Implementation notes: review fix pass (security and QA findings)

Fixed in code (each with a test that failed first):
- **Dropped selects no longer strand the guest (B1).** The bridge keeps separate sliding-window budgets: hover 30/s,
  select 4/s, cancel 10/s, ready 10/s. A `select` that is dropped for any reason (size, arity, rate, validation) while the
  user is in pick mode re-sends `mode: pick`, because the guest enters its local hold when it sends a select.
- **Bounded guest work (A1).** Raw attribute values are cut to 2x the kept cap and raw text nodes to a fixed length
  BEFORE any regex or copy runs, so a 720k-character `style` or a multi-megabyte text node costs milliseconds.
- **Keyboard-activated clicks (A2).** A trusted click with `detail === 0` (Space/Enter on a focused control) selects its
  own target, never the element at (0, 0).
- **Validator (A4, A5).** `0 < devicePixelRatio <= 16` and viewport sizes <= 1e5. For `vault: read` artifacts the embedder
  also drops the route's query and fragment and nulls `landmark` (kept attribute values and selectors remain the accepted
  residual).
- **Data-only boundary (A6).** `canHandle` is read inside the try; the `target` is frozen; every attempt receives its own
  copy of the screenshot bytes. The held snapshot keeps the PNG while the popover is open (retry needs it) and is dropped
  when the popover closes. This amends the earlier "no reference after the call settles" sentence: the guarantee is per call.
- **Plugin-facing registry (A7).** `app.artifactFeedback` is a frozen read-only view (`has`, `onDidChange`,
  `contractVersions`). The full service lives on the internal `app.artifactFeedbackService`; `register` is reachable only
  through `Plugin.registerArtifactFeedbackHandler`. Routing is unchanged (first registered handler whose `canHandle` passes,
  no fall-through): an early handler without `canHandle` takes every static artifact and can starve later ones, accepted
  for the exactly-one-recipient guarantee; handlers should set `canHandle`.
- **Popover (A8, A9).** Placement is clamped inside the stage in every branch (the textarea is always visible). Esc during
  IME composition is ignored. The status is a single politeness: `role="status"` with `aria-live="polite"`, or
  `role="alert"` with no `aria-live`.
- **Missing preload (A10).** The runtime checks the preload file exists before registering and before setting
  `registration.inspector`; otherwise Pick stays hidden and a warning is logged.
- **Inode layer (A12).** The inode comparison is skipped when the reserved directory's `ino` is 0 (FAT/exFAT, SMB, some
  FUSE); the realpath layer still applies.
- **UX.** A rejection has its own error colour, icon and left border (contrast-checked pairs, at least 4.5:1 in both themes);
  the selected element stays marked by a non-interactive embedder box while the popover is open; the toolbar no longer wraps
  "Diagnostics" or clips the hint (the hint is hidden below 700 px while picking, the hover chip takes the room); an
  accepted comment leaves a persistent "sent" chip in the toolbar until the next pick (no pins in Phase 1).

Documented residuals (no code change):
- **A3: the page can disable the picker.** Timer and animation-frame ids live in a namespace shared with the page, so a
  page can clear the guest's re-assertion timer and then call `document.open()` to erase its listeners. The result is
  availability only: pick mode looks on, the page receives the user's clicks and keys, and no selection is ever forged.
- **A11: watcher cost and ordering.** Revision bumps are asynchronous and unordered, with a handful of fs calls per event
  while `.threads-design/` exists. Fine for ordinary edits; a build writing thousands of files creates many concurrent
  checks. Coalescing per tick is a possible later optimization.
- **A13: check-to-read race.** A symlink swapped between the reserved-path check and the read could bypass the deny, but
  the page has no write access, so the page cannot exploit it (the agent that can write the artifact can already read the
  sidecar). The containment check shares the property.
- **A14: Windows/NTFS aliases are unverified.** `.threads-design::$INDEX_ALLOCATION` and 8.3 short names are not matched by
  layer 1 and the on-disk layers have not been run on Windows. Geode ships on macOS today.

**Disposal while a send is in flight (wording).** When the handler is disposed or its plugin unloaded with a submit in
flight, the plugin may already have issued the send, so the popover says "{name} was unloaded before it answered. Check
the thread to see whether your comment arrived." (`source: "disposed"`, reason `unavailable`, Retry behaviour unchanged).
The plain "no longer available, so this comment cannot be sent" wording remains only for a popover that was never
submitted (idle) or when no handler matched. A plugin-provided message for the disposed case is not possible: the handler
is already gone when Geode settles the call, so Geode must word it itself.

**CI findings (Windows and macOS).**
- The reserved-dir fake-fs tests keyed their fake paths with POSIX strings while the module normalises with `node:path`, so
  they failed on `windows-latest`; they now build every key with `path.join`/`path.resolve`.
- Windows review of the module: `isInside` uses `path.relative` (case-insensitive on win32), the lexical layer already treats
  `\` as a separator, and `fs.promises.realpath` is the native implementation, so 8.3 short names (for example
  `.THREAD~1`) expand to the long name and also share the directory's file index (inode layer). `ino` of 0 skips the inode
  layer. One real gap fixed: NTFS stream syntax (`.threads-design::$INDEX_ALLOCATION`, `.threads-design:stream`) now matches
  in layer 1 (the part before the first colon is compared). Still unverified on a real Windows volume beyond the unit suite
  (junctions and ReFS identities).
- The case-insensitive-filesystem test (inode layer alone) ran and passed on the macOS CI runner (3 skipped there against 4 on
  Linux), which is macOS verification of that layer.
- Heavy-DOM guest tests (50k nodes, 4000-deep nesting, 720k-character style) use explicit 30 s timeouts and build nesting with
  `createElement`; the macOS runner timed out the default 5 s once.
