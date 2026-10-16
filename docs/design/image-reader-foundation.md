# Private raster reader/session foundation — concrete test-first plan

Reuses accepted [ADR0035](../adr/0035-image-lightbox-p1.md), [ADR0042](../adr/0042-image-lightbox-private-boundaries.md) and [ADR0043](../adr/0043-image-parser-execution.md), coordinator/architect acceptance and the independent QA strategy. Task `88fadf75-159f-4c16-a78e-90ec3cbb2055` is a child of Lightbox `dbc2a50a-9344-4992-8d37-b7227cd2dc2e`, linked to existing Solution `a305ef82-0d46-473a-a18f-057ba6a67cb7`. Branch `feat/overnight-image-reader-foundation` pins corrected parser `9f96317dc51a758d9bc926a188ead2fd9a7834d0` (PR392; Linux full artifacts accepted, hosted verification pending). No new Solution, dependency or public SDK API. Parser PR source stays frozen.

**Current status: documentation and test-case inventory only.** Coordinator's latest hold requires hosted terminal clearance before implementation. No reader/registrar/session source, tests or scaffold accompanies this plan. User authority covers reversible tested PR work; no merge, release, spending, destructive operation or external messaging is authorized.

## Exact first checkpoint

Implement only `src/main/image-resource.ts`, `src/main/image-ipc.ts`, optional internal HostServices imageResources contract/types, and `src/renderer/image-inspection/image-session.ts` plus tests/spec. NO main/preload/App/Markdown/Live Preview registration, parser packaging, metadata epoch sidecar, Reading/LP mapping, modal/controller UI or styles. Do not import unpublished PDF modules or add pdfjs dependencies: inspect their pattern only. Current other-owner mobile391 metadata-cache/indexer work is excluded. Real application-window registry integration remains a future step; injected authority tests are not product IPC proof.

## Proposed private interfaces

`readAuthorizedImage({root,expectedRoot,path,current,limit?}, io=actualFs)` returns `{bytes:ArrayBuffer,mime:SupportedRasterMime}`. `current` is supplied by the main registrar's captured authority, never by renderer data. Optional limit only lowers32MiB; nonfinite/noninteger/negative/too-small rejects before allocation. Narrow private I/O seam permits holding each awaited operation; default always actual filesystem. No public export via SDK. Real filesystem fixture positives and hashes accompany held-operation controls.

`registerImageReadIpc(ipc,authorityFor,read=readAuthorizedImage)` installs handlers ONLY when explicitly called; this package does not call it in main. Main-owned `authorityFor(event)` must reject unknown/guest windows and returns captured `{root,identity,current}`. Registrar independently checks current main frame, sender lifetime, exact captured identity/root and supplied schema. Return bytes+fixed MIME only; no URL or renderer-supplied authority. Read exact own keys root/path/id; cancel root/id; root/path nonempty<=4096, ID64hex. Inherited/nonplain objects refused. One WeakMap slot per sender/window across session/root/frame changes. Cancel marks only exact current active ID; never removes slot. Actual read finally settles slot; late bytes cannot publish. No completed-ID history, automatic retry or queue.

`ImageInspectionSession` (private class, no App import/registration) takes an injected adapter for read, scoped cancel, decode, create/revoke URL and presentation hide/clear/release. Intents capture stable view owner token plus file/Vault/root/snapshot/current predicate; only latest pending intent retained. One current native load/decode at a time. Unsupported missing capability returns an explicit state with zero legacy/network fallback. State updates are data/adapter callbacks, not actual modal focus or DOM integration.

Read/decode failures that actually settle are recoverable Error states; cleanup failures are separate retained terminal failures sealing admission. Invalidation marks obsolete and hides/clears/releases before awaiting. Request cancellation synchronously, then await read AND decode promises; never race a timer into manufactured settlement. Only after verified settlement admit latest pending intent. URLs created late are revoked exactly once; repeated close returns the same pending/rejected cleanup outcome. Cleanup errors preserve primary error identity too (AggregateError or equivalent explicit pair), not finally overwriting. No new epoch until close succeeds. Pure dimension helper rejects zero/nonfinite/unsafe dimensions and >64,000,000 pixels without large allocation. Injected decode promises establish state order only, not native decoder proof.

## Bounded header-family validator proposal

All accepted extensions remain PNG, JPEG/JPG, GIF, WebP, BMP, AVIF with fixed family MIME. SVG and all schemes/external roots remain unsupported; no narrowed enabled format subset. Validate actual bounded bytes, not extension alone. Exact signature/family checks include PNG signature+IHDR layout, JPEG SOI/marker prefix, GIF87a/89a, RIFF/WEBP with recognized VP8/VP8L/VP8X family, BMP header/DIB minimum, and AVIF first ftyp box with valid declared/aligned bounds and explicit avif/avis major/compatible brand. Do not accept arbitrary ISO-BMFF/mp4. Header admission does not claim a valid decode; corrupt-but-family-valid must remain a later recoverable decode error. Pin synthetic vectors and expected MIME/hash; architect/root review concrete validator choices before expanding them.

## RED order (each has a working positive control)

1. IPC before-I/O authority: exact schema/limits/ID; unknown/guest/subframe/missing/replaced mainframe/destroyed sender/wrong root/same-root new session. Reader count0 on refusal. Captured handler tests only, no actual registration.
2. Slot retention: deferred A read; B differentID busy; cancel A then session/root swap cannot admit B until A settles. Separate window independent. Wrong/stale/duplicate cancel cannot touch A/nextB. LateA success never returns bytes. Verify no completed-ID history.
3. Real-FS canonical boundary: full-byte/hash positive and all lexical/sibling-prefix/symlink/directory/root checks. Deterministically hold every awaited FS stage and invalidate authority; root/target replacement, dev/inode mismatch, same-size mtime change, truncate/grow and read failure. Close handle once, preserve primary+close failures.
4. Resource bounds/MIME:32MiB boundary, +1 refuse before allocating; request chunk<=65536; allocate at most observedSize<=32MiB and use separate one-byte overflow probe (avoid size+1 allocation above cap). Read at most observedSize+1. Malformed lower limits reject; six MIME families, wrong/truncated/disguised SVG/HTML/invalidRIFF/nonAVIF-ftyp controls. File bytes unchanged.
5. Session ownership/lifecycle: held read/decode->invalidate/close; rapidA/B/C onlyAthenC; exact same-file differentowner separation; source/root/file/snapshot changes; late URL/revoke-once; immediate presentation hide/clear; cancellation ACK does not release load slot; repeated/reentrant close coalesces and retains cleanup failure. No timeout success. Pure64M dimension arithmetic.
6. Focused GREEN/private independent security review; remote types/build/full units and relevant existing Electron gates before a tested foundation PR. Native decode evidence is a SEPARATE gate: six real supported-family fixtures, positive actualdecode before clear/cancel observations, fresh commit/run/hash binding, source/image unchanged. Tiny early-clear PNG/JPEG/WebP proof is insufficient. If middecode settlement cannot be proved, keep foundation unwired and return to architect, no narrowed format enablement/OS/GC claim.

## Ownership, review and stop points

Coordinator and independent architect/QA accepted this bounded plan; implementation is additionally held pending the current hosted parser gate. Check fresh Compass/PR/agent collisions, the linked child Task and isolated documentation branch now exist at9f. Foundation source implementation remains held until hosted terminal clearance. Preserve meaningful assertion RED; no catch-import scaffold remains at freeze. Use max1 local focused tests; heavy gates testq with root slot coordination. Product hooks need separate native frozen-base/plan/security approval; unsupported decoder behavior or new public interfaces return to architect. No merge/release/spend/destruction/external messages.


## Fresh ownership and collision checkpoint

Current parser head is9f. Other-owner PR391 remains at0d94760d8bc28ef390239c7e8b98682b7f470ff8 on the mobile metadata-storage branch. Its metadata-cache/indexer work is excluded; future real resolution-epoch integration must coordinate rather than overwrite it. Current delegated native prerequisite/navigation packages remain separate. Repeat collision checks before source implementation and publication.

Main's future authority provider must derive the current application window, exact live main frame and captured Vault session from the actual application registry; a renderer-provided root/current callback is never authority. Foundation tests inject that provider to exercise registrar behavior only. No product IPC authority or resource registration is established by this unregistered package.

All six raster MIME families remain required: PNG, JPEG, GIF, WebP, BMP and AVIF. Header-family admission only establishes bounded supported bytes and fixed MIME; it does not prove valid native decoding, cancellation during decoding, OS/heap settlement or decoder resource bounds. The actual six-family decoder proof remains a separate explicit gate before any enablement. A missing format proof leaves this foundation unwired; it does not silently enable a narrower format subset.

## Resumed implementation checkpoint

The documentation-only hold above records the original checkpoint. Hosted parser PR392 verification and mobile checks subsequently passed on frozen `9f96317dc51a758d9bc926a188ead2fd9a7834d0`; coordinator then resumed this accepted private scope. Current code remains unregistered and unwired. No main/preload/App/Markdown/Live Preview registration, modal UI, metadata epoch adapter, parser change or dependency accompanies the foundation.

The reader uses actual filesystem operations with canonical containment, root/file identity and metadata rechecks, bounded chunks and an exact-size output allocation plus a separate overflow byte. Successful reads recheck canonical root, root identity, target path and file metadata after the awaited handle close. These are point-in-time checks, not a universal atomic snapshot of a hostile filesystem. All six synthetic header-family vectors are admitted; these vectors deliberately do not establish valid native decoding.

Active read admission also lives in a module-private stable-window WeakMap, surviving replacement registrars while an old read or handle close remains unsettled. Originating completion releases only its exact entry. Independent windows retain separate admission; each registrar tracks and awaits only its own active operations. Repeated disposal cannot remove a replacement registrar's installed handlers.

### Explicit private cleanup uncertainty

`ImageCleanupUncertainError` in `src/shared/image-cleanup.ts` retains the original close failure and any primary read failure. The main registrar recognizes it in-process and retains one failure in a module-private WeakMap keyed by stable application-window identity. Session/root changes or registrar replacement cannot bypass that seal. Success remains bounded bytes and a fixed six-family MIME. Ordinary settled read errors remain recoverable rejections.

Both read and cancel handlers return `{kind: "cleanup-uncertain", error}` for a sealed authorized window, without starting further I/O. Registrar disposal removes handlers and awaits actual reads; it retains its first observed resource uncertainty as a failed repeated disposal outcome. Each uncertain window separately retains its complete original error. Disposal does not clear the seal or certify successful descriptor cleanup.

The trusted session adapter must explicitly map this read/cancel discriminant. It must never infer uncertainty from an error message or a cloned Error prototype. A future actual Electron/preload bridge must validate the reply schema and preserve this distinction; no such bridge or cross-process error-identity guarantee is implemented here. Injected authority and adapter tests are not actual product IPC evidence.

### Private session lifecycle

`ImageInspectionSession` binds a stable view owner and copies file, Vault, root, path and source snapshot authority for each intent. It generates a fresh64hex read ID. `invalidate()` is the explicit notification seam future source/navigation hooks must call synchronously: it hides, clears, releases and requests scoped cancellation immediately, then awaits actual read/decode settlement and the cancellation acknowledgement. Acknowledgement alone never releases the active slot. The latest pending intent may start after retirement; invalidation does not reopen a permanently closed session.

`close()` seals admission synchronously and retains its pending/rejected result through repeated or reentrant calls. Every owned URL has one revocation attempt, including URLs created during invalidation. Ordinary settled read/decode failures are recoverable. Resource or presentation cleanup uncertainty seals the session and preserves primary plus cleanup failures. Natural-pixel admission checks only arithmetic at64,000,000; no bitmap allocation or decoder memory bound is implied.

Authority callbacks may be reentrant: local ownership is checked again after the callback, and final settlement drains cancellation registered during that final check. A callback returning true cannot override a synchronous close/invalidation or manufacture read/decode/cancel settlement.

### Verification checkpoint and remaining gates

Meaningful assertion RED precedes each implementation boundary: initial IPC authority, partial-registration rollback, reader containment/await races, post-close mutation, initial session ownership/lifecycle, explicit invalidation, and composed cleanup-uncertainty propagation. Additional regressions preserve host plus presentation errors, registrar rotation during actual held handle close, and reentrant final-authority cancellation settlement. Current focused local verification:128 tests across four files pass, including incomplete-capability rejection before any read. This is a development checkpoint; independent source/security review, typecheck/build, full regression gates and final exact-source evidence remain required before a foundation PR. Native six-family decoder evidence and all actual product integration remain subsequent work.


### Synthetic header-family inventory

These exact test vectors were reviewed before reader GREEN. They are header-admission controls, deliberately not native decoder fixtures.

| Family | Bytes | SHA256 |
| --- | ---: | --- |
| png | 33 | `7a62e481c41f555352930feb61d703eb7b6225a82815d9aadf3dcc1e5f34b2ac` |
| jpeg | 6 | `fc16d7dcee9cae83ef3923222a81ccd8fe96c9d25fdb7f504d66f1011e0cd870` |
| gif | 13 | `e166f869cdc0a87f67fc5841ad08082c87d0ffa3c1d677956415ea3110e1fd3f` |
| webp | 26 | `ea3eb4f6b14361f4e7fc6f30196d9333b9989efaf2b06ef247f9fac2ac0af5b2` |
| bmp | 26 | `812e154fa935534f17f34c756bb00803d22c8d7717a82800e7e6eaad522cb93c` |
| avif | 24 | `5b456c9d667bfffe29cb898a91fa5e462c0b38b72970f769814c5fe05033571c` |

The mutable authority-provider regression additionally proves that in-place session/root/window changes and replacement of the original current callback cannot change captured admission or release another window slot. Captured method callbacks retain their original provider receiver.

## Own full verification of frozen source

Implementation and all tests froze at `a027ce9367c4a674bc35cee685c603f5b794f8d8`. The subsequent change to this note records evidence only; source/test bytes remain identical. Its own testq job `01M50C1YHV2QNB05P972M6TE5Z` passed all six steps on existing worker1: Node24.21.0/npm11.19.0, typecheck, complete ordinary units, build and complete Linux Electron. Unit results:345 files,5007 ordinary passes,1 existing expected failure and3 skips,195.72s. Electron:376 ordinary passes,1 configured-retry pass for existing NoteComposer Merge append and15 existing Linux conditional/fixture skips, accounting for392 tests,10.0min. The initial Merge Linker-bytes assertion failure is retained; this is not a flake-free result. No assertion, skip or timeout was changed for this gate.

All102 artifact sizes/SHA256 match manifest `44e796f80ae854de07c887a45eab5d0e44590085fa2685a771c9f04e37097c3c`. Engineer and coordinator separately fetched/reviewed the evidence. Fresh inherited parser native/stock reports bind the frozen commit and run UUID `2f8195c1-88b9-4d46-b78f-a6f469d9d4dd`, complete markers and failure-null. Native report SHA256 is `d63feb5f9d60b8043ce2ab7c5128b6d66ce74b5519d389a79c2d98424829507c`; stock report is `09568b77f5c5f4ee521738e072ceba328d89d98d858b2b8a1aa0466a071ae35e`. All19+5 source hashes match actual git blobs,12 served resources and host/stock bundles match their recorded hashes, all six complete300k fixtures retain full-source/count/marker-free oracles, and the54-sample owned-process guard reports no errors/cleanup uncertainty.

That inherited parser case passed26.3s on its first attempt. Its observed API cancellation acknowledgement and sampled owned-process cleanup do not prove image decoder/OS/GC settlement. Linux Electron uses `--no-sandbox`; no process-sandbox guarantee follows. The historical stock comparison still runs under its explicitly reviewed330s owned aggregate rather than its former5s unit deadline; no grammar speedup or unchanged5s coverage is claimed.

Independent source/security review covered all changed source/tests/docs and privacy, corrected pending registrar replacement and reentrant final-authority settlement, then cleared the mutable-authority snapshot follow-up. This bounded private foundation is ready for code review. Actual application registry/preload reply validation, six-family native image API evidence and all UI/product integration remain absent. It is stacked on the tested parser branch, with no latest-main integration, enablement or complete parity claim.
