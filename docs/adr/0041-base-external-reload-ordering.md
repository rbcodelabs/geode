# ADR-0041: Order Base external reloads against local definition changes

**Date:** 2026-10-15
**Status:** Accepted by coordinator on 2026-10-15 under the user's reversible tested-PR authority. Design decision only; no implementation or parity claim.
**Related:** [ADR-0037](0037-base-row-resubmission-recovery.md), [ADR-0039](0039-shared-frontmatter-mutation-lanes.md).
**Delivery:** Parent native ownership Task `93f1491d-7139-4451-885c-fc34c4c30780`; Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`.

## Context

The proposed correction at `411159d` documents a deterministic unchanged-source
Base reload race: an earlier read captures `file.name` sorting, a newer local
`note.priority` save succeeds, and the earlier read subsequently replaces the
acknowledged definition. A repeated full-suite alphabetical ordering failure is
consistent with this race, but its exact schedule has not been established.
The controlled regression proves the race, not the cause of every UI failure.

Current `reloadIfChangedExternally` reads asynchronously and compares the result
only with pending/known text at completion. Those values can change during the
read. Native RenderToken checks protect owner lifetime, but do not identify a
later local definition within the same owner. The narrow goal is to prevent stale
publication while still observing the latest genuine external notification.

Constraints: private BaseView state only, no dependency/public interface change,
no weakened UI oracle, preserve failure recovery and native guards. This concerns
`.base` definition reloads, not ADR-0039 frontmatter row-write serialization.

## Options considered

| Option | Benefit | Cost / limitation |
|---|---|---|
| Local revision and one coalesced reload drain (recommended) | Narrow change; stale reads cannot replace newer acknowledged state; latest notification causes a fresh read | Every participating local definition/lifecycle mutation must invalidate the captured revision |
| Serialize all definition mutation, persistence and reload through one queue | Strong local ordering model | Requires rewriting synchronous callbacks, existing persistence and reconciliation; increases self-drain and integration risk |
| Discard a read whenever known text changes, without another read | Small patch | Can silently lose a genuine external notification; insufficient |

## Decision

Recommend the local revision and single-drain approach. Reconsider a broader
queue only if explicit revision coverage cannot be maintained within BaseView.

### Snapshot and request ownership

Maintain a monotonic local definition revision and a reload-request generation.
Advance the local revision at persist admission, participating pending/known-text
changes, accepted definition application, file/inline owner replacement and close.
Document the actual affected methods when implementing. A mutation followed by
persist in the same synchronous callback can invalidate at persist admission;
there must be no await allowing a stale publication between mutation and admission.

Each external request advances the request generation. At most one drain performs
reads; concurrent requests share its promise and coalesce to current intent.
Capture Vault object/root, file object/path, owner lifetime and current revision.
Where the production owner has an indexed target contract, preserve its actual
identity checks; a path string alone does not establish file identity.

Before reading, await the captured own-definition persistence tail. Recheck target,
owner, revision/request and whether a newer tail was admitted during that await.
Wait for the current tail before taking the actual read snapshot. A pending write
must not cause repeated disk reads or a tight polling loop.

After reading, check the same owner/Vault/file/path and local revision/request
again. Discard a superseded result and re-arm one fresh read against current state.
Only an unchanged snapshot may reach existing pending/known-byte comparison,
empty/invalid-input handling and definition application. Unchanged own bytes remain
a no-op that preserves definition object identity. A genuine newest external
notification must reach a fresh read; it cannot disappear behind an own-write echo.
Applying a current result must not mistake its own revision advancement for an
unhandled external request and create an endless reload loop.

### Failed persistence and read policy

Await the captured persistence tail even when it has already rejected. Preserve
the original rejection object, current failed definition/draft and existing
retained write keys. A failed persistence wait terminates that drain before read
or apply; a failed read also terminates it without applying stale bytes.

All requests coalesced into that failed drain share its rejection. Do not re-arm
an automatic retry merely because another request arrived while the failing work
was outstanding. A later explicit/external request may create a new drain, but
cannot bypass a still-rejected latest persistence tail or native retained-write,
draft or conflict policy. Existing successful authorized retry/persistence can
make that tail usable; this change adds no acknowledgment or failure-clear path.
Do not automatically reread disk to recover from a failed save and thereby replace
the user's unsaved definition with the old stored version.

Clear the active-drain reference on success and rejection without creating an
unobserved rejecting cleanup promise. The event adapter must observe and report
reload rejection to the existing user-visible error surface. Direct awaiters still
receive the original error. A stale/canceled native operation follows its existing
cancellation policy; it must not restart under a held or retired owner.

Own-write notifications enqueue/observe reload work only. They must never await
that reload from the write operation whose persistence tail the reload is awaiting.
The reload drain itself must not occupy that persistence queue.

### Native integration and limits

Keep native RenderToken, owner admission, active-draft/projection and source-conflict
checks in addition to the local revision. Validate after every newly introduced
await and before applying a result. A local revision cannot authorize mutation
under a held or retired owner. Port the fix onto the final native baseline through
independent review and repeat its guarded-owner regressions; baseline-only unit
success does not prove that integration.

Preserve explicit reconciliation's supplied-text and suspension contracts. This
decision does not globally serialize arbitrary plugin mutation, providers,
independent Base owners, filesystem writes or Markdown host-note buffers. An
external writer can change storage after a current read; no CAS or atomic
filesystem guarantee is introduced. Inline Base host-note changes remain outside
the standalone definition-reload path.

## Consequences and risks

The existing synchronous definition callbacks and persistence queue remain usable.
Only reload admission/publication gains ordering state. Coalescing bounds pending
read jobs, but continuous external changes can delay application; no general CPU
or latency bound follows.

The riskiest assumption is complete revision coverage. Missing a participating
mutation can leave the same race at a different entry point. A method inventory,
interleaving tests and independent source review are required. A successful sort
test alone cannot prove every native lifetime or external-change path.

## Regression acceptance

- Delay an earlier own read, acknowledge a newer sort save, then release old bytes.
  Keep the same newer definition object, known text and exact visible ordering.
- Admit a local write during a read; discard the old result, wait for the latest
  write, and perform at most the needed fresh read rather than polling while pending.
- Coalesce several external requests during a delayed read. Apply fresh latest
  external bytes once; do not apply the superseded result or lose the final request.
- Change file object/path, Vault/root, inline owner or close state during each await.
  An old result must not publish into the new owner. Repeat with native held/retired
  scopes and retained draft/conflict guards on the integration baseline.
- Reject the awaited own write, including an already-rejected tail and a newer
  queued write. Preserve original rejection and definition/draft; perform no read,
  no apply, no hidden acknowledgment and no automatic rerun of the failed drain.
  A later permitted request succeeds only after existing persistence recovery.
- Reject a read and observe the notification adapter: visible error, no unhandled
  rejection and no automatic read loop; a later valid request can recover.
- Preserve unchanged-own-byte identity, invalid/empty-input handling, no self-drain
  on synchronous modify events, and bounded coalesced cleanup on both outcomes.
- Keep existing sort/filter/edit UI assertions. Add a controlled real user sort
  schedule with exact persisted YAML and final ordering; do not label the earlier
  full-suite failure conclusively diagnosed without schedule evidence.

Require focused tests, typecheck/build, independent review and coordinator-assigned
full gates. No implementation, publication, merge or release is authorized by this
document alone.
