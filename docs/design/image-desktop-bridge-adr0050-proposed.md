# ADR-0050: Exact image read receipts across filesystem completion and native decode

**Date:** 2026-10-15
**Status:** Proposed — recommendation for root review; no product integration approval
**Scope:** Private desktop main/preload/host capability only. No UI activation, Reading/LP hooks, resolver epochs, public API, mobile support or source implementation.
**Trace:** Solution a305ef82-0d46-473a-a18f-057ba6a67cb7; parent dbc2a50a-9344-4992-8d37-b7227cd2dc2e. This document is a design artifact, not authoritative Compass delivery state.

## Context and success boundary

The accepted six-family proof shows native decoder retirement on injected prepared bytes. It does not exercise registered IPC. Main currently removes ActiveRead in its read handler finally; cancel requires that exact active record. Renderer ImageInspectionSession.retire can invoke cancel while decode remains pending after read completed. Wiring these unchanged would turn normal close into cleanup failure. Catching every cancellation rejection would instead conceal authority loss or descriptor uncertainty.

Constraints: one actual OS read per stable BrowserWindow; uncertainty survives registrar/session replacement; exact main-frame/session authority; no unbounded request history, timer-based settlement, extra dependency, renderer-minted root authority or cloned Error prototype assumptions. Done means the real registered main-frame bridge proves both orderings of cancel/read completion with correct errors and unchanged OS-slot truth. Native decoding still settles independently. Browser/mobile capability remains absent/Unsupported.

## Options considered

| Option | Advantages | Cost / failure boundary |
|---|---|---|
| Adapter skips cancel after known read completion; main keeps one latest completed tombstone | Smallest happy-path change | An in-flight cancel can arrive after another client read replaces the tombstone. Requires a proven single window coordinator and strict admission ordering; that coordinator does not exist. Eviction must fail closed, so routine close can still fail. |
| One bounded main-owned read receipt retained until explicit retirement, separate from the OS slot | Exact completion races remain recognizable; independent clients cannot evict needed evidence; bounded state | Adds an explicit asynchronous finish operation and logical admission backpressure until receipt retirement. Existing synchronous adapter.release cannot implement it. |
| Keep strict active-only cancel and seal on every rejection | No contract change | Routine decode-stage close becomes a permanent failure. Reject as intended product behavior. |

## Proposed decision

Recommend the second option for the first real bridge package. A read receipt is private bookkeeping, not a filesystem or renderer publication capability. Retain at most **one receipt per stable actual BrowserWindow**, in addition to its existing active OS slot and sticky uncertainty. Do not silently extend the meaning of existing active-only cancel. Introduce explicit versioned internal read/cancel/finish schemas and update their private tests. Root must approve this delta before implementation.

### Receipt states and operations

A receipt captures exact request ID, actual window/WebContents, main-frame/document identity, VaultSession object, generation and canonical root. No byte payload is retained in completed receipts. State is reading → settled, with a cancelled bit and immutable terminal outcome. A terminal outcome records clean success, clean read failure, cancellation/staleness, or cleanup uncertainty. The physical read finally frees only the OS slot. The logical receipt remains until finish. No completed history, timeout eviction or renderer-generated lease token besides the existing 256-bit request ID is necessary.

**Read:** authenticate and validate all input before any I/O; refuse if either physical slot or logical receipt remains, including a different session's unsettled slot. Install ownership before invoking the reader. Store terminal outcome before exposing the wire reply. Reader close errors seal the stable window before any next admission. Failed pre-admission validation creates no receipt.

**Cancel:** authenticate first; require the exact retained receipt and captured authority. An active receipt is marked cancelled and the handler awaits its actual read done; an exact already-settled receipt returns that actual terminal classification. The ACK means only main read retirement and its close outcome, never native decoder completion. A clean completed read is an explicit completed-race response, not an ignored error. Cancellation does not delete the receipt. Concurrent duplicate exact cancels share the same terminal result while retained. Foreign IDs, roots, frames and sessions still fail closed; no missing-record success. No future read can replace evidence while a legitimate cancel is in flight because finish is serialized after those operations.

**Finish:** a separate asynchronous exact-ID operation acknowledges consumption of the receipt after read settlement and all issued cancel invocations have been drained. It waits for a still-active OS read, never frees a live slot, returns the sticky terminal cleanup status, then removes only a clean logical receipt. Repeat finish after removal is stale and rejects; the trusted adapter memoizes the exact original finish Promise so normal duplicate disposal does not issue another operation. Uncertainty remains sealed, even if bookkeeping is cleared during internal shutdown. Reject a different receipt ID without affecting either state.

The future production session adapter needs an explicit **awaitable host finish hook** after native settlement, independently of synchronous presentation release. Do not hide IPC in today's synchronous release or use fire-and-forget finish to admit the next session entry. This is a deliberate private lifecycle-interface delta requiring root review and regression tests; it is not already proved by ADR0049. If root limits the next package to installing an unused capability, finish can be tested directly there, with actual session adaptation a subsequent package.

### Authority and lifecycle

Main builds authority from its real known BrowserWindow registry and VaultSession. At admission and every filesystem currentness check require: actual non-destroyed window and WebContents; event.sender exactly that WebContents; senderFrame exactly its actual current main frame; same captured document/navigation lifetime; sessions.get(win.id) exactly captured session; positive unchanged generation and unchanged root. The request root is a comparison value only. No subframe, guest, numeric-ID lookup alone, renderer-supplied generation or external-root attachment grants image authority.

Same-process main-frame navigation may preserve frame object identity. Therefore actual document lifetime must be invalidated synchronously on top-level cross-document navigation/reload before another document can use the old capability, and before publishing a result. Pin and verify installed Electron navigation APIs before implementation; object identity alone is insufficient. Same-document navigation policy must be explicit and tested; conservative invalidation is acceptable. A trusted preload cannot repair main authority validation.

Vault replacement first invalidates the captured session generation, retires/cancels its receipts internally, and drains old physical reads. New session admission cannot bypass an old stable-window slot. A clean settled obsolete receipt may be removed by **main-owned rotation**, since no old renderer/session is authorized to acknowledge it; late old cancel/finish then rejects authority. Internal rotation never removes a live OS slot or sticky uncertainty. New registrar shares stable-window receipt/slot/seal storage and cannot mint a new key.

Window destruction likewise invalidates authority and internally drains held reads. Application shutdown stops admission, removes owned handlers, waits actual read completion, and preserves/aggregates removal and cleanup failures. No successful shutdown timeout can certify a hung read as settled. Renderer disappearance cannot make an uncertain close clean. Main must have a stable disposer owner installed once; repeated disposal returns the same outcome. Cross-window operations stay independent.

### Wire contract and diagnostic preservation

Use exact plain structured versioned discriminated envelopes for read success, clean read failure, cancelled/session invalidation, cleanup-uncertain, and cancel/finish terminal classifications. Success validates actual ArrayBuffer, positive bounded size, exact six MIME allowlist and expected response operation/ID. No extra properties, getters, unexpected prototypes or implicit truthy tags. Do not trust instanceof after Electron structured cloning.

Define bounded diagnostics with fixed codes and phase (admission/read/close/authority/transport), sanitized bounded message and bounded primary/cleanup entries. Preserve a read primary plus descriptor-close failure as distinct ordered entries. Arbitrary stacks, absolute vault paths and error object graphs are not wire data. Truncation must carry an explicit count/truncated flag; cleanup uncertainty remains an independent mandatory flag, never inferred from text. A malformed reply, transport failure or missing exact outcome is a bridge failure, never completed-race success. Sticky uncertainty wins over an ordinary decode/read error, while retaining the primary diagnostic locally. No uncertainty reply admits a new read.

Renderer cancellation remains the conjunction of main retirement and original native Promise retirement. Synchronous presentation hide/clear/revoke precedes awaiting both; detached private decoder source retention follows ADR0049. Neither operation awaits the other through a cycle. Native decoder failure is not automatically descriptor uncertainty; bridge/cleanup uncertainty seals the window session and blocks later intents.

## Adversarial test matrix before any integration claim

1. Real registered main-frame preload reads six MIME replies; actual bytes/headers bounded. Subframe, guest, foreign window, destroyed sender, top-level reload/navigation, root/session mutation fail before I/O.
2. Held actual filesystem barriers: cancel before read settles; read settles before cancel arrives; cancel during native decode; cancelled read's primary error plus close failure. Assert physical slot remains until actual close settlement.
3. Completed receipt cannot be evicted by a second caller/new ID. Foreign cancellation cannot mutate it. Duplicate exact cancel shares terminal classification; duplicate adapter finish shares its original Promise; stale post-finish IDs reject.
4. Finish before read settles waits; finish racing cancel must drain all issued cancel operations under trusted adapter ordering; hostile out-of-order finish cannot permit an unsettled read to overlap. Document hostile duplicate/reuse behavior; no claim of unlimited old-ID replay history.
5. Session replacement/registrar rotation with held read retains stable window slot; late uncertainty seals replacement. Clean completed obsolete receipt rotates only internally. Two independent windows progress separately.
6. Main-frame document replacement with same frame object invalidates receipt. Actual event ordering verified on installed Electron, not a fabricated frame mock alone.
7. Malformed envelopes, wrong ID/version/operation/MIME, oversized/empty buffer, cloned Error objects, missing primary/cleanup entries and unexpected cleanup tags fail closed. Read+close diagnostics both survive round-trip.
8. Handler second-registration failure and rollback failure retain original ownership and aggregate errors. Repeated shutdown/disposal has identical failure; no new I/O during drain; no timeout releases a slot.
9. Native pending fulfil/reject plus cancel ACK in either order never publishes obsolete content or admits next intent early. Finish failure cannot be hidden in synchronous release. Existing all-six original promise and cleanup-failure regressions remain unchanged.

## Source/caller evidence and ownership

Read actual private source at tested015254; current tree HEAD3e0ad3f differs only docs/design/image-decoder-six-family-proof.md. src/main/image-ipc.ts active-only cancel and slot removal in finally are the race; its module WeakMaps already retain stable physical slot/seal across registrar instances. src/main/image-resource.ts closes the file before returning and wraps primary+close failures in ImageCleanupUncertainError. src/renderer/image-inspection/image-session.ts retire calls cancel for unfinished session entries, including decode-stage; run awaits read, decode, then cleanup; adapter.release is synchronous. scripts/image-decoder-proof/native-helper.ts uses prepared bytes and proof-owned cancel lifecycle, so its native success does not establish IPC cancellation semantics.

main.ts VaultSession/sessions around305–324 and open-vault around805–854 supply actual authority and already invalidate generation before old indexer shutdown. preload.ts currently has no image channels. Host contracts/electron-host have no image capability. The inspected PR391 commit0d94760 changes indexer/metadata-cache and tests, not main/preload; later resolution epochs nevertheless overlap its semantic ownership. Do not copy old cache behavior. Comparison of reviewed015254 to recorded mainb2bb2de shows no changes in the five main/preload/App/host seam paths, but this is a recorded commit comparison, not a fresh remote ownership check. Root must recheck live PRs and native App shutdown work before assigning shared source ownership. No code, tests, jobs, network messages or provider state changed by this task.

## Consequences and risks

The bridge becomes bounded and explainable at the cost of a receipt-finish handshake and explicit async adapter completion. A renderer which disappears without finish blocks that window until trusted main lifecycle retirement; this is preferable to evicting required authority evidence. The riskiest assumption is that one logical receipt per window is an acceptable first integration concurrency boundary. If independent simultaneous image views are required, revise to a separately approved bounded capacity/lease design rather than silently growing a map. A proven window-wide coordinator with ordered cancellation could justify revisiting the smaller tombstone option. This ADR must be revised if Electron document-lifetime checks cannot enforce the stated ordering.

## Proposed wire precision for implementation review

Use version 1 and exact operation-specific shapes (illustrative data contract, no implementation): read request `{version:1,id,path,root}`; cancel/finish request `{version:1,id,root}`. IDs remain exactly64 hexadecimal characters; root/path remain1–4096 characters. Read success `{version:1,operation:'read',id,kind:'bytes',mime,bytes}`; read non-success `{version:1,operation:'read',id,kind:'failure',failure}`. Cancel/finish return `{version:1,operation,id,kind:'retired',outcome,failure?}`, with outcome exactly `completed`, `cancelled`, `read-failed` or `cleanup-uncertain`; failure is mandatory for the latter two and forbidden for completed. Invalid authority/request remains an explicit typed failure without a forged successful retirement. Any operation lacking a valid request ID can return a fixed validation failure without echoing attacker data; adapter validation treats that as failure, never as exact receipt proof.

Failure is bounded to code enum + cleanupUncertain boolean + at most4 ordered diagnostic entries, each a fixed phase/code and sanitized message at most256 characters, plus omittedCount. Main preserves complete original errors locally when appropriate; the bounded wire must retain at least one primary and one cleanup entry when both exist. Exact code enum and redaction helper are implementation-review requirements, not permission to serialize arbitrary errors. The maximum byte limit must reuse MAX_IMAGE_BYTES from the canonical reader rather than inventing a larger bridge limit. Malformed envelopes seal the renderer adapter and fail the current operation; they cannot establish that the main window itself is physically sealed without an actual main uncertainty outcome.

A completed receipt contains no ArrayBuffer, path history or original arbitrary Error object graph; retain bounded diagnostics and captured current authority only. Current stable sealed-window errors are a separate pre-existing concern and must not be weakened by receipt minimization. A private capability package can introduce/verify this contract without wiring ImageInspectionSession; subsequently adapting that session requires an async host-finalization hook and the native/IPC combined matrix above, not an implicit change to synchronous presentation release.

# Contract supplement R2 — exact bridge and main linearization

**Status:** Proposed; root accepted receipt/awaitable-finish direction only. This supplement supersedes the illustrative wire precision and any earlier ambiguous race wording. No implementation approval is inferred.

## Exact version1 data contract

Channels are private `image-resources-read`, `image-resources-cancel`, `image-resources-finish`. All objects have ordinary Object.prototype after cloning, enumerable own data string keys exactly as listed, no symbols, accessors or extra keys. Arrays are ordinary dense arrays. No Electron event or object is returned.

Requests:

- Read: `{version:1, operation:'read', id:string, root:string, path:string}`.
- Cancel: `{version:1, operation:'cancel', id:string, root:string}`.
- Finish: `{version:1, operation:'finish', id:string, root:string}`.

Root/path are1–4096 UTF-16 code units, contain no NUL, and pass the existing canonical reader admission; ID is exactly64 lowercase hexadecimal characters. Uppercase may be normalized only by the ID generator before sending, not accepted by the wire validator. This is a proposed tightening of private IDs, not an existing proof claim. version/operation must match the channel.

Replies are exactly one of:

- Read success: `{version:1, operation:'read', id, kind:'bytes', mime, bytes}`. Actual ArrayBuffer, positive byteLength ≤ existing MAX_IMAGE_BYTES, no typed-view substitute. MIME is exactly image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif. Main reader header admission is still required; bridge MIME validation does not replace it.
- Operation error: `{version:1, operation, id, kind:'error', failure}`. operation matches the channel; id is the syntactically valid submitted ID or null for invalid/missing ID. No successful ACK is generated for invalid authority or missing receipt.
- Cancel/finish success: `{version:1, operation:'cancel'|'finish', id, kind:'retired', outcome:'completed'|'cancelled'|'read-failed'|'cleanup-uncertain', failure}`. failure is null for completed/cancelled, mandatory for read-failed/cleanup-uncertain. Every key, including failure, is present. Successful read has no outcome field; read failures use the error envelope.

`failure` is exactly `{code, cleanupUncertain:boolean, diagnostics:Diagnostic[], omittedCount:integer}`. Diagnostic is exactly `{phase, code, message}`; phase is admission/read/close/authority/transport/lifecycle, message is a fixed sanitized message from the code table, at most256 UTF-16 code units. Never copy filesystem messages/stacks/paths or arbitrary renderer strings. diagnostics has1–4 entries; omittedCount is a safe integer0–65535, saturating at65535. Preserve primary first and at least one close/cleanup entry if both exist; extra omissions increase omittedCount. Full errors can remain main-local under existing logging/privacy rules. Cleanup uncertainty is independent of message and survives truncation.

Closed code enum and fixed messages:

| Code | Fixed message | Primary phase |
|---|---|---|
| INVALID_REQUEST | Invalid image request. | admission |
| AUTHORITY_UNAVAILABLE | Image authority is unavailable. | authority |
| RECEIPT_BUSY | Previous image receipt is not retired. | admission |
| READ_BUSY | Previous image read has not settled. | admission |
| NO_MATCHING_RECEIPT | No matching image receipt. | authority |
| RECEIPT_FINISHING | Image receipt is finishing. | lifecycle |
| SERVICE_STOPPED | Image service is stopped. | lifecycle |
| UNSUPPORTED_IMAGE | Unsupported image resource. | admission |
| READ_FAILED | Image read failed. | read |
| READ_CANCELLED | Image read was cancelled. | read |
| AUTHORITY_CHANGED | Image authority changed. | authority |
| CLEANUP_UNCERTAIN | Image cleanup is uncertain. | close |
| HANDLER_CLEANUP_FAILED | Image handler cleanup failed. | lifecycle |
| INVALID_REPLY | Invalid image host reply. | transport |
| TRANSPORT_FAILED | Image host transport failed. | transport |

Unclassified reader errors map to READ_FAILED; do not classify by message text. Canonical header admission can retain a private typed UNSUPPORTED_IMAGE code or conservatively map untyped failures to READ_FAILED. A read+close failure has top-level CLEANUP_UNCERTAIN, cleanupUncertain=true, and diagnostic entries READ_FAILED then CLEANUP_UNCERTAIN. Exact clean cancellation is READ_CANCELLED with false; stale authority is AUTHORITY_CHANGED with false unless a close failed. Any cleanupUncertain=true result has top-level CLEANUP_UNCERTAIN. Transport/invalid-reply failures are adapter-local error objects built from the same bounded shape, not forged main retirement replies.

No fallback from thrown IPC error to an ACK. Main catches owned handler execution errors into the validated envelope when possible; transport rejection, lost sender or serialization failure remains adapter failure. The adapter validates every correlation/shape before interpreting outcome. A malformed main reply seals that adapter; it does not prove main itself has been physically sealed.

## Main event-loop linearization and bounded state

There is one stable per-window state object, owned outside registrar instances: physicalSlot?, receipt?, stickySeal?. Receipt includes immutable request/authority capture, readDone, terminal?, cancelled, finishing, and a bounded count/set of accepted cancel operation continuations. Main callbacks execute their admission prefix synchronously, without await or user callback, before any reader work. Capture object identity for every later continuation; every state deletion or ordinary result write checks exact object equality. Do not hold a global mutex across an OS await, which would prevent cancellation from reaching a held read.

1. **Read linearizes at receipt installation.** Authenticate the document/session, validate input, reject stopped/sealed/busy, then install receipt and physicalSlot together before reader invocation. A clean read failure still has an admitted receipt and consumes the logical slot. A validation/authority/busy failure before installation does not. Receipt terminal is installed exactly once after actual read/descriptor close, before resolving readDone and before replying. The physical slot is removed only if it still equals this receipt's physical operation. A stale old result never clears a newer physical slot.
2. **Cancel linearizes at accepted-operation capture.** Validate fresh authority and exact retained receipt; reject finishing. Record this operation and set cancelled synchronously before await. If already terminal, return its unchanged outcome; clean success becomes completed, clean read failure read-failed. If pending, await readDone. No terminal outcome can be rewritten by a late cancel; cancellation after completed read does not retroactively change successful read bytes. Each continuation references only its captured receipt, not the current window receipt. Duplicate accepted cancels are bounded by sharing one memoized cancel Promise per receipt, not allocating history per invocation.
3. **Finish linearizes at finishing=true.** Validate exact current receipt and authority; mark finishing synchronously. If read is pending, also set cancelled so its bytes cannot newly publish. Snapshot the one accepted cancel Promise, if present; no later cancel is accepted. Await readDone and that captured cancel Promise, then return terminal outcome and remove only this exact clean receipt. Clean read-failed/cancelled receipts are consumable exactly like completed receipts; they do not permanently block the window. Cleanup uncertainty returns its explicit failure and leaves stable window sealed. Receipt metadata may then be discarded by internal cleanup, never the seal.
4. **Cancel-before-finish:** accepted cancel is included in finish drain even if its IPC delivery response has not reached renderer. Finishing cannot await transport delivery, only owned handler completion. Trusted adapter separately awaits its own issued cancel Promise before invoking finish.
5. **Cancel-after-finish-start, before removal:** returns RECEIPT_FINISHING; no mutation of cancelled/terminal/slot. The trusted adapter must not issue this ordering. Hostile calls fail closed; a rejected hostile cancel need not prevent exact owner finish. **Cancel-after-removal:** NO_MATCHING_RECEIPT, or NO_MATCHING_RECEIPT against a new different ID; no effect on new work. **Finish-after-removal:** same strict missing-record rejection. Adapter memoizes finish to avoid routine duplicate wire calls. Concurrent duplicate finish while same receipt is finishing returns the captured original finish Promise only after exact authority/receipt validation; it does not allocate another finalizer.
6. **Late errors:** ordinary old read/cancel/finish errors may affect only their captured operation/receipt. They must never seal a replacement merely because an ID no longer matches. A genuine old descriptor cleanup uncertainty is the deliberate exception: seal the stable actual window even after session/registrar rotation, preserving that real owned failure. No late continuation can delete a different receipt or overwrite a newer seal with success.
7. **Replay bound:** no unlimited historical ID registry. Trusted adapter generates fresh cryptographic IDs. A malicious same-document caller can reuse a previously retired ID; the bridge makes no global replay-detection claim. Every accepted operation is bound to the current receipt/authority, so an already-accepted old continuation cannot mutate a new receipt even if ID strings collide. If stronger cross-retirement anti-replay becomes a requirement, add a separate main-issued generation/lease design; do not claim existing IDs alone prove it.

The adapter consumes clean failed reads too: once read outcome is known and any issued cancel drained, await finish even when no native decoder was created. Preserve the original clean read failure after successful finish; aggregate bridge cleanup failure with the primary when finish fails. A structured cleanup uncertainty seals immediately; never clear it after a nominally successful finish. The unused-capability package tests finish directly and does not pretend today's synchronous ImageSessionAdapter.release satisfies this contract.

## Main-owned document lifetime: installed API verification

Verified installed candidate worktree Electron **42.10.0** package and electron.d.ts: did-start-navigation details includes isMainFrame/isSameDocument/frame, WebFrameMain has isDestroyed() and detached. Root checkout node_modules is42.4.0, so do not cite it as the candidate version. Official pinned42.10 docs distinguish document/in-page navigation and note will-navigate omits programmatic navigation. [Electron42.10 webContents](https://raw.githubusercontent.com/electron/electron/v42.10.0/docs/api/web-contents.md), [official WebFrameMain API](https://www.electronjs.org/docs/latest/api/web-frame-main). No runtime ordering proof was run here.

Install one main-owned document state per actual BrowserWindow **before initial loadFile/loadURL** and keep it across registrar replacement. State includes opaque epoch object, ready=false/true, captured actual main frame and expected trusted application URL. On main-frame did-start-navigation with isSameDocument=false, synchronously replace epoch, set ready=false, invalidate captured receipt and start internal retirement. Same-document events preserve epoch for this unused capability; later resource resolver/source epochs remain a separate authority and must handle their own changes. Top-level render-process-gone/destroyed likewise invalidate; frame access throws, frame.isDestroyed(), detached or null senderFrame fail closed. will-navigate alone is insufficient. Current main.ts already has a did-start-navigation metadata-reader invalidator using deprecated positional arguments; add a separate owner listener using installed details fields, do not replace or weaken existing behavior.

Rearm ready only on a verified completed main-frame trusted application navigation, matching currently expected navigation/epoch and current frame, followed by actual main-frame admission checks. During provisional navigation failure/cancellation remain unavailable; restoring old document authority requires a newly verified application lifecycle rearm, never a timer or unconditional did-stop-loading. Any design requiring transparent recovery from cancelled navigation is a later refinement. Verify actual loadURL/reload/back/same-process and failed-navigation ordering with the installed runtime before marking this integration proven. The unused package tolerates conservative unavailability. No renderer-supplied epoch is accepted as main authority.

Vault rotation separately invalidates old generation synchronously before asynchronous old-service shutdown. Internal drain sets cancelled and finishing for old receipt, waits actual readDone and accepted cancel operations, removes only matching clean receipt; new session waits/refuses while physical or receipt drain remains. Old renderer wire calls always fail fresh authority, even if its receipt is retained internally. Late cleanup failure seals the stable window. Internal retirement needs no old renderer acknowledgment.

Unregister first synchronously sets registrar stopped and invalidates admission; remove only owned channels and retain removal errors. It internally retires every receipt it owns, including already completed clean failures, awaits physical read and accepted cancel/finish continuations, then removes only captured matching clean records. A replacement registrar sees stable shared slots/receipts/seal and cannot bypass a drain. Its document listeners are window-owned, not destroyed/recreated by registrar churn. Full window-service disposal removes listeners only after admission stopped and drain started; repeated disposal returns the same Promise/result. Channel-removal failure does not leave a captured handler capable of I/O. Aggregate handler removal and real cleanup failures; no timeout or forced success.

## Crisp next implementation boundary

The next unused private desktop capability may change only private registrar/shared wire schemas, actual main window/session/document provider, preload exposure, optional desktop HostServices/electron-host bridge, and corresponding contract/lifecycle/registered-route tests/docs. Main is single designated owner after a fresh collision check. Preserve existing native close/App source; no new App/Reading/LP/lightbox owner, no actual ImageInspectionSession adapter, resolver epochs, public SDK export or mobile/browser implementation. Private optional host method names and exact types must be in the engineer's reviewed spec before code.

Acceptance requires meaningful RED tests first for both completion-race orderings, clean-failed-read consumption, finishing-order rejection, stale continuation versus newer receipt, real old cleanup failure sealing replacement, unregister with completed receipt, and main document epoch invalidation. Then real Electron registered main-frame/preload round-trip plus real subframe/foreign rejection, controlled held-filesystem barriers, response schemas/all six MIME families and preserved primary+close diagnostics. Native combined session tests belong to the subsequent adapter package, whose scope must explicitly approve the async finalization hook. No registered-route success means no bridge proof; private mocks alone do not suffice.

One logical receipt per window intentionally serializes all future Reading clients, even after OS read completed. An undisposed owner could starve another view until main lifecycle retirement; there is no timer eviction. This is acceptable for a first **unused** capability with no production consumers and explicit tests. It is not approval to activate several Reading clients against this contract. Before activation, root must choose/test a window-wide coordinator with latest-intent semantics or approve bounded multi-owner leases; route that decision separately. Existing per-view session behavior does not establish window-wide ownership.
