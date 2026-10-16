# ADR-0047: Sync guard receipts for displaced Base draft focus

**Date:** 2026-10-15
**Status:** Accepted by coordinator on 2026-10-15 under existing reversible tested-PR authority

## Context

The actual macOS diagnostic shows the same connected Base input and edit identity retaining draft `9`, while body/view inert causes native blur. The paused edit rejects without writing; final release leaves BODY focused, so the original subsequent Enter cannot commit. Linux retains input focus. Blanket failed-blur refocus would steal deliberate newer focus. No automatic replay or write is authorized.

Inspected callers at native correction source3b875: App's sync onPrepare sets body inert before Workspace.holdAutosave; Base.pauseAutosave sets view inert and vaultSwitching. Workspace.releaseAutosaveHold resumes only after its final hold. App.finishGuard currently restores body inert last. PostApplyRefresh's holdStale deliberately restores body early but retains per-view holds until recovery; host disposal also invokes finishGuard. Table.startEdit's blur commit catches rejection and retains its exact editSession/input. Its explicit Enter handler remains the only proposed later write trigger.

Done means the unchanged macOS case retains provider1 through guard/refusal and restores only its original eligible input after final release; the subsequent real Enter commits9. No public View, plugin, or Workspace interface is expanded.

## Options considered

| Option | Benefit | Cost / limitation |
|---|---|---|
| App-owned outer-guard receipt plus private Base/Table eligibility closure (recommended) | Owns exact inert lifetime; separates platform focus repair from save policy | Small private coordination and focus-intent observer lifecycle |
| Base pause/resume receipt | Keeps editor checks local | Resume precedes body release; needs additional App final-release signal anyway; confuses sync with unrelated pause callers |
| Replay rejected blur write | Avoids focus restoration | Writes without another explicit action; changes preservation policy; rejected |

## Decision

Use a single disposable receipt for each outer sync-guard epoch, captured synchronously BEFORE the first body inert assignment. App asks the actual active leaf's built-in BaseView for a private receipt only when that view's actual currently edited input equals document.activeElement. Do not query for a generic matching input or find an inactive Base opportunistically. Base owns its TableView receipt and source-draft validation. Embedded Bases are outside this bounded repair; extending ownership discovery requires another reviewed delta.

The receipt captures App workspace and active leaf/view identity; Vault object AND root string; Base file object/path, owner generation, definition revision, sourceEdit identity/file/path/column/rawText; Table editSession/token, exact input/cell identity and input value. Capture any existing native render-owner token when present; scope retirement/failure invalidates it. No synchronous read of provider bytes is required, and no new I/O is introduced. Capture eligibility rejects read-only/conflict/recovery, retained native/row failures, pending genuine writes, disabled input, existing body/ancestor inert or preexisting autosave/vault-switch suspension.

An App-local guard-epoch record owns the receipt and token Set. Duplicate prepare for the same live token must not create a receipt or recapture previousInert. Nested/overlapping tokens share the first receipt; they never replace it with an editor that became active later.

A short-lived document capture observer records focusin to ANY different non-BODY element as irrevocable supersession, even if that element later blurs back to BODY. Pointerdown/key interaction selecting a different destination, window blur/page hiding, workspace/active-leaf replacement, or receipt disposal also invalidates. Conservative invalidation is preferred to stealing focus. No isTrusted requirement on focusin: programmatic newer focus matters too. Observers are removed on consume/discard, including errors and host disposal.

The exact Table input's blur listener may mark displacement only while the matching live guard owns body/view inert and the exact edit identity/value is unchanged, with relatedTarget null/BODY and no supersession. A BODY activeElement at release alone is insufficient evidence. Linux's still-focused original input is a no-op success, not a forced focus.

App restores only at its FINAL normal finishGuard: remove the token, release mutation/autosave holds, restore the prior body inert, then offer the receipt for one guarded consumption. It must not restore from resumeAutosave, holdStale's early body release, individual nested release, or a timeout/disposal callback. Unknown or duplicate finishes are no-ops. A timeout/expired guard must discard its epoch receipt before normal cleanup; a later onPrepare continuation cannot recreate it. A retained-stale/recovery outcome discards focus restoration, even if a future successful retry eventually lifts the stale hold; this deliberately avoids unexpectedly reclaiming focus long after the operation.

At consumption revalidate all captured identities and values, no other live guard or stale hold, no current body/ancestor inert, unsuspended writable Base, enabled connected exact input, eligible live native owner, same active leaf, and current focus BODY or that exact input. Require actual guard-marked displacement before focusing BODY's replacement. Call input.focus({preventScroll:true}) once; do not select text, rerender, retry, save, cancel a draft, clear an error, acknowledge a failure, or alter Table's ordinary failed-blur policy.

### Pending blur rejection boundary

The receipt must observe completion of ONLY its own guard-marked paused blur attempt. If that attempt remains unsettled at final release, schedule the single consumption after that existing attempt settles; do not poll and do not await it inside the sync protocol. The guard epoch becomes release-eligible but remains invalidatable, and the continuation rechecks epoch identity plus ALL above conditions. Starting another guard, user focus/interaction, timeout, stale hold, or disposal irreversibly retires it. An older continuation cannot consume a newer receipt. A genuine write or a rejection other than the explicit paused-admission refusal never qualifies. Prefer tagging the private paused-admission refusal internally over inspecting an error message. This is not a new cancel/read/write task or permission to release an unsettled writer. Receipt observers are removed even if eligibility fails; no retry loop. If the existing attempt can remain genuinely pending without a paused-admission result, discard rather than retain a receipt indefinitely.

## Caller and state matrix

| Caller / transition | Receipt behavior |
|---|---|
| App first valid sync onPrepare | Capture eligible focused Base; arm before inert |
| App nested onPrepare / duplicate token | Keep first capture; no focus |
| Workspace.holdAutosave / Base.pauseAutosave | Existing persistence semantics; no restoration |
| Table guard-displaced blur | Record exact paused attempt and displacement; no write replay |
| App finishGuard, other tokens remain | No restoration or receipt replacement |
| App final normal finishGuard | Restore inert/holds first; consume now or after exact paused rejection settlement |
| holdStale / failed or slow refresh | Discard receipt; retain existing stale protections |
| Recovery retry after stale hold | Existing release only; cannot revive discarded focus |
| Timeout / host disposal / workspace replacement | Invalidate first, then cleanup; late callback inert |
| Deliberate ordinary blur / explicit failed save | Existing Table behavior unchanged |

## Required RED/GREEN matrix

1. Actual unchanged macOS causal test; provider1 while held, same draft9, restoration only after final release, subsequent Enter writes9 once. Linux unchanged case remains a separate comparison.
2. Unit App boundary: capture precedes body inert, final restoration follows Workspace resume AND body restoration; nested/duplicate/unknown release, out-of-order release, prior body inert, no initial focused Base.
3. Actual Table paused blur marks only exact receipt. Genuine save success/error, explicit failed save, ordinary deliberate blur and read-only failures never gain repair authority.
4. Different control receives focus then BODY: never reclaim. Programmatic newer focus and active-leaf replacement, input removal/token replacement/value change, Vault root mutation in same object, source-file rename, definition/source draft revision changes each refuse independently.
5. Held paused-rejection settlement after final release: eligible receipt restores once; a newer guard or focus selection during settlement prevents it. Duplicate completion cannot restore twice; old continuation cannot consume a new epoch.
6. Stale hold with body released early; timeout during prepare; late prepare/hold completion; disposal; retained native failure; disabled control; scope frozen/retired: no focus/write or revived receipt.
7. Existing failed-row retry focus and Table edit-ownership adversarial controls remain unchanged; no expectation/time-budget relaxation.

## Consequences and risks

This adds private lifecycle coordination instead of changing general focus policy. It gives up restoration after stale refresh recovery, ambiguous displacement, unrelated embedded editors, or intervening intent. The riskiest assumption is that a guard-caused paused blur can be identified with a private explicit refusal and exact edit identity; production must not infer that authority from BODY or an error string. If implementing that proof requires broad view discovery or generic focus management, use the private Base-final-release alternative and return the delta for review.

No merge/release, dependency, public API, persistent storage, or automatic write is part of this decision. ADR0047 is next free among all currently committed refs (highest0046 observed); engineer should recheck immediately before committing this ADR.

## Clarifications after concrete caller audit (supersedes optional-token/timeout shorthand above)

**Owner generation:** Source3b875's RenderScope has no captureToken method. Do not add one for this repair or call scope.run merely to manufacture a receipt. Workspace.holdAutosave invokes view.pauseAutosave only. Base.pauseAutosave changes vaultSwitching/container inert and awaits persistQueue; resumeAutosave clears those flags. Neither calls RenderScope.freeze/resume, so the expected guard does not advance native ownership generation. Base's existing reloadOwnerGeneration/definitionRevision plus exact renderOwner object, live admission and no retained failures, exact Table session/input/sourceEdit capture provide eligibility. Any actual render retirement/resume that rerenders the editor changes those captured DOM/session/lifecycle identities and must fail. If implementation finds a scope freeze/resume retaining every Base identity, do not silently relax a captured token: add a bounded private lifecycle generation witness or return the case for review. A future source already exposing captureToken may capture it, but expected guard itself must be proven not to invalidate it.

**Exact paused refusal seam:** Replace only Base.editCell's first `vaultSwitching` admission rejection with a module-private identifiable paused-admission Error (or WeakSet-branded Error factory) exported only through an internal renderer module to TableView. The ordinary human-readable message remains. Table's existing catch(error) records completion for the receipt only when this exact private brand matches, this attempt was initiated by the exact guard-marked native blur, and session/input/sourceEdit remain captured. Neither message matching nor arbitrary error shape grants authority. No public interface or host IPC receives the brand. Table's ordinary error catch semantics remain unchanged.

**Actual timeout boundaries:** Main.requestEditor at src/main/main.ts has a 5000ms waiter timeout, but neither SyncSafetyService.onRelease nor preload's sync-editor-release includes the reason/timeout flag. Therefore the renderer CANNOT identify an actual main waiter timeout from the existing protocol. Do not infer it from outcome absence, strings, elapsed time, or a late release. PostApplyRefresh has a separate explicit 4000ms `state === "slow"` branch which invokes holdStale; that actual caller invalidates the receipt synchronously. Its catch/holdStale path does the same. Host disposal invalidates before finishGuard. Late onPrepare guards already check token membership after each await; receipt generation checks additionally prevent revival.

To bound a receipt even if a host release never arrives, use an explicit **private focus-receipt expiration policy of 4000ms from capture**, enforced by its own timer and a monotonic expiry check at consumption. This is a conservative local eligibility deadline, NOT a report that the host timed out and NOT a change to host guard/persistence timing. It does not release a hold or acknowledge an operation. At expiration remove receipt observers and clear any pending-restore reference; actual guard continues its existing lifecycle. Newer guard/holdStale/disposal invalidates sooner. The budget is deliberately shorter than main's nominal waiter budget but cannot certify host timeout ordering; no such certification is required because restoration authority is independently bounded. Tests use a controlled clock and assert no resurrection after expiration or late settlement. Record this budget in the private module, not as a product setting.

**Minimal pending lifetime:** While held, observe only the captured input and the App-local intent observers. On normal final release, if the exact branded paused attempt is already settled, consume/discard synchronously. If its catch is still pending, retain the single receipt until that already-existing attempt's settlement or the ORIGINAL capture deadline, whichever occurs first; do not start a new lifetime. Pending genuine save, unknown attempt, or unavailable branded result discards immediately. All paths remove observers and clear timer once; Promise callbacks after invalidation read only the retired generation and do nothing. This adds no Promise awaited by finishGuard and no unbounded observer lifetime.


## Accepted implementation clarifications

Coordinator accepted the narrow exact-Promise witness on2026-10-15: the private paused-admission factory brands both its Error and exact immediately rejected Promise. The ordinary human-readable error remains unchanged. Table observes only the exact guard-marked blur's original Promise; unknown/wrapped/genuine attempts discard without pending authority. A private Error brand is still required at catch settlement. No message matching or brand propagation through arbitrary wrappers occurs.

The pending regression releases the actual App guard synchronously before the actual native rejected Promise reaches Table's catch, preserving that Promise identity. Intervening newer guard/focus or the original4s expiry invalidates the continuation. A separately wrapped paused rejection is a negative control.

Actual Base owner freeze→resume can retain every draft/DOM/session identity because runAndRender defers while editing. Coordinator accepted a private nativeLifecycleGeneration witness incremented by Base's real owner resume callback; receipt capture includes it. A regression invokes that actual callback via the extracted unchanged native options factory and preserves every edit/input identity. It failed before the witness increment, then passes after it. No RenderScope or public SDK API is expanded.


## Pre-freeze review and verification checkpoint

Root and independent engineer read the complete implementation and acceptance tests. New real-seam unit coverage invokes App's actual guard registration, Workspace's real hold/resume, Base's actual paused edit admission, and Table's actual native-blur commit. Initial behavior REDs and separate real owner-resume/duplicate-prepare/workspace-disposal/exact-table-identity REDs were recorded before their corrections. Focused local verification on locked Vitest4.1.11: eight files101pass in2.25s. This is focused evidence only; remote types/full units/build/Electron/mobile and actual macOS corrected behavior remain pending at this checkpoint.

Actual E2E diagnostics return the exact original callback Promise with non-transforming side observers. Before the original Enter, additive direct assertions require provider bytes still original1, the original connected9 input/Table/session/source draft, and exact input focus. No extra wait or focus action masks restoration. A separate run of the raw original case is required to rule out observer effects. No save replay, deadline relaxation, public API, package or dependency version change is included.
