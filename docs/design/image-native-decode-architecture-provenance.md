# ADR-0049: Separate pending native decoder from published presentation in the private proof adapter

**Date:** 2026-10-15
**Status:** Architect recommendation accepted for this bounded proof-adapter direction; coordinator/root acceptance and independent implementation review still required. No product enablement or native-success claim.
**Scope:** scripts/checker/test-only delta, based on reviewed foundation a027 and preserved failed six-family proofs8991/f38. No src/, IPC registry, preload authority, UI, dependencies or queue mutation.

## Context and evidence reviewed

Read the complete updated `/private/tmp/geode-image-native-decode-lifecycle-options.md`, actual native-helper.ts and accepted foundation image-session.ts/shared cleanup contract. Read raw-native report in root-verified4d81 archive, job01M50EG52Y888YJ6N2RP073VXD. TinyPNG visible decode and all four no-source-removal combinations fulfill; all four source-removal combinations remain pending at the2s observation boundary. This is a bounded Electron42.10/Chromium148 Linux --no-sandbox observation, not permanent nonsettlement or proof for all six codecs.

The failed helper aliases pending decode and published presentation in one image field, appends it before native settlement, then clears src synchronously on retirement. The session correctly waits actual decode and cancellation cleanup, so observation timeout cannot be treated as settlement. Foundation is injected/private and has no actual product decoder adapter.

## Options

| Option | Advantage | Cost |
|---|---|---|
| Detached immutable pending decoder, promoted only after actual settlement/currentness check | Keeps exact native Promise as admission barrier; synchronous presentation removal remains real | Pending private source remains until actual settlement; must prove cleanup for every admitted format |
| Replace pending source with invalid/empty source | Might provoke rejection | New request/update race, not supported by raw evidence; needs separate characterization |
| Different decoder API / cancellation architecture | Potential explicit resource boundary | Larger compatibility/resource scope; unnecessary before minimal adapter experiment |
| ACK/timeout/synthetic settlement | Easy progress | Rejected: violates actual settlement and concurrency invariant |

Recommend first option and updated memo's exact cancel-owned deferred cleanup path. This is an explicit change from immediate source clearing on the pending private decoder. It preserves synchronous clearing of any published presentation. Do not call it unchanged lifecycle semantics.

## Concrete ownership and ordering

Keep separate exact-request records for decoder and presentation, not a single mutable global image slot. Decoder record captures requestID, URL, element, original native Promise, immutable source, observed outcome/dimensions, retired state and an exactly-once cleanup result. Capture record in every continuation. Do not resolve cleanup through whatever request is currently active.

A fresh detached element receives its own URL once, then calls native decode once. The adapter may return an observer Promise that transforms actual native settlement into dimensions; it must retain and independently log the ORIGINAL native Promise outcome. No observer/presentation/cancel Promise is evidence of native settlement. Record dimensions before clearing source. Promotion to presentation occurs only after actual settlement and the session's existing currentness checks; no second element/request/decode is introduced. Reentrant close during publish must leave no stale connected presentation.

On retirement, synchronous hide/clear/release affect the published presentation only. A pending detached decoder is marked retired and retains its source and exact Promise; presentation-clear telemetry must not falsely imply that this source is already absent. Revoke the exact URL once using existing ownership. Revocation is not cancellation or settlement.

The exact captured cancel acknowledgement waits the request's actual native fulfillment OR rejection, then clears that decoder source/listeners and releases reference using one idempotent cleanup operation. Native rejection is recorded and may be consumed by the cancel observer solely to proceed with cleanup; the separately returned decode observer still preserves its actual outcome. No unhandled rejection and no circular wait: cancel waits native settlement directly, not session close, entry.done, or an adapter decode Promise that itself awaits cancel. Session continues to await BOTH actual decode observer and cancel acknowledgement before next admission/close completion.

After native settlement without pending retirement, decoder remains until immediate publish or normal retirement. On ordinary decode rejection, session retirement synchronously invokes release on an already-settled decoder, so source-clear/release exceptions enter the existing session cleanup-error path. On pending retirement, cancel owns deferred cleanup and returns existing `{kind:"cleanup-uncertain",error}` on failure. Existing session recognizes that tag and permanently seals. An Error subclass rejected from decode ALONE does not seal the accepted foundation and cannot substitute for this path.

Critical interleaving: native settled flag is true, but Promise observers/currentness/publish have not run yet. Synchronous retirement must recognize this as already settled, clear once and prevent promotion. If native settlement has not yet been observed by the owned record, pending cancel path must remain owner until it observes actual settlement. Both converge on the same one-time cleanup result. Duplicate release/cancel must not perform another revoke or overwrite prior cleanup failure with success. Keep a sticky failure result per record until session cleanup consumes it; do not null a record before publishing its cleanup result.

No permanent adapter-global latch is required if all deferred cleanup is exclusively cancel-owned and ordinary settled cleanup exceptions route through synchronous retirement. If implementation instead performs deferred cleanup inside decode, it must explicitly solve failure propagation/sealing before review; silently ordinary-recoverable decode rejection is blocking.

At most one admitted decoder plus its presentation role exists. Obsolete A remains owned until settled/cleaned; B is superseded and never reads; C starts only after A actual decode plus cleanup/ACK settle. If native does not settle, admission remains blocked and fixed outer proof deadline fails/cleans the owned process. No growing retired-image list or timeout-success.

## Required adversarial evidence

- Meaningful controlled RED tests on the actual revised adapter helper: pending clear preserves exact decoder src while no presentation is attached; close/next read blocked until explicit controlled native settlement. Controls are not native proof.
- Both fulfillment and rejection while retired; ordinary corrupt rejection followed by valid recovery; close after settlement but before publish; currentness/close reentry inside publish; before-decode close; duplicate release/cancel; A→B→C.
- Source-clear, listener-release and revoke failures: exact captured cancel uncertainty tag or synchronous release throw seals session and blocks C. Native reject plus cleanup failure must preserve both causes without unhandled rejection. A later duplicate cleanup cannot clear a stored failure.
- Ledger differentiates decoder-source-retained, presentation-clear, native-settled, decoder-source-cleared, listeners-released, reference-released, cancel-ACK and admission. Assert no decoder src mutation before native settlement; exactly once URL revoke; no publish after retirement; cleanup before close/next read. Missing presentation is explicitly recorded as absent, not a fabricated element clear.
- Fresh actual native PNG/JPEG/GIF/WebP/BMP/AVIF positive/pre-decode/pending-close/fresh revoked-URL negative using unchanged bytes/dimensions. All six pending original native promises must actually fulfill/reject within UNCHANGED owned120s aggregate. Timing cap only fails observation; never settles work.
- Retain original failed8991/f38 artifacts/assertions, raw4d81 evidence, actual source/bundle/preload/fixture identities, natural dimensions, network/frame/image cleanup and observed owned process cleanup. Independent exact-SHA review before heavy submit and full delivery gate before PR readiness.

## Consequences and limits

We trade immediate pending-decoder source removal for immediate published-presentation retirement and proven eventual source clearing after actual settlement. Revoked blob URL may remain referenced by the private pending decoder until that boundary. This does not establish OS/heap/GC reclamation, active expensive decode cancellation, animation, every backend, resource peak, app-window authority, main/preload registration or Lightbox UI.

Riskiest assumption is that detached immutable-source native decode settles across all six admitted families in the supported runtime. If any actual family remains pending, preserve no-enable and revisit decoder architecture; do not loosen fixtures, skip a family or manufacture settlement. Another revision trigger is inability to propagate asynchronous cleanup uncertainty through the exact existing cancel contract without cycles or per-request aliasing.

No code/tests/jobs were changed or executed for this architecture review. Root may accept the proof-only direction under existing reversible authorization, then engineer performs test-first isolated implementation and independent review. No product source change is justified by the failed proof adapter.

## Additional peer conditions incorporated

A pending detached decoder has never been a published presentation. Its close proof must assert actual `isConnected === false`, zero publication, and exact retained src until native settlement; a no-op presentation-clear assertion alone is vacuous. A separate already-published successful decode close proves synchronous visible hide/source-clear/detach. Both roles need actual observations.

Cancel before native admission has no native Promise to await. Mark exact request retired, complete any actual reader cancellation and release already-owned resources; never allocate an image just to satisfy cleanup. If createURL occurred but decode did not, revoke it once without inventing decode settlement. Exact-ID currentness and no decode/publication after that cancellation remain required.

A never-connected detached decoder is a new setup relative to raw4d81's connected-then-detached cases. The raw diagnostic supports the hypothesis but does not verify this setup. Fresh all-six actual native proof is mandatory before accepting it as workable.

Cleanup failure must be sticky and deny next admission: ordinary settled failure reaches synchronous session cleanup throws; pending failure reaches captured cancel cleanup-uncertain tag. Preserve that failed cleanup result until observed; duplicate cleanup cannot turn it into success. A per-adapter permanent failure latch is acceptable as extra proof-local fail-closed enforcement, but cannot replace verification that the session receives uncertainty through its existing accepted paths.
