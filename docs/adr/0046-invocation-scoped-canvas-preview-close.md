# ADR-0046: Invocation-scoped retirement of unchanged Canvas connection previews

Date: 2026-10-15. Status: Accepted by coordinator on 2026-10-15 under existing reversible tested-PR authority. Test-only actual diagnosis precedes implementation. Related accepted ADRs0037/0038/0040/0045. No source implementation, heavy jobs, merge or release.

## Problem and evidence

PR393 source b53 changes intentional ordinary Canvas close from cancel-preview/no provider write to synchronous refusal. Hosted phone/tablet both fail the existing mobile case at onClose;74 other cases pass. Keep that original expectation. Source constructor installs strict workspace readiness as scope preflight and settleWorkspaceLoad as prepare. The full forest preflight consequently refuses before closeNative can cancel the preview.

The only two transientGestureCancel assignments are connection creation and reconnect. Moves change SVG only; pointerup commits. However reconnect cancellation currently Object.assigns the saved edge and calls render(). Calling that function during frozen preparation is unsafe: render can replace native descendant projections and an old snapshot can overwrite newer state. Writeless cancellation needs its own verified non-rendering path.

Done means direct ordinary close removes the unchanged preview/listeners exactly once with no bytes/model/history change, after complete-forest refusal checks and freezing; every dirty gesture, draft, retained failure and implicit retirement remains guarded.

## Alternatives

| Approach | Benefit | Cost / reason |
| --- | --- | --- |
| Canvas boolean ordinaryClose flag across await | Few lines | Unrelated readiness/parent retirement can observe it; nested/reentrant calls ambiguous. Reject. |
| Invocation-scoped opaque context forwarded only to the requested scope's lifecycle callbacks | Explicit identity, defaults strict, no ambient authority | Small private RenderScope callback signature change and audited caller classification. Recommend. |
| Cancel before scope.close or relax mobile expectation | Small | Mutates before descendant refusal or abandons intended behavior. Reject. |

## Recommended private contract

Keep existing scope behavior default. Add optional opaque context argument to internal close(context?: object). Add optional context argument to ScopeOptions.preflightClose(context?: object) and prepareClose(context?: object); existing zero-argument callbacks remain structurally compatible. Do not change public View/SDK signatures. A close invocation stores its context in its immutable transaction closure, never on Canvas or scope as mutable ambient intent.

Only the invocation root receives its context. Recursive children receive undefined, including nested Canvas children. Generic prepareRetirement, assertRetirementReady, registry barriers, prepared destruction and ordinary contextless close always pass undefined. Thread the same root/context pair through initial whole-forest preflight, root prepare, and final post-validation whole-forest preflight. Scope callbacks cannot infer a reason from global state. Validate/destructor callbacks need no exemption/context.

Canvas onClose creates a fresh private per-call intent capturing this view/scope, file/model identity, exact serialized model, and current transient-preview record identity. Its callbacks accept the exception only when that exact object belongs to this requested scope and the record is still eligible. Context remains private to Canvas; arbitrary objects do not authorize it. Repeated onClose must join the already-established close transaction, never replace its authority. A contextless transaction already pending cannot be upgraded by a later onClose. A frozen scope/paused registry must not initiate a newly privileged direct close; preserve prepared destruction and existing cleanup behavior through contextless paths. Add explicit tests rather than relying on a timing flag.

Readiness refactor must be narrow: retain assertWorkspaceLoadReady unchanged/strict; extract or add private readiness used by callbacks that omits only the exact unchanged preview. All recovery/conflict/presentation/history/geometry/text-draft/touch-drag/pointer-state/persistRequested checks remain. Any active touch pointers are independently refused; do not equate a connection record with touchGesture state being safe. Retained scope write failures are still drained/rejected before preparation. Descendants always receive strict checks.

At root preparation, after forest preflight/freeze/drain, recheck complete captured preview/model identity and exact serialized model before any cleanup. If changed or eligibility is uncertain, refuse without rollback or cleanup. Dispose preview DOM/listeners only, clear its exact record, and mark finished so late pointerup/cancel are inert. Never Object.assign, render, persist or close descendants in this cancellation. Once cleared, run existing strict settlement and all ordinary preparation/read validation/final preflight phases. Its existing no-op-save behavior must be measured: do not claim zero provider writes merely because preview cancellation itself is writeless. Original fixture requires provider bytes unchanged; separate write-count evidence determines whether a stronger no-write claim is valid.

If later sibling preparation fails after cancellation, resume all owners per ADR0040; preview disappearance is an authorized ephemeral cancellation, never an assertion of undo/restoration. Drafts/model/provider bytes/connected descendant controls must survive. All started sibling work must settle. No generic failure acknowledgment or rollback is added.

## Caller audit and required classification

Actual reviewed callsites at A source:
- WorkspaceLeaf.detach workspace.ts577: ordinary requested close retains Canvas.onClose behavior. Existing dirty drafts still refuse.
- WorkspaceLeaf.setView workspace.ts214: replacement is implicit/destructive transition, must use strict Canvas renderOwner.close (or narrowly typed private implicit-close method), not grant ordinary-preview intent. Other view types unchanged.
- Markdown renderer disposeCanvases render.ts403: strict scope.close; no ordinary intent. Base dispose line395 unchanged.
- Markdown renderer failed Canvas initialization render.ts761: strict scope.close; no ordinary intent.
- Live Preview failed Canvas initialization markdown/live-preview.ts951: strict scope.close; no ordinary intent.
- App failed/replaced view cleanup app.ts4920: Canvas-specific strict cleanup; no ordinary intent. Audit full surrounding code for ownership before choosing helper.
- Generic ownership child.startClose(true), registry barriers and all prepareRetirement callers remain contextless.
- Direct mobile test view.onClose intentionally ordinary and stays unchanged. Direct trusted plugin View.onClose is also an explicit close request; raw plugin calls remain outside security isolation, as already documented.

Prefer a small private Canvas closeImplicitly() wrapper delegating renderOwner.close() where imports/cross-layer typing otherwise force Canvas knowledge; do not add to public View. Audit every Canvas construction/teardown occurrence and tests on final diff. No claim that onClose alone reveals user-event trust.

## Exact regression-first matrix

1. Preserve hosted original phone/tablet case and all existing bytes/zoom/scroll/relaunch assertions; exact2 selector and TestInfo before/after state.
2. Real CanvasView + real RenderScope: active unchanged reconnect and new connection ordinary close; exactly-once preview/listener removal, unchanged model/bytes/history, late pointerup/cancel inert. Capture provider call count separately.
3. Ordinary connection close plus nested Base draft, Canvas text draft, dirty geometry, touch drag, active touch pointers, history/presentation failure, conflict/recovery, suspended persistence: refuse before preview cleanup or any destructor; exact original controls/draft/model/bytes unchanged. Separate each refusal cause.
4. Retained parent and descendant writer failures: same pre-cleanup refusal; no failure acknowledgment. Explicit exact-key retry remains required.
5. Strict assertWorkspaceLoadReady, assertRetirementReady, prepareRetirement, registry barrier, renderer implicit cleanup and replacement setView refuse preview; no leaked ordinary exemption.
6. Held drain/validator: contextless parent retirement/reentrant close cannot inherit/upgrade ordinary intent. Repeated same ordinary close shares completion and cleanup once. Descendant ordinary close concurrently with ancestor preparation has deterministic refusal/join semantics, never cancellation through parent's undefined context.
7. During held drain mutate/reassign edge/model/file/preview or serialized geometry; prepare refuses without rollback/render/cleanup. Unchanged positive control proceeds. Late events after freeze cannot mutate the authorized model.
8. Sibling preflight failure leaves preview alive. Sibling prepare/validate failure after approved cancellation preserves descendants and waits all started tasks; genuine failure keys retained, no self-drain, no destructor started prematurely.
9. Prove cancellation never invokes render, Object.assign rollback, persist or DOM replacement. Keep ordinary pointercancel existing rendering behavior separately if needed; do not globally alter its product behavior.
10. Existing native forest phase-order/commit refusal/abort/idempotency tests stay intact. Full mobile, affected desktop, types/full units/build/full Electron on frozen correction, independent source/artifact review before PR claims.

## Risks and revision conditions

Riskiest assumption: callsites can reliably classify direct ordinary close versus implicit replacement; the method name alone is insufficient. If the caller audit cannot make that explicit without broad churn, use a private named ordinary-close method at actual tab-close boundary and keep onClose strict, but then preserve the existing mobile behavior through an explicitly reviewed compatibility route. Do not silently change its expectation. This is a genuinely new private lifecycle context choice; root acceptance required. The per-preview record/non-rendering cleanup and exact model check are necessary consequences of current reconnect implementation, not optional polish.

## Delivery provenance and current caller inventory

Owned Task `1a766f90-c69c-4712-ac72-7635cf6837f3`, PR393. Original implementation `b53aa3a0ff85a3820044b7a9ffa9b8525f8577b4`, published evidence head `d3e319ce6ed4d73b4b8bbc42d52902723b72e997`. Isolated correction branch `fix/overnight-native-mobile-close`; old tree and concurrently tested navigation B remain unchanged. Next free ADR number verified across all repository refs was0046. No new public API, dependency, merge or release.

At exact393 head, ordinary calls are WorkspaceLeaf.detach (`workspace.ts:577`) and direct View.onClose compatibility calls (including unchanged mobile test1806). Implicit calls are WorkspaceLeaf.setView (`:214`), renderer disposeCanvases/failed startup, LP Canvas startup catch (`live-preview.ts:951`), and App.initializeDocumentView failure cleanup (`app.ts:4920`). Actual shared View is not expanded: Canvas-specific internal cleanup wrapper or scope.close remains the strict seam. Generic RenderScope recursion/registry/prepareRetirement has no close context. Production callers must be re-audited on the final composed source, especially navigationB's moved App/renderer lines.

Diagnostic instrumentation changes only test observation: native vault.modify wrapper forwards every call unchanged; TestInfo JSON captures exact state before/after original onClose. The original rejection is rethrown. No existing bytes, zoom, gesture, conflict or relaunch assertion changes. A nonempty touch pointer set is an independent guard and requires further causal review, never an exemption inferred from the preview. No diagnostic outcome claimed by accepting this ADR.
