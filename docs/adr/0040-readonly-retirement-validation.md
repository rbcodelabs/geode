# ADR-0040: Separate read-only retirement validation from write preparation

**Date:** 2026-10-15
**Status:** Accepted by coordinator, 2026-10-15, under the user's reversible
tested-PR authority. Includes the complete-set phase ordering, private truthful
destruction indicator and abort after a rejected pre-destructor completion.
No implementation, merge, release or parity claim is included.
**Related:** [ADR-0032](0032-named-workspace-runtime-switching.md), [ADR-0038](0038-durable-native-markdown-presentations.md)
**Delivery:** Parent Task `93f1491d-7139-4451-885c-fc34c4c30780`; Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`.

## Context

The ADR-0038 implementation's new regression establishes a recoverable validation
error becoming an invented retained write failure. Markdown's root has
`failureKey: "markdown-save"`; `prepareCloseNative` both reads the recovery copy
and flushes. RenderScope tags any rejection from that combined callback with the
write key. Repairing the copy cannot make another close succeed because draining
the old retained failure rejects before the copy can be revalidated. The preserved
unit RED is `geode-markdown-recovery-read-failure-retained-red.log`; it is evidence
of the controlled ownership-method scenario, not an actual Electron close result.

A read check is not a failed save and needs no write acknowledgment. Conversely,
dropping `failureKey` would discard genuine flush-failure protection. Read
validation must also run after every affected subtree's mutating preparation:
a child flush may change the copy a parent validated earlier.

Constraints: preserve connected controls on pre-destructor refusal, retain genuine
write failures and existing exact-key retry, prepare the complete affected set
before any destructor, and catch a late local draft/snapshot change. No generic
acknowledgment, dependency or plugin-facing API change.

## Options considered

| Option | Benefit | Cost / limitation |
|---|---|---|
| Validate in Markdown's caller before scope retirement | Very small local edit | Ordinary root close and nested trees can bypass it; parent check may precede child mutations; duplicates lifecycle ordering |
| Add a private read-only `validateClose` scope callback (recommended) | Correct failure classification and one ordering contract for all native retirement paths | Requires a separate complete-set validation pass and explicit pre-destructor failure handling |
| Special-case validation exception types inside mutating prepare | Avoids another callback | Brittle error tagging, mixes reads/writes, and does not establish correct whole-set ordering |

## Decision

Add an optional internal `ScopeOptions.validateClose(): Promise<void>` callback.
It may inspect current owner, indexed recovery destination and exact stored/current
bytes. It must not save, start a producer, publish UI state, acknowledge failures
or change readiness. Keep `prepareClose` for required mutating preparation such as
Markdown flush. Its existing `failureKey` classifies those write-preparation
failures; it never wraps the read-only validation pass.

Markdown moves receipt validation into `validateClose`; its mutating prepare keeps
`flushNative`. Successful parent writes remain successful even if subsequent
validation refuses close. Report that refusal as a retirement/recovery-check error,
not a failed save. A later ordinary close can rerun validation after the copy/read
problem is repaired, without calling a write retry to acknowledge a fictional save.

### Complete-set phase order

For `RenderScope.prepareRetirement(affected)` and ordinary unprepared root close,
use the same phase contract over the deduplicated affected forest:

1. Synchronous whole-subtree preflight before intentional blur/inert/DOM mutation.
2. Freeze admission and settle registered work. Preserve retained-write failure
   rejection and all existing generation cancellation.
3. Complete **all** mutating prepare callbacks across **all** affected trees.
   Wait for every started preparation, including siblings, to settle before
   resuming on failure. Preserve existing retained failure keys.
4. Only after phase 3 succeeds, run the read-only validation traversal across the
   complete set. Await every started validation before final decision/resume.
5. Re-run synchronous preflight over the entire affected forest after the last
   validation await, catching a child draft or local snapshot change during those
   awaits. Use internal readiness callbacks; do not call `assertAdmission`, since
   scopes are intentionally frozen/closing at this point.
6. Enter destructor traversal only once all phases succeed. Prepared descendants
   do not independently repeat mutation/validation after a sibling's destructor
   has started; that would break complete-set preparation.

Do not implement steps 3–4 as `prepare(A), validate(A), prepare(B), validate(B)`:
B's preparation could invalidate A's read. Separate tree traversals are required.
A parent callback followed immediately by its child prepare is not sufficient.
Existing traversal order within the mutating phase can remain if all mutations
finish before the separate read phase.

### Prepared handles and abort classification

Returning a prepared handle introduces an await gap before `commit`. Recheck the
complete forest's **synchronous** preflight immediately at commit, before entering
its first destructor. The final check must not be per-root immediately before
closing that root: another affected root may refuse after earlier destruction.
Read validation has already followed all participating mutating preparation;
coordinator code must not introduce new mutating preparation between those phases
and commit. A caller that does so must prepare/validate a new transaction.

A commit-time preflight failure is still pre-destructor refusal: abort/resume the
complete old forest, preserve its connected controls, and permit an ordinary later
retry. Callers must distinguish it from partial destructor failure. The current
Canvas caller sets `destructorsStarted = true` before awaiting commit, which would
misclassify this newly possible refusal. Carry a narrow internal prepared-handle
phase indicator such as `destructionStarted` through renderer wrappers, or an
equivalent private pre-destructor failure classification, and update affected
native callers. Use a truthful read-only `destructionStarted` getter on the private
prepared handle, forwarded by renderer wrappers and inspected even after commit
rejects. Set the indicator only when entering destructor traversal after
the final whole-set check. Do not infer it merely from calling `commit`.

This is internal native coordination, not a public Obsidian API or generic failure
clear. Keep commit idempotent and abort effective only before destructor traversal.
Abort remains valid when a completion promise already exists or has rejected but
`destructionStarted` is false: the old `!completion` condition would strand a
commit-time refusal. Resume the complete set exactly once, preserve the false phase
indicator, and require a new preparation for a later retry. A second commit cannot
revive an aborted/rejected handle. Apply this classification to every Canvas
retirement caller and Markdown's new transition flags, including callbacks that
previously set a local destruction flag before calling commit.
If destruction has begun and fails, retain the existing fail-closed semantics;
never promise restoration of already destroyed siblings.

### Failure and self-drain rules

Validation/preflight refusal adds no entry to retained write failures. Resume old
admission under the existing ancestor/registry rules, leave all genuine failures
untouched, and preserve controls. Genuine flush rejection still retains its exact
write key and requires the existing successful explicit retry; fixing a recovery
copy cannot clear it. A second failed read simply refuses again without adding a
write error or poisoning future closes.

Ordinary root close runs these phases outside that root's own tracked operation;
it cannot await draining its own close task. A Markdown transition prepares its
projection children, not its parent root-run task. Read validation must not wait
for a barrier release that depends on the same retirement completing. No new
global mutex, scope acknowledgment API or host transaction is introduced.

## Consequences and limits

The scope lifecycle gains one private phase instead of teaching write recovery
about arbitrary read errors. This requires auditing every `prepareClose` callback
and every prepared-handle wrapper/caller; a misplaced read can otherwise still be
misclassified, and an old caller flag can incorrectly make a safe refusal inert.

The riskiest assumption is that validation callbacks are genuinely read-only and
all participating preparations belong to the captured affected set. Whole-set
ordering and final local preflight do not make provider writes, host rename,
storage clearing, raw trusted-plugin mutation or external changes after validation
atomic. Preserve ADR-0038's exact receipt limits; make no filesystem-atomic claim.

## Regression matrix before source approval

- Receipt-copy mismatch/read rejection refuses with connected local controls and
  no retained write failure. Repair the existing copy/read, close again successfully
  without write acknowledgment, with provider bytes unchanged. Cover device-record
  invalidation/repair too.
- A genuine flush failure remains retained; repairing only the recovery copy does
  not permit close. Existing successful exact-key save retry then allows validation
  and close, without clearing unrelated writer failures.
- Parent validation reads a copy that a child mutating prepare changes. Assert the
  read runs after that write and refuses mismatched bytes before any destructor.
  Repeat across two affected roots, including delayed sibling preparation.
- During the last async validator, introduce a late child draft/change the current
  local snapshot. Final whole-set preflight refuses, no destructor runs, controls
  remain usable. Repeat the change after handle preparation but before commit.
- Commit-time preflight refusal restores Canvas/Markdown caller interaction; its
  phase indicator remains false. Partial destructor failure sets it and remains
  fail-closed. Repeated commit/abort never double-closes or falsely reopens a scope.
  Explicitly test abort after an already-rejected completion promise while the
  destruction indicator is false, under frozen prepared state; use private tree
  preflight rather than admission-requiring public readiness methods.
- Failure in one mutating prepare waits for already-started siblings to settle;
  failure in one validator waits for other started read validators. No late callback
  publishes into resumed/replaced owners; no canceled scope is resurrected.
- Ordinary root close and multi-root prepared retirement share the ordering; no
  root self-drain, queue poison, new producer admission or generic acknowledgment.

Require targeted scope/Markdown/Canvas tests, typecheck/build, independent review
and coordinator-assigned actual close/retry flows. This document contains no source
or test implementation and authorizes no merge, release or parity promotion.
