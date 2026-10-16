# Base external reload ordering: proposed bounded correction

Status: Historical proposal; superseded by accepted [ADR0041](../adr/0041-base-external-reload-ordering.md).

## Confirmed problem and limits of evidence

A deterministic unchanged-source unit interleaving demonstrates a real production
race: an own-write reload captures earlier `file.name` YAML, a newer
`note.priority` save is acknowledged, then the delayed older read reaches
`applyText` and replaces the newer definition/known text with the old sort.
The repeated full-suite failure has the same alphabetical result, but its exact
causal interleaving was not captured. A focused real UI run passed; do not label
that full failure conclusively explained until a faithful controlled UI witness
or equivalent evidence establishes the schedule.

The reload currently compares read bytes only with the *latest* pending/known
text. Those values can change during its await. The same logic exists in the
frozen native branch, where RenderToken protects owner lifetime but does not
identify a newer local definition revision within that owner.

Constraints: one private BaseView algorithm, no dependencies/public API, no
weaker sort assertion, no hidden external changes, no arbitrary filesystem atomic
claim. Preserve native owner/draft/conflict policies when replayed onto the final
native baseline. This branch starts at the frozen preview/Vault baseline; active
App/Markdown/Scope work is untouched.

## Options

| Option | Advantages | Costs/risks |
|---|---|---|
| A. Monotonic definition revision plus a single coalesced reload drain | Discards stale own-write reads, reduces duplicate reloads, preserves the latest notification by reading again; narrow private state | Must mark every definition/known/pending lifecycle transition and repeat after a superseding event; must avoid busy reads while own writes settle |
| B. One serialized queue for every definition mutation, save and reload | A single total order is easy to state | Broad rewrite of synchronous menu callbacks, external reconciliation and existing persistence queue; higher conflict and deadlock risk; exceeds the minimum defect correction |

Recommend A. No implementation until accepted. B should be reconsidered only if
revision coverage cannot be kept explicit in this one class.

## Proposed private state and ordering

- A monotonic local revision changes on persist admission (in-memory mutation is
  already synchronous), pending-write start/acknowledgment/clear, accepted apply,
  file/inline mount change and close. Capture Vault identity, file identity/path,
  local revision and reload-request generation for every read.
- Each external notification marks another reload request. One per-view drain
  coalesces requests; newer requests supersede earlier results rather than
  spawning independent apply paths. There is no growing queue of read jobs.
- Before a read, await the captured own-definition persist tail if pending. Recheck
  owner/file/Vault identity and request/revision after that await, then capture
  current values for the actual read. A later admitted write changes revision.
- After read, reject publication on closed/changed owner, file/path or Vault.
  A changed revision or newer reload request discards the result and re-arms one
  fresh read. The next iteration waits for the then-current persist tail; this
  avoids spinning reads during a delayed write.
- If the snapshot is still current, preserve existing pending/known-byte and
  invalid/empty-input policies before calling the existing apply path. A genuine
  latest external modification must reach a fresh read/apply; never simply drop
  it because an own-write event occurred earlier.
- Retain original read/persist errors. Clear the in-flight drain reference on both
  outcomes without creating an unhandled finally rejection. Failed I/O does not
  trigger an unbounded automatic retry; a later explicit/external request can
  start another drain. The architect should confirm the exact pending-request
  policy when an awaited own persist rejects, preserving existing failed-draft
  recovery instead of treating that rejection as a successful reload.
- When moved onto native code, keep the original RenderToken and retirement
  checks around the drain and every apply; a local revision is additional to,
  not a substitute for, owner admission. Do not restart reads under a held or
  retired owner. Existing recovery/conflict policy remains authoritative.

## Regression matrix before source acceptance

1. Earlier own-write read returns after a newer acknowledged local sort: newer
   definition identity, known text and rendered order survive; no stale apply.
2. A local write is admitted or remains pending during a read: no stale publish;
   reread waits for that write, then sees the current state without spinning.
3. A later genuine external notification arrives during a delayed read: discard
   old bytes, perform a fresh read, apply the latest external definition exactly
   once. Multiple events coalesce rather than leaving the final one unobserved.
4. File object/path, Vault or owner changes during any await: old result never
   applies to the new target; follow-up notifications use the new captured target.
5. Read or persist rejection: caller sees the original error, no unhandled drain
   tail, no automatic replay, subsequent valid request recovers without losing
   latest failed-draft policy.
6. Unchanged own bytes remain a no-op; actual newer external bytes still apply.
7. Existing full sort/filter/edit assertion remains unchanged. A controlled real
   UI schedule should preserve normal user selection, exact final ordering and
   persisted YAML, with no private direct mutation standing in for the sort UI.

Independent review and coordinator-assigned targeted/full gates remain required.
