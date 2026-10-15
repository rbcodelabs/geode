# ADR-0034: Share a controlled PDF viewer across tabs and embeds

**Date:** 2026-10-14
**Status:** Accepted for P1; dependency and assets must be locally pinned and verified

## Context

PDF viewing and page embeds are high-impact documented gaps. The app's trusted
plugin renderer enables Node; untrusted PDF data must not acquire those privileges
or a Web Viewer preload bridge. Local inspection found installed Electron42.4.0
versus declared^42.10.0; bundled PDFium does not prove a working native PDF surface.
Use local vault bytes, existing permission boundaries, accessible controls,
predictable cleanup and honest partial evidence. No paid infrastructure.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Bundled PDF.js worker/shared viewer (selected) | Controlled page/text APIs, reusable component, portable foundation for selection links | New dependency/assets; own accessibility and toolbar integration |
| Sandboxed Chromium PDF guest | Existing engine/controls; no PDF dependency | Secure resource transport, opaque APIs, Electron-only and webview stability concerns |
| Native WebContentsView overlay | Main-controlled isolated contents | Complex scrolling bounds/clipping/focus for Markdown/Canvas; opaque APIs |

## Decision

Use a supported PDF.js distribution pinned in the lockfile, with matching local
worker, fonts and CMaps. Verify the current package's primary API/setup guidance
before implementation. Use document/page APIs, not a remote generic viewer.
An internal PdfDocumentSession/PdfViewer serves file tabs and Markdown/Canvas
embeds. Root accepts this reversible dependency choice within the overnight plan.

Pass only authorized binary data to the worker, with Node disabled. Give it no
arbitrary URL/path, host preload, plugin require or IPC capability. Disable PDF
scripting/XFA and unsafe evaluation; no automatic network, launch-program or
embedded-file actions. Explicit supported links use existing navigation policy.
Original PDF bytes remain read-only. Annotation authoring is outside scope.

## Permission and data flow

Resolve the authored reference through metadata; capture file/vault/session/page;
read bounded PDF bytes through a host-authorized resource operation; parse in the
local worker; render page/selectable text; route explicit links through policy.
The lexical vault helper is not symlink containment. Verify canonical root/target
containment, reject traversal, foreign/denied roots, stale sessions and escaping
symlinks before reading. Do not expose an arbitrary-path reader. External-root
PDFs remain unsupported until their binary resource path is explicitly authorized.

## View and navigation

Add PdfView beside ImageView in file opening, history, leaf navigation and
workspace restore. Classify pdf embeds once and use the same component in Reading,
Live Preview and Canvas file nodes. Parse #page=N, #height=N and combined fragments
in one pure helper; require positive safe integer pages, validate page count, bound
height and report malformed/out-of-range values. Preserve authored links.
Page/zoom operations change view state only. Persist file/current page, never
worker/canvas/object URLs. Avoid Markdown fallback and persist:webviewer bridges.

## Lifecycle and limits

The session owns loading/worker/render/text-layer tasks and listeners. Cancel
stale loads and guard generations on close/file/page change. Register asynchronous
embeds with the accepted native render ownership barrier from ADR0032; PDF is
read-only but still needs awaited cancellation/disposal. Render the selected page
or a small visible window, not every page at startup. Bound pixel area/concurrency;
report oversized/unsupported documents explicitly rather than omitting pages.
Loading/password/corrupt/missing/denied errors must be recoverable.

## Phased delivery

P1: dedicated local PDF tabs; first/requested page, page count and previous/next/
page input; zoom/fit width; selectable text/accessibility; Reading/Live Preview/
Canvas page/height embeds; restart state; read-only byte integrity and cleanup.
Keep the whole PDF help page partial.

P2: thumbnails/outline, section/page link copying, fit height, single/two-page
layouts and theme adaptation. P3: desktop search, copy as quote and selection
links with a verified stable page/selection mapping. Note export-to-PDF is a
separate rendered-note/print workflow; opening PDFs does not implement export.

## Consequences and risks

One rendering dependency/local assets replaces multiple divergent embed viewers
without a new privileged browser surface. Main risks are packaged CSP/worker
loading and text-layer accessibility/performance. Canvas-only display is
insufficient. Review PDF.js security updates and equivalence during upgrades.
Revisit native rendering only if measured constraints defeat PDF.js while keeping
the shared viewer/session contract.

## Acceptance evidence

- Synthetic three-page PDF with distinct selectable text; requested page visible.
- PDF hash unchanged after navigation, zoom, close and restart.
- File explorer/wiki/Markdown links, history, fragments, restart and all embed modes.
- Traversal/escaping symlink/foreign or stale root/disallowed scheme rejected.
- Slow close/switch/repeated embed cancellation leaves no obsolete tasks/listeners.
- Keyboard focus/labels/text selection and screen-reader inspection.
- Corrupt/empty/password/missing/large inputs show bounded recoverable errors.
- PDF actions cannot obtain Node, IPC, arbitrary local reads or automatic network.

Primary references: [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
[setup](https://mozilla.github.io/pdf.js/getting_started/),
[Electron embedding guidance](https://www.electronjs.org/docs/latest/tutorial/web-embeds).
Architect reviewed local source/pinned help; no live PDF surface was verified.

## Addendum: give the PDF worker its own response policy

**Date:** 2026-10-15
**Status:** Superseded by the fixed viewer-document recommendation below; direct bootstrap failed

### Context

The application renderer permits plugin evaluation and WebSocket connections.
A file/blob worker must not rely on that broad policy for PDF isolation. Replacing
worker fetch/XHR is useful for deterministic assets, but is not a browser security
boundary: dynamic module imports do not use the replaced fetch function.

Pinned PDF.js 6.4.299 disables ICC processing when `useWorkerFetch` is false.
Its QCMS/profile loader needs synchronous XHR; image codecs also support dynamic
JavaScript fallback imports. P1 requires working WASM rather than adding those
fallback modules. Only packaged CMap/font/WASM/ICC bytes are available to its
private in-memory fetch/XHR adapters. They accept exact manifest keys and never
delegate an unknown request to the network or a file reader.

### Options considered

| Option | Benefit | Tradeoff |
|---|---|---|
| Fixed custom worker URL with a response CSP (recommended) | Browser-enforced worker policy; one immutable resource; no new browsing surface | Custom-scheme worker boot and header enforcement must be proved on locked Electron |
| File/blob worker plus replaced global APIs | Smallest patch; deterministic asset reads | Inherits or lacks a suitably restrictive policy; does not constrain every browser request path |
| Separate sandboxed document/session owning the worker | Additional renderer/permission boundary | Larger messaging, rendering and lifecycle change; revisit if the fixed URL cannot work safely |

### Recommended decision

Serve exactly `geode-pdf-worker://bundle/worker.mjs` from a dedicated handler in
the application session. Extend the existing one-time pre-ready scheme
registration. Enable only demonstrated required scheme capabilities, beginning
with standard/secure handling; add fetch support only if the module-worker proof
requires it. Do not enable CSP bypass, service workers, extensions, or disable
web security. Do not change Web Viewer or artifact session policies.

The handler accepts only GET and the exact canonical request URL, with no
credentials, port, query, fragment, encoded aliases, alternate host/path or
directory mapping. It returns the one built worker bundle from a fixed internal
path or immutable bytes. It never derives a disk path from a request, redirects,
proxies requests, or serves vault content. Reject all other requests. Test the
handler's received URL boundary explicitly; Chromium may normalize authored URLs
before invoking a handler, so do not claim rejection of spellings it never sees.

Successful responses carry JavaScript MIME type, `nosniff`, and:

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'
```

The script origin can serve only that exact immutable bundle, so `self` does not
open a general asset namespace. Bundle static PDF.js imports into that entry;
there are no lazy script chunks. Keep JavaScript string evaluation blocked while
allowing required WebAssembly compilation. Explicit `worker-src 'none'` prevents
descendant workers rather than falling back to `script-src`. Authorize only the
fixed worker endpoint in the parent renderer's worker policy; preserve existing
required application worker behavior without broadening its connect/script rules.

Keep `nodeIntegrationInWorker` false and the actual-global readiness/version
handshake. A failed handshake, CSP, asset or WASM setup has no fake-worker or
privileged renderer fallback. Disable XFA and exclude PDF scripting modules.
PDF.js 6.4.299 has no effective legacy `isEvalSupported` option; do not cite an
ignored option as evidence. Use supported error propagation (`stopAtErrors:true`)
and fixture checks so codec failure is not reported as successful missing content.

### Acceptance and risks

Before document/view implementation relies on this boundary, demonstrate in the
locked Electron build, including its packaged file-origin parent:

- The exact URL starts a real worker, reports the pinned version, and exposes no
  process/require/Buffer/window/document/Geode/Electron/IPC capability. Parent web
  security stays enabled. Verify the returned CSP and successful WASM compilation.
- A test-only probe under the same response policy and realm, using native
  browser APIs rather than the asset shims, cannot fetch local/HTTP resources,
  connect to a synthetic WSS endpoint, import foreign code, create a descendant
  worker, or evaluate JavaScript strings. Verify denied operations and absence of
  network/server side effects; a timeout or a shim rejection alone is insufficient.
  Test probes must not add production URLs or message-evaluation hooks.
- Protocol tests reject unknown method/host/path/query/fragment inputs; production
  handler inventory proves there is one served resource and no request-path I/O.
- Exact packaged bytes load for CMaps, fonts, QCMS/profile and image codecs.
  Synthetic CMYK/JBIG2/JPX fixtures render expected content; unavailable/corrupt
  WASM produces a visible failure. Cancellation terminates the worker and leaves
  source PDF bytes unchanged.

The riskiest assumption is that Electron accepts this module worker from the
existing file-origin parent and enforces its response CSP without an origin/CSP
bypass. If that proof fails, stop this approach and return to the separate
sandboxed-document option; do not relax security to make startup pass. This
protocol is desktop transport only. Other hosts need equivalent verified worker
loading or an explicit unsupported state. These prerequisites do not establish
PDF or Obsidian parity.

Primary references: [Electron protocol registration and session scope](https://www.electronjs.org/docs/latest/api/protocol),
[CSP worker response policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy#csp_in_workers),
and [CSP3 WebAssembly and worker directives](https://www.w3.org/TR/CSP/).
Source evidence: local locked PDF.js 6.4.299 display/worker distributions and
existing application/artifact protocol registration; no Electron run by the architect.

## Addendum: move PDF display into a fixed Node-free document

**Date:** 2026-10-15
**Status:** Proposed for root acceptance; isolation proof precedes feature implementation

The engineer's locked Electron 42.10.0 proof could not start the exact protocol
module worker from the file-origin application. The handler received no requests,
with web security enabled, Node in workers disabled and the parent worker policy
explicitly admitting the endpoint. This rejects the preceding bootstrap approach;
it does not justify an origin/CSP bypass. The separate file-worker proof showed
Node-free globals, but did not supply the required independent browser policy.

### Options considered

| Option | Benefit | Tradeoff |
|---|---|---|
| Fixed cross-origin viewer iframe with its own same-origin worker (recommended first proof) | Smallest portable DOM surface; shared text selection/toolbar/embeds; separate response policies | Must prove subframe has no Node/preload and custom-origin worker/policies work |
| Dedicated sandboxed WebContents/guest session | Stronger explicit Electron preferences/permission controls | Larger guest attachment, messaging, focus and embed integration; desktop-specific |
| Disable web security or expose the parser through the trusted renderer | Avoids bootstrap work | Violates the accepted security boundary; rejected |

### Recommended boundary

Serve a closed application-resource origin, for example `geode-pdf://viewer`,
with exactly four GET resources: `/index.html`, `/viewer.mjs`, `/worker.mjs` and
`/viewer.css`. Keep the exact URL/method and fixed-byte response rules above;
unknown resources never resolve through a directory, network proxy or vault.
Bundle PDF.js display and worker imports, styles and allowlisted binary assets.
No dynamic JavaScript fallback modules or arbitrary query parameters are served.

The existing trusted host embeds the fixed document in an iframe. Its sandbox
allows scripts and same-origin only: the latter preserves the viewer's own origin
for a same-origin module worker, and does not make the custom origin equal to the
file-origin host. Do not allow forms, popups, downloads, top navigation or storage
access grants. Set Node integration in subframes/workers false and expose no
preload to this document. Do not claim an Electron process sandbox merely from
the iframe sandbox attribute. Prove the actual frame/worker globals and cross-
origin DOM boundary; move to the dedicated guest option if those cannot hold.

The viewer owns the PDF.js display layer, selectable text, accessible toolbar,
document/page/render tasks and its worker. Keeping display inside this document
also prevents PDF-derived drawing/text work from needing the Nodeful host realm.
PdfView, Reading, Live Preview and Canvas host only this same component; do not
create separate parsers or transfer executable HTML/canvas commands to the host.

The viewer response CSP starts with default-src none, script-src self (no
unsafe-eval), connect-src none, and worker-src admitting only its exact worker
endpoint. Keep child/frame/object/base/form actions denied. Serve CSS from self;
permit inline style declarations only if the actual PDF.js text layer requires
them, with a documented fixture proof. Permit only demonstrated needed internal
blob/data font/image sources; never remote or file sources. The worker response
keeps the preceding restrictive policy including wasm-unsafe-eval and worker-src
none. The parent admits only the fixed viewer frame endpoint, preserving its
other required frame/worker behavior. All capabilities remain narrow and explicit.

### Private message contract

The host captures vault/file/session identity, obtains bounded authorized PDF
bytes, and creates a separate owned transfer buffer. Initial readiness must match
the exact viewer WindowProxy and custom origin, a fresh unpredictable instance
nonce and protocol/build version. Transfer a private MessagePort to that exact
origin; subsequent messages use only the port and captured generation. No wildcard
target-origin fallback, generic method invocation, script/string evaluation,
filesystem path, resource URL, IPC or plugin API is exposed.

Use a small versioned schema: host load(bytes, initial page/height), disposal and
explicit supported view controls; viewer ready, normalized page/count/zoom state,
bounded error and disposal acknowledgement. Validate types, lengths, page/pixel/
byte limits and request generation on both sides. Unknown messages are ignored or
fail the session. Viewer events never authorize host I/O. Source paths need not
cross the boundary; a bounded display filename is text only. No message evaluates
content or opens a link automatically. P1 can keep external PDF actions explicitly
unsupported; a later navigation bridge must require an actual host-side user
activation and existing navigation policy, not trust a claimed gesture message.

### Lifecycle and required proof

The host registers the component under its native RenderScope before handshake,
read or mount. Close, navigation, root/file change or iframe reload invalidates
the generation, closes the port and asks the fixed viewer to destroy loading,
render/text tasks and worker before removing the iframe. Await acknowledgement
with a bounded timeout; removal/termination is the fallback for this read-only
isolated component, never permission to retire unrelated writers. Reject every
late state/error message. A fresh frame cannot inherit the old port/session.

Before wiring the product UI, run the fixed packaged-resource proof with the real
Nodeful file parent: frame and worker globals lack Node/bridge APIs; the viewer
cannot read its parent's DOM or APIs; the same-origin worker starts; returned
document/worker CSP headers are enforced; actual WASM and synthetic PDF text/page
rendering work. Native fetch/XHR/WSS/import/eval/subworker probes must demonstrate
denial and no external side effects beyond permitted fixed resources. Prove forged
source/origin/nonce/port/generation messages cannot load bytes or invoke the host.
Require repeated mount/dispose, delayed read/render, reload and cancellation with
no obsolete worker/messages; keyboard/text selection/focus work in an embed.

The riskiest assumption is the precise Electron subframe/worker security behavior
under a Nodeful parent. If the proof fails, return the dedicated sandboxed guest
choice for root acceptance. No implementation may weaken web security, add an
arbitrary bridge, or claim PDF parity to bypass this gate. This addendum changes
the isolation transport, while keeping the original authorized-byte, read-only,
shared-viewer and partial-P1 product scope.

### Accepted handshake clarification

The accepted implementation direction uses a host-initiated handshake to avoid a
child-to-file-parent message with a wildcard target origin. The host captures the
iframe's WindowProxy and owner generation. On load, it sends a fresh nonce,
protocol/build version and a private MessagePort to the exact viewer origin. The
viewer validates the actual source is its parent and the exact parent origin
observed in the browser proof, accepts one initialization only, and returns
readiness over that transferred port. The host checks nonce, version and its
captured generation; reload invalidates the old port. No child window message,
wildcard target, guessed file-origin string or generic host capability is needed.
This remains conditional on the actual fixed-document isolation proof.
