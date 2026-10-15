# Unused private desktop image receipt bridge

Status: Accepted by coordinator on 2026-10-15 under the authorized reversible overnight goal after QA review. Implementation proceeds in reviewed test-first phases; phase1 semantic RED must be reviewed before registrar GREEN/main registration. No product consumer activation.

Task: https://compass.rbcodelabs.com/rb-code-labs/geode/tasks/56393a32-9c33-4461-9f20-f79a9a4bbb51
Parent: dbc2a50a-9344-4992-8d37-b7227cd2dc2e. Solution: a305ef82-0d46-473a-a18f-057ba6a67cb7.
Base: PR396 `3e0ad3ff6f09ba91575df44ff6a9056dbb9c8585`; branch `feat/overnight-image-desktop-bridge`.

## Contract source and boundary

ADR0050 proposed contract supplement R2 is the normative proposal, preserved byte-exact alongside this spec as `image-desktop-bridge-adr0050-proposed.md`. R2 supersedes its earlier illustrative wire section. Coordinator acceptance of the receipt direction is not final implementation approval. The existing six-family proof uses injected prepared bytes; it does not prove this bridge.

This package would install an unused private desktop capability only. It excludes ImageInspectionSession adapter changes, App/Reading/LP/Lightbox consumers, UI, parser/resource installation, resolver epochs, public SDK exports, mobile/browser implementation and new dependencies. Actual main/preload registration is the proposed scope requiring final design acceptance. One logical receipt per window deliberately blocks competing reads until finish; this is unsuitable for enabling multiple views without a later window-wide ownership decision.

## Exact proposed private API

New shared module `src/shared/image-resources-wire.ts` defines R2 request/reply/failure discriminated unions and strict validators. It has no Electron, Node, renderer or parser runtime imports. Six MIME literals and the existing canonical `MAX_IMAGE_BYTES` bound must remain aligned without importing main/fs into renderer. If the constant needs relocation, move the exact existing value to this shared module and preserve the reader export; no increased bound.

Proposed host types (all names private, no SDK export):

```typescript
interface ImageResourcesHost {
  read(request: ImageReadRequest): Promise<ImageReadReply>;
  cancel(request: ImageCancelRequest): Promise<ImageRetireReply<"cancel">>;
  finish(request: ImageFinishRequest): Promise<ImageRetireReply<"finish">>;
}
// HostServices:
readonly imageResources?: ImageResourcesHost;
// Electron-only preload API:
imageResources: ImageResourcesHost;
// Portable GeodeApi: imageResources optional; omitted on other hosts.
```

`ImageReadRequest` is exactly `{version:1,operation:"read",id,root,path}`. Cancel/finish requests are exactly `{version:1,operation:"cancel"|"finish",id,root}`, separately typed per method. ID is 64 lowercase hex characters; root/path are 1–4096 UTF-16 units without NUL. R2 gives exact envelopes, closed codes/messages, ordinary data-object validation, six MIME types and bounded diagnostics. `read` returns bytes or explicit error envelope; cancel/finish return exact retired outcome or error envelope. No rejected invoke becomes a successful ACK.

Preload `api.imageResources` forwards only three fixed channels, never arbitrary invoke. `ElectronPreloadApi` includes this optional member; `createElectronHost` exposes it only when all three validated methods exist. Missing/partial capability stays absent, with no fallback bytes or generic vault read. A private host bridge validates outgoing requests and every response's operation/ID/shape/ArrayBuffer/MIME/size before interpretation. Malformed replies or transport failures permanently seal that bridge instance and surface bounded private errors. They do not claim main is physically sealed. No session adapter automatically consumes these methods yet; direct contract tests explicitly finish receipts.

## Main ownership and proposed files

One engineer owns the additive changes in `src/main/main.ts`, `preload.ts`, host contracts and electron-host after collision review. Put behavior in focused modules, leaving existing native App close/shutdown logic untouched:

- `src/main/image-ipc.ts`: versioned read/cancel/finish registrar, stable-window shared physical slot/receipt/seal, bounded outcomes and atomic owned-channel installation/rollback. Retain reader and shared uncertainty semantics.
- `src/main/image-document-authority.ts` (new): one actual BrowserWindow-owned document state and disposer, installed before first load; it survives registrar churn. Factory takes the actual window, expected app URL and trusted session lookup; no renderer authority.
- `src/shared/image-resources-wire.ts` (new): exact schemas/validators/fixed diagnostics and private bridge types.
- `src/main/main.ts`: additive provider/registrar ownership and lifecycle calls only. Provider checks actual known BrowserWindow object, its WebContents/current main frame, live document epoch, exact `sessions.get(win.id)` object, unchanged positive generation and root. Request root is only a comparison. No numeric-ID-only grant.
- `src/main/preload.ts`, `src/renderer/host/contracts.ts`, `electron-host.ts`: optional private capability above. Extract validation glue to a new private host helper if needed; no consumer wiring.
- Corresponding unit/registered-route E2E files and design/QA docs only. No package/test timeout/skip changes proposed.

Document state starts unavailable. On actual main-frame cross-document `did-start-navigation` using installed Electron42.10 details fields, synchronously replace opaque epoch and stop admission before async retirement. Same-document navigation preserves this document epoch, as R2 specifies. Crash/destroy also invalidate. Rearm only after an actual successful main-frame navigation to the captured exact trusted application URL, matching the current pending navigation/epoch and current non-detached live frame; failed/provisional/cancelled navigation stays unavailable. Do not rearm on timer, arbitrary URL, did-stop-loading alone or old completion. Installed API/event ordering must be proven in actual Electron before claiming correctness. Existing deprecated positional metadata invalidation listener is preserved, not rewritten.

Vault replacement invalidates old generation synchronously, starts exact receipt cancellation/finish and waits/refuses while old stable slot/receipt drain remains. Main-owned retirement consumes clean obsolete receipts without requiring old renderer acknowledgment. It never deletes live physical state or sticky seals. Window destruction/shutdown stop admission and await owned reads/continuations; no timeout certifies settlement. Repeated disposal returns the same promise/outcome and aggregates cleanup/removal failures.

R2 linearization is mandatory: install physical slot and receipt before reader invocation; capture cancel synchronously and share one promise; finish sets finishing synchronously, cancels pending read and snapshots prior cancel; reject later cancel with RECEIPT_FINISHING. Set terminal once after actual descriptor close and before readDone; delete only exact captured object identity. Keep no bytes/error graph/history in completed receipts. Genuine old cleanup uncertainty seals the stable window across session/registrar changes; ordinary stale errors do not seal replacement state. Clean failed reads are finishable. No unlimited retired-ID replay guarantee.

## Test-first sequence and actual acceptance

Before implementation, obtain root plus image_bridge_qa design clearance. Preserve meaningful assertion RED, distinguish missing-module scaffolding. Write schema/error/receipt tests first, then controlled actual-FS held barriers and authority lifecycle controls, then actual registered preload IPC evidence.

Required controls include both read/cancel orderings; clean failed read consumption; finish-before-read and cancel/finish ordering; duplicate operations; stale continuation against newer equal-ID receipt; old genuine close uncertainty sealing replacement; two-window independence; partial handler registration rollback; unregister with held/completed receipt and repeated failure; exact authority capture and callback mutation resistance. Preserve primary plus close diagnostics with fixed redacted wire values. No arbitrary sleeps or weakened assertions.

Actual Electron must exercise the registered main-frame preload route for all six immutable encoded fixtures and reject actual subframe/foreign sender before I/O. Verify reload, same-process navigation, back, same-document and failed navigation document lifetime ordering with installed runtime. Mocks are not registered-route proof. Artifact runner must bind fresh commit/run/source/preload/bundle/fixture hashes and retain raw event/order diagnostics; root reviews exact profile before a pool job. Final own types/full units/build/full Electron and independent source/security/artifact review are required before PR. Existing parser/native proof cases remain unskipped; no inferred parent totals.

## Collision snapshot and one-owner proposal

Fresh open-PR file snapshot and changed-hunk reads on 2026-10-15:

- PR394 is this stack's inherited image-ipc foundation; no other bridge implementation Task exists under the Solution.
- PR364, “QR pairing for mobile sync setup”: main registerIpc adds pairing handler + before-quit callback; preload adds pairing capability and portable facade omission. This overlaps registration/shutdown and optional preload facade seams, not image receipt state. Preserve its ownership; do not port or rewrite its hooks.
- PR302, “compose guest onBeforeSendHeaders through one pipeline”: main session-created HTTP header pipeline only. Same file, separate functional subsystem; do not alter that listener or introduce webRequest registrations.
- PR290, “split history ledger persistence into per-identity SQLite”: main device-state handlers, preload optional history methods, HostServices and electron-host history adapter. Same optional-capability insertion seams; preserve all methods/fallback policy without copying it for image security.
- PR391 changes metadata/indexer authority relevant to later resolver epochs, outside this package.

`threads_list` shows PR364 verification thread idle/reviewed; no current thread explicitly owns PR302 or290. The active image-lifecycle thread is this parent operation. Absence from the roster is not ownership transfer or an atomic lock. Proposed root-assigned single owner: metadata_delivery for only additive image-specific imports/registration/document lifecycle/optional capability in this new branch. Recheck live PRs/threads and agree exact shared hunk ownership before code; no edits to other worktrees, no silent port/merge/rebase. Full diff/privacy review must distinguish shared-file composition from tested pinned-base results.

## Current checkpoint

Docs-only preparation; no implementation, tests, jobs, product registration or enablement. PR396 same hosted run remains separate. This spec does not mark its Task complete and does not claim Obsidian parity.

## Pre-code precision appendix

### Bridge promise ownership

`createImageResourcesHost(preload.imageResources)` is the proposed private validation/memoization factory, called once by createElectronHost. It owns at most one live request record `{id,root,readPromise,cancelPromise?,finishPromise?}` plus a sticky local failure. Install that record before invoking preload.read. A different read is refused until clean finish; no historical map. Exact duplicate cancel/finish share the original promise while that record remains, after local request validation. Finish first drains its issued cancel, then invokes preload.finish exactly once. Retain the last finish promise in the same bounded record until the next admitted read, so ordinary duplicate finish after completion returns its original outcome; wrong IDs reject. On a next read replace only the clean consumed record. No memoized result can authorize a new main receipt or strengthen replay guarantees. An admitted clean failed read still requires explicit finish. No automatic finish in synchronous release, no session adapter. Host read errors remain exact validated error envelopes; aggregate failures during explicit finish are surfaced by the bridge's private failure type without discarding the read's diagnostic. Main and renderer memoization remain separate authorities.

### Conservative completed-document rearm

Proposed initial safe policy: main explicitly starts a trusted load attempt with monotonically local attempt identity, expected `pathToFileURL(indexPath).href`, and a captured new opaque epoch; the document owner is attached before invoking win.loadFile. Associate the actual main-frame cross-document start with that still-current main-owned attempt. Rearm only when that exact loadFile promise fulfills AND current attempt/epoch remain identical, no intervening failure/start/crash/destroy occurred, webContents.getURL and current live/non-detached mainFrame.url equal the exact expected application URL, current frame object and process/routing identity equal the successfully committed actual main-frame event, and actual main-frame finish was recorded for that attempt. Main-frame pending-event identity/order must be proven on installed Electron; if association is ambiguous, remain unavailable. Completion from an older attempt cannot rearm a new one even with identical URL/frame.

Unowned renderer reload/back/loadURL events always invalidate and remain unavailable until a fresh explicit main-owned trusted load/rearm attempt. Same-document navigation preserves epoch, but exact trusted URL checks may conservatively refuse altered fragments until restored; no transparent recovery promise. Actual tests must assert this conservative refusal as well as initial valid application rearm. This avoids treating did-stop-loading/URL equality alone as authority. If product requirements demand transparent reload/back capability availability, return that refinement for architecture review before changing this policy.

### Real registered-route harness design

Proposed dedicated unskipped Electron E2E launches the actual application/main/preload using synthetic vault/profile and no image UI consumer. It exercises `window.geode.imageResources` and createElectronHost's optional bridge. Main-owned test instrumentation wraps actual ImageReadIo to count/open/hold only synthetic fixture paths; it cannot mint or bypass production authentication. The normal application startup records document-owner installation before its actual first win.loadFile and actual registration; assertions compare those sequence events, not a helper-only recreation.

For real subframe rejection, use a test-only preload running with nodeIntegrationInSubFrames enabled in a separate synthetic test window, explicitly expose a narrowly fixed invoke in that frame, and call the actual production registered channels with real senderFrame. Such a window is not entered in the trusted application registry; zero OS opens proves foreign-window denial. A second test-controlled iframe in the actual registered application window must invoke the real channels from an actual child senderFrame (via Electron frame execution in isolated world with a test-only fixed-channel preload seam); missing preload is not an accepted refusal oracle. The exact mechanism must be reviewed and fail closed if Electron cannot supply it without altering application production preferences. Any test-only window/preferences/preload must be separately labelled and hashed; actual normal main-frame positive runs keep production preferences. No production security flags or generic invoke API added to enable the test. This child-invocation mechanism remains a pre-code feasibility/review item, not claimed implemented.

All actual route assertions bind reader counters and event sender/frame/window identities in main. The renderer cannot self-report zero I/O. Held FS barriers and teardown use finally release; no global process kill or false successful shutdown. Actual main startup and navigation evidence must be part of final gate, not replaced by standalone schema/unit evidence.

## Registered child fixture: exact test-only launch seam (preferred revision)

This replaces the earlier appendix's unresolved child-invocation proposal. Root and QA accepted the evidence split; source implementation is still held. Comparing a production factory extraction/third-argument seam with a test-only build variant, prefer the variant: no production factory export, test preference parameter, bootstrap refactor, renderer toggle or registry injection is necessary. A factory extraction would touch the large main closure and its lifecycle dependencies solely for test reachability.

### Proposed exact files and launch boundaries

- `scripts/run-image-bridge-proof.cjs`: builds/owns two sequential Electron launches and fresh terminal/report/source hashes. First launches actual ordinary `dist/main.js` with normal production preload and no child preload; all-six positive route evidence and startup placement belong here. Second launches separately hashed `dist/image-bridge-negative-main.cjs`, built from actual `src/main/main.ts` with the single reviewed preference addition below. Existing relative __dirname/indexer/preload/index.html paths are unchanged.
- `scripts/image-bridge-proof/build-negative-main.mjs`: esbuild Node/CJS/electron-external variant using the normal main build settings. Its main-only onLoad transform asserts the exact existing BrowserWindow webPreferences anchor occurs ONCE, then adds exactly `nodeIntegrationInSubFrames: true,` in that existing preferences object. It fails on zero/multiple anchors, wrong source hash or any unexpected changed line. Archive original and transformed source, exact patch, metafile and bundle hashes. No exports or startup body changes.
- `scripts/image-bridge-proof/bootstrap.cjs`: test-only Electron main bootstrap installs real-fs observation wrappers and registers the fixed child preload after app readiness but before importing the negative variant. It then imports that variant and allows its normal app.whenReady/registerIpc/createWindow/loadFile path to run. No direct createWindow/registerIpc invocation, sessions access, provider replacement or ad hoc trusted map. The normal launch uses the same observation bootstrap without preference transform or child preload; its production main/preload bundle bytes are archived unchanged.
- `scripts/image-bridge-proof/child-preload.cjs`: fixed narrow test-only transport, registered with `session.defaultSession.registerPreloadScript({type:"frame",filePath})` before negative app import. It exits for main frame or nonmatching synthetic child URL. Its real child ipcRenderer invokes only the three literal image channels with fixed synthetic read/cancel/finish requests. No generic invoke/ipcRenderer or callable bridge is exposed. Diagnostics use synchronous console observations collected from the actual frame.
- `tests/fixtures/image-bridge/child.html`: owned non-about:blank same-origin synthetic child fixture. Main provider/session/expected application URL are unchanged; only this child's URL is synthetic.
- `tests/e2e/image-registered-bridge.spec.ts` plus strict report/runner unit controls: later unskipped owned launch/terminal validation, subject to profile review. No tests are written in this preparation checkpoint.

Production implementation filenames/signatures remain those already proposed above: optional imageResources.read/cancel/finish, main registrar/document owner and real main provider; no production factory signature changes. Test builder transforms preferences only. Neither build configuration nor package entry/production preferences changes. Both launches use the actual main closure/factory/registry/open-vault/session initialization and same production provider/handlers. The negative variant's ordinary automatic app window IS the registered fixture, rather than a handcrafted BrowserWindow inserted into a map.

### Registered authority and child causal controls

Both launches open the synthetic vault through ordinary renderer startup/production preload openVault, which invokes the real open-vault handler and constructs the actual VaultSession/watcher/indexer state. Never fabricate the session object or replace sessions.get. Normal launch proves all six exact fixture bytes/headers and actual optional host bridge. Negative launch proves its actual main-frame read/finish immediately before child requests, then valid main-frame read/finish afterward. During a retained valid main receipt, child cancel/finish must reject and leave that receipt intact.

The negative registered window creates an iframe with the owned non-about:blank child URL. Fixed child preload uses its own ipcRenderer. Main-side actual event evidence must show sender===registered window.webContents, senderFrame.parent nonnull, senderFrame!==current mainFrame, and otherwise current real window/session/root/document. Production provider returns AUTHORITY_UNAVAILABLE before any reader/OS open; zero-I/O counters are main-owned, not renderer self-report. Parent function proxying/missing preload does not satisfy this oracle. Failure to reach the actual handler is fixture failure.

Record both getLastWebPreferences snapshots and require only the configured nodeIntegrationInSubFrames delta. All other production defaults, actual preload, contextIsolation, nodeIntegration, sandbox, webSecurity and expected indexURL remain unchanged. The negative launch broadens transport reachability only and is explicitly labelled; it is not production child-preload availability proof. Normal positive runs have no registered child preload.

### Actual filesystem and authentication observations

Bootstrap wraps real Node fs/promises methods before main import, forwarding original receiver/arguments and actual return values. Scope counters/fault barriers to the exact synthetic raster root/files only; unrelated application reads forward untouched. Wrap actual returned file handles with forwarding stat/read/close methods. Record redacted fixture-relative paths, opaque operation tokens and ordinal events. Barriers: read entered/returned, close entered/release; injected close rejection occurs only after actual owned close and is labelled fault injection. No mocked reader/provider or replacement ImageReadIo result is accepted. Restore wrappers only after all owned drains. Confirm bundling uses the wrapped actual fs module identity; if wrappers fail to intercept, fail rather than infer zero calls.

Authentication evidence can observe Electron ipcMain's actual handle registration in the test bootstrap: wrap handle to log only the three exact channels and wrap their registered callback to record actual event identities and bounded returned envelopes, forwarding the original event/input and callback result unchanged. No invented authority observer or handler-map direct invocation. The production authority predicate and its registry lookups remain unchanged; main-frame positives bracket rejection. Test wrappers are not installed in shipped code and cannot alter production registration policy. Callback throw/rejection is preserved, not converted into refusal success.

Startup placement uses runtime observations on the unchanged ordinary bundle, not a production source injection. Proposed document-owner export is `installImageDocumentAuthority(win, expectedApplicationUrl, sessionForWindow): ImageDocumentOwner`, with owner methods `capture(event)`, `retireSession(session)`, `loadTrustedApplication(load:()=>Promise<void>)`, and `dispose():Promise<void>`. `sessionForWindow` is main's closure over the actual sessions registry and is never test-supplied. The installer attaches named internal callbacks `imageDocumentNavigationStarted`, `imageDocumentNavigationFinished`, `imageDocumentProcessGone`, and `imageDocumentDestroyed` to the exact known lifecycle events before returning; their names are private test-observation identifiers, not capabilities. The capture result is the immutable actual frame/document/session identity snapshot used by registrar; it grants no renderer token. loadTrustedApplication owns the explicit attempt/rearm policy above.

Test bootstrap observes listener registration through a forwarding wrapper on the actual EventEmitter/WebContents registration method and BrowserWindow.prototype.loadFile, before importing main. It logs only those four exact callback names/events against actual WebContents identities; the ordinary startup assertion requires all four real listener registrations on its actual window before that window's first actual loadFile invocation. Source review additionally confirms initialization precedes those registrations and createWindow calls the returned owner before loading. Record listeners present through the actual webContents.rawListeners(event), not a synthetic callback count. Callback invocation/result/current predicate are never replaced. If installed Electron bypasses these forwarding observation methods, fail and return a bounded observation proposal rather than adding an unreviewed source transform. No bundle/source changes are required for normal positive observation.

Bootstrap owns only its launched process/windows; finally releases all held barriers, drains production image service shutdown, unregisters only the fixed test preload and removes its own observers. No global kill, generic production invoke/debug flag, test authority callback, exported session map or fabricated registration. The owned runner must retain failure artifacts and source/patch/preferences/fixture/preload/runtime bindings.

### Remaining pre-code decision

Root must approve the exact test-only preference transform, named document-owner lifecycle API and runtime observation wrapper plan after this source-read specification. No production factory extraction/argument change or observer alias is proposed. The normal bundle bytes and factory/session/expectedURL/provider remain unmodified by test instrumentation. All wrapper behavior must be separately hashed and forwarding-only, with collection guards proving actual interception before accepting any counters. No implementation or actual runtime evidence is claimed.

## Accepted refinements and phase1 checkpoint

Root accepted this spec, ADR0050 R2 and QA refinements on 2026-10-15. The exact original proposed ADR copy remains unchanged as provenance. Actual last preferences must differ ONLY by nodeIntegrationInSubFrames in the separately labelled negative launch; implicit other deltas fail. Actual FS positive open observation must precede a zero-I/O denial claim. Actual rawListeners registration must precede first loadFile. Production preload can also execute in the synthetic child under broadened preferences; the report must label this instead of claiming only the fixed probe ran. No consumer/adapter/UI/resolver activation is included.

First phase isolates receipt semantics against the existing registrar with its original unversioned shape, avoiding premature version admission masking the behavior. Separate new wire tests record missing-module failures as scaffold-only, then use an explicitly incomplete module scaffold for meaningful shape assertion RED. No main/preload registration or registrar implementation changes before root reviews actual behavioral RED and full test diff. Existing cleanup/currentness/slot test assertions remain present. Heavy remote profiles require review before submission.
