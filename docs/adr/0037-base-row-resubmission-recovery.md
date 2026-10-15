# ADR-0037: Recover Base row saves through exact-target resubmission

**Date:** 2026-10-15
**Status:** Accepted
**Acceptance:** Root coordinator accepted full design `0459c40` under the exact 2026-10-14 overnight user authority. Delivery Task `e7bb9595-539e-4a85-85e2-37ac460de6d0`, worker `root/editor_parity`; isolated branch `fix/overnight-base-row-recovery`, base `7e66f7b`. The user authorized reversible implementation through tested PRs; merge/release remain separate.
**Parent:** [ADR-0032](0032-named-workspace-runtime-switching.md)
**Delivery:** Parent Task `93f1491d-7139-4451-885c-fc34c4c30780`; Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`

## Context

At source checkpoint `7e66f7b`, Base row submissions normally use
`RenderScope.run`, while the explicit Retry button uses `RenderScope.retry`.
Both can successfully persist the same current cell value, but only the latter
acknowledges retained failures. A failed row save followed by ordinary blur can
save successfully and remove its visible Retry button while leaving the old row
failure in the ownership barrier. Shift-Tab can reach that path before the user
reaches Retry. The exact-target focus protection in `0812f0c` protects a direct
transfer to Retry; it cannot determine every intervening keyboard destination.

Separately, a confirmed method-level regression starts an A-cell save, starts a
B-cell draft while A's write is pending, then completes A. `commitCellEdit`
unconditionally clears `sourceEdit`; B's owned draft disappears from that field.
The regression mocks rendering and establishes ownership-state loss, not an
actual DOM-loss observation. It requires a captured-edit fix before recovery
policy can be considered safe. Nested-entry Task `50c78aed` remains a separate,
unrun diagnostic investigation and supplies no evidence for this decision.

Constraints: preserve successful file writes, latest draft values, ownership
generations, external-conflict checks and reachable recovery. Never acknowledge
another file/column, a definition write, an unkeyed read error, or a later failure
merely because another operation succeeds. No dependency or public API change.

## Options considered

| Option | Benefits | Costs and risks |
|---|---|---|
| Failed editor permits only explicit Retry/Cancel; suppress ordinary blur/Enter saves | Clear explicit recovery action; avoids implicit resubmission | Adds a persistent editor state and keyboard/mobile rules; Cancel cannot silently acknowledge a failed write, so separate retained-payload recovery is still necessary |
| Treat every row submission as an exact-target retry (recommended) | Uses existing snapshot-based acknowledgment; ordinary successful save and Retry agree; preserves current Enter/blur/mobile behavior | Requires precise submission/edit identity and exact-target recovery controls; does not solve overlapping writes by itself |
| Clear retained row failures whenever a save/status becomes successful | Small superficial change | Acknowledges unrelated or concurrently arriving failures; hides unresolved writes; rejected |

## Decision

Recommend exact-target resubmission using the existing `RenderScope.retry`
operation for every actual row submission: Enter, desktop blur, mobile Save and
explicit Retry. A first submission has no prior failures to acknowledge. A later
submission captures prior failures for its exact key at admission; only successful
completion acknowledges that captured set. Keep the scope primitive's existing
semantics and all other writer keys unchanged.

The stable key remains `JSON.stringify(["row", file.path, columnPath])` within
the same Base owner/vault lifetime. A path or owner change must invalidate stale
callbacks rather than retry an obsolete target. Explicit Retry selects the latest
draft only when both file and column match; otherwise it retains the failed
submission's captured payload and refuses while a different active draft needs
finishing. Keep the existing direct Retry focus-transfer protection to avoid an
unnecessary duplicate blur submission. Cancel ends editing under the existing
contract; it does not acknowledge a retained failed write.

### Prerequisite: submission identity and presentation ownership

Capture the current edit object or monotonically increasing edit generation at
submission, together with immutable file/column/raw text. Reopening even the same
cell creates a distinct edit identity. Check that identity before clearing the
active draft, ending/acknowledging the table editor, restoring selection, or
rerendering its projection after an await. A's completion may acknowledge A's
captured old failures and record its successful bytes; it must not clear or
replace B's newer editor, including a newer generation of the same cell.

Apply the guard to both layers: BaseView's `sourceEdit` and BasesTableView's
`editing`/`onEditEnd`/`acknowledgeEdit` callbacks. Guard failure/finally paths too;
an old save must not reset a newer write's tracking or retarget the current draft's
recovery status. Recovery selection must match the retained row key exactly;
`any row failure + current sourceEdit` is insufficient evidence to label the
current cell failed.

Use a small Base-owned map from exact row key to its latest failed submission
record: submission identity, file/owner identity, column and submitted text.
Snapshot the matching record when a resubmission starts. On success remove that
record only if it is still the same record; a failure arriving later must survive.
On failure retain the latest failed submission for that key. The scope continues
to own the actual failure set; this map owns recovery payloads and presentation,
not an alternative acknowledgment authority. This avoids adding a write queue or
changing the scope API. If several keys fail, choose recovery from their matching
records, never from whichever draft currently happens to be active. A Retry for A
must refuse while B has an incompatible draft and must not overwrite B's controls.

### Defer refresh while an edit owns its connected projection

Static inspection also finds `runAndRender` called by metadata/vault refresh
paths and table rendering replacing its tbody. That is an entry-loss hypothesis,
not an actual nested DOM observation. Regardless of trigger, the edit contract
requires preserving a connected editor while it owns an active draft or failed
submission. Gate all query-result DOM replacement at one Base-owned boundary;
record that refresh is needed and coalesce it until the captured edit finishes or
cancels safely. Metadata may continue updating independently. Flush the deferred
query against current data once the matching editor-end callback completes; do
not replay a captured old result or discard the pending refresh indefinitely.

A successful save may update persistence status without ending the active edit
session prematurely. End/acknowledge the matching table edit and release its
projection gate together, with the same edit-identity check. A newer session keeps
the gate. Preserve the current error/draft projection on failure; ordinary metadata
notifications must not remove its input or recovery controls. Prefer this single
local refresh gate over a generic rendering framework or a broad writer queue.

Keep admission and token checks at the existing mutation boundary. This policy
does not authorize a stale draft to overwrite an externally changed file or a
closed/vault-switched owner. Preserve existing conflict arbitration; if tests show
an uncovered overwrite path, coordinate that separately before claiming safety.

### Persistence success and presentation failure are distinct

Do not report a successful file mutation as a failed save solely because a
subsequent query/render/recovery callback throws. Separate the persistence result
from presentation refresh and report a refresh/recovery error accurately. Avoid
retrying a completed file mutation merely to repair its presentation. This is a
required failure classification, not evidence that the current path has produced
such a failure in Electron.

## Consequences

A successful normal resubmission and a successful explicit Retry release the same
captured row failure. Keyboard focus order ceases to determine whether a saved
row permanently blocks retirement. We retain ordinary blur-save behavior rather
than introduce a new failed-editor interaction mode.

The identity prerequisite adds checks at asynchronous completion sites. It does
not add a generic failure-clear API or change definition, Canvas or read failures.
This decision does not establish serialization of overlapping read-modify-write
operations against the same file. Such overlap is a separate integrity constraint
to characterize; preserving B's draft alone does not prove all write races safe.

## Verification brief

Write regression-first tests and retain the original failing logs. Use actual
Base/Table methods for ownership and callback cases; use real Electron controls
for focus/blur behavior. A prototype-only harness cannot establish connected DOM.

| Scenario | Required result |
|---|---|
| Initial row write fails, latest value edited, Enter resubmission succeeds | Latest bytes persist; only captured exact-key failures clear; retirement succeeds once no draft/other failure remains |
| Same sequence via ordinary blur, including Shift-Tab through table container | Same acknowledgment; no hidden retained row failure after visible success |
| Direct mouse/keyboard Retry and mobile Save | Latest matching draft saved once; reachable controls; direct Retry focus protection retained |
| Resubmission fails again | Draft and exact-target Retry remain reachable; new failure retained; no false success |
| Other file, other column or definition failure also exists | Successful A resubmission leaves those failures retained and correctly targeted |
| Same-key failure arrives after retry admission | It remains retained; successful retry clears only its admission-time snapshot |
| A delayed save completes after B starts; repeat with same-cell new generation | B's exact draft identity/value and table editor remain; no A-driven projection replacement or editor-end callback clears B |
| A fails after B starts | A recovery still targets A's captured payload; B remains intact; Retry A refuses while incompatible B draft is active |
| Unrelated metadata/vault refresh during active or failed edit | Same input remains connected with its current value; one coalesced refresh runs after matching finish/cancel, using current query data |
| Unkeyed read failure or Cancel followed by unrelated success | No retained-write acknowledgment; no global clearing |
| Owner retired/frozen/vault switched or external source conflict appears | Existing admission/conflict refusal remains; source bytes and recovery stay coherent |
| File write succeeds but refresh throws | Successful write remains acknowledged; visible refresh error is classified accurately, without replaying the mutation |

Then rerun focused ownership/Base/Canvas tests, typecheck/build and the affected
actual Canvas failure/retry/history flows in the coordinator's single Electron
slot. No source implementation, tests or app runs accompany this design record.

### Bounded implementation packages

1. **Edit identity and projection prerequisite:** reproduce the confirmed A/B
   ownership failure; guard Base/table completions and every query-result
   replacement; test deferred refresh and same-cell new generations. Establish
   real connected-input evidence separately from method-level ownership tests.
2. **Exact-target recovery:** add failed-submission records and route row
   submissions through existing exact-key retry; test Enter/blur/Retry, late
   failures and unrelated keys. Do not modify generic scope acknowledgment.
3. **Actual integration verification:** reproduce Shift-Tab and real mouse/keyboard
   Retry with delayed/rejected writes, then rerun Canvas history and nested entry
   diagnostics. Treat nested entry failures before a draft as entry findings only.

Each source package needs its own regression-first evidence and independent review.
These packages do not belong to the unrun nested-diagnostic Task `50c78aed`.

## Risks and revision conditions

The riskiest assumption is that a later successful user submission for one exact
file/column represents recovery of its captured earlier failed intent. If product
behavior instead requires preserving each historical value as an independent
operation, choose the explicit-only state and a retained recovery inventory.
Concurrent writes, multiple unresolved targets, rename and conflict behavior need
their own evidence; this ADR does not infer correctness from key equality alone.
No complete Workspaces or Obsidian parity claim follows from this policy.
