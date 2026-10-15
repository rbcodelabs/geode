# ADR-0039: Shared lanes for frontmatter read-modify-write

**Date:** 2026-10-15
**Status:** Accepted by coordinator, 2026-10-15, under the user's reversible
tested-PR authority. Includes the shared lane, removal of FileManager's outer
queue, captured Vault and required Base indexed source/non-null owner guards.
Direct writes, Markdown buffers, provider writes and host rename races remain
outside this guarantee. No merge, release or parity claim.
**Delivery:** Task `a95a8209-bbe2-4e9a-8251-e334ce22c077`; parent Task `93f1491d-7139-4451-885c-fc34c4c30780`; Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`.

## Context

At frozen Base source `1dc7e0a`, an actual-method synthetic regression submits
`priority: 9` and `score: 11` concurrently through `BaseView.editCell`. Both reads
receive the same original file. Both promises resolve, but the second complete
file write restores the original priority value. The preserved RED proves this
lost update in the controlled fixture; it does not establish broader filesystem
loss. The test was outside the earlier frozen unit suite's discovery.

`frontmatter-io.patchFrontmatter` currently reads, transforms and writes with no
lane. `FileManager.processFrontMatter` already has a module-level weak per-Vault,
per-path promise queue, but Base callers bypass it. Its queued callback also reads
the mutable `app.vault` rather than consistently using a captured Vault. Two
independent queues would not coordinate Base and FileManager; nested acquisition
of the same lane could deadlock.

The pure transform preserves existing body/newline behavior and rejects thenable
mutation callbacks. Base supplies a captured-owner/conflict/generation guard;
FileManager validates the current indexed Markdown TFile before and after reading.
These protections must survive queue migration. Vault rename mutates TFile.path
in place after its host operation; a captured file reference is not a captured path.

## Options considered

| Option | Benefit | Cost / limitation |
|---|---|---|
| Move the existing lane to shared `patchFrontmatter` (recommended) | All participating Base/FileManager callers share one complete RMW boundary; small local change | Coordinates only this helper in one runtime and Vault object identity |
| Serialize per Base or route Base through FileManager's current queue | Small caller-specific patch | Per-Base misses other owners; routing through FileManager couples native guards to plugin service and leaves direct helper callers unsafe |
| Add host-wide conditional writes/transactions for every file writer | Could address broader cross-process/external races with version checks | New host/public contracts and conflict policy, substantially larger than this proven prerequisite; defer |

## Decision

Move queue ownership into `frontmatter-io.patchFrontmatter`. Use one module-private
`WeakMap<VaultWriter, Map<string, Promise<void>>>`. The outer key is the exact Vault
writer object captured at request admission. The inner key is the captured
canonical **indexed** vault-relative `file.path`, not a column, Base view or TFile
object identity. Thus different columns, different Base owners and FileManager
instances targeting one note participate in the same lane.

Do not invent canonicalization by lowercasing, trimming, resolving symlinks or
rewriting path separators here: those transformations can merge distinct indexed
names or claim alias knowledge the renderer does not have. Callers must supply
the current canonical indexed TFile. Different object instances of Vault, even
for the same underlying folder, remain different lanes; this is an explicit limit.

Remove FileManager's separate queue. Preserve its public method signature and
validation; capture its Vault, file and expected path before calling the helper.
The callback must reject if `app.vault` changes, the file moves, the current index
no longer contains that exact file object, or it ceases to be a Markdown file.
Never silently redirect an old request into the newly selected vault.

### Complete operation and guards

Acquire the lane **before reading**, then perform these steps serially:

1. Revalidate captured file/path identity and run the caller's repeatable ownership
   guard when the queued operation begins. A queued closed/held/stale Base owner or
   switched FileManager vault rejects before mutation; do not wait inside the lane
   for an ownership barrier that is itself draining this operation.
2. Read current text through the captured Vault, not cached text captured before
   enqueue and not a later `app.vault` lookup.
3. Revalidate after the read, then invoke the synchronous mutation callback exactly
   once through the existing pure transform. Preserve thenable/serialization error
   rejection and no-op behavior.
4. Revalidate immediately before `modify`; the callback can synchronously change
   surrounding application state, so a pre-callback check alone is insufficient.
   Await the captured Vault's modify before releasing the lane. Forward write
   options unchanged. Never release after merely starting the write.

The existing internal `beforeMutate` hook can serve as a repeatable guard at these
boundaries; its actual production callers are checks, not mutation callbacks. The
user mutation callback still runs once. Capture/check file.path in the helper even
for minimal structural VaultWriter test doubles. Current indexed membership and
owner/vault policy belong to the caller guard: preserve FileManager's real lookup
and Base's token/target/conflict checks. Base's current `rowTargetCurrent` does not
check indexed identity, while Vault.read/modify use file.path directly. Therefore
this package must strengthen the participating Base guard: the captured Vault's
current indexed file at the captured source path must be the exact captured source
TFile, and the captured Base owner file must still be the indexed owner when one
exists. Check these conditions at each queued/read/write guard boundary. Removal
and recreation at the same path must reject the old operation even when strings
still match. This is required real-Vault validation, not a permissive optional
lookup. Minimal test doubles must model that index when testing Base participation;
the generic helper cannot discover an index from read/modify alone.

File rename during a queued wait/read rejects when path identity no longer matches;
do not transfer its lane or write the old snapshot into the renamed file. No path
check can cancel an already dispatched host write or serialize a rename that does
not participate in this lane. Do not add post-write cancellation that reports a
completed write as though it never persisted. A host-level rename/write race needs
separate evidence and authority before extending the contract.

### Rejection, cleanup and ownership

Return the actual operation promise to each caller, with its original rejection.
Store a recovered scheduling tail that resolves on either outcome, so a failed
read/callback/guard/write does not poison the next legitimate submission. Recovery
of the scheduling tail is not save success or acknowledgment of RenderScope's
retained failures. Base's exact-key retry policy remains responsible for those.

Register the new tail synchronously before any callback can enqueue another helper
operation. On settlement, delete the path entry only if it still refers to that
same tail. An older operation must not delete a successor's lane. Weak outer keys
allow discarded Vault instances to collect; completed path entries must not grow
forever. Never automatically retry/replay mutation callbacks after errors.

Queued Base operations remain inside their existing root-tracked operation until
their helper call settles. Check the existing token on dequeue/after read/before
write, rejecting stale work so close/barrier drains can finish. Do not add a second
scope operation or global mutex around the lane. Different files and different
Vault objects must be able to proceed while one lane is blocked.

## Coverage and consequences

This prevents lost updates between participating `patchFrontmatter` operations
within one renderer/module runtime and captured Vault object, provided each read
observes the prior completed write. Later same-column submissions follow admission
order; the synchronous callback sees the predecessor's persisted result. It does
not decide which historical user value is semantically preferable.

It does **not** serialize arbitrary direct Vault.modify/process calls, Markdown
live-buffer Properties edits or autosave, external filesystem/provider/sync writes,
another renderer/process, distinct Vault wrappers for one root, or rename/trash.
It is not filesystem atomicity, external conflict detection, compare-and-swap or a
crash transaction. Those races retain their existing recovery/conflict policy;
never claim every frontmatter edit or writer is covered by this lane.

The riskiest assumption is that every caller intended to receive this guarantee
uses this one helper/module instance and the same Vault object. Audit all current
call sites and mixed-caller tests before promoting evidence. No dependency, public
API change or global filesystem lock is recommended.

## Bounded implementation and regression matrix

One isolated implementation package moves the lane, updates FileManager's
captured-vault guard, and strengthens Base's indexed source/owner identity guard
as the explicitly authorized narrow caller delta. Preserve the original RED test, but do not keep
its expectation that both reads begin together after serialization: a meaningful
GREEN asserts that the second read waits for the first write and sees fresh text.

| Scenario | Required observation |
|---|---|
| Actual Base same-file two-column overlap | First read/write completes before second read; both values persist, both promises resolve, body/newlines preserved |
| Different Base owners / mixed Base and FileManager | One shared lane; no overwrite between participating calls; each caller's callback sees predecessor's result |
| Two FileManagers / direct helper calls | Existing FileManager guarantee survives removal of its outer queue; no nested-queue deadlock |
| First read, guard, callback, serialization or modify rejects | First caller receives rejection; callback/write counts correct; next valid submission runs and lane cleans up |
| First operation is a no-op | No modify; later operation runs normally; queue still serializes read/transform |
| Different files or Vault objects | Block A; independent B begins/completes, proving absence of a global lock |
| Base owner canceled/held or conflict appears while queued/read delayed | Guard rejects before mutation/write; no stale callback write; retirement can finish |
| FileManager app.vault switched while queued | Neither old nor new vault is accidentally modified by the stale request; explicit failure |
| Rename/path mutation or delete/recreate during wait/read | Existing membership/path guards reject; old target is not recreated or redirected; distinguish caller-guard evidence from helper-only behavior |
| Mutation callback invalidates owner synchronously | Final pre-write guard prevents modify; callback is not invoked again |
| Older settled tail with successor already queued | Cleanup cannot remove successor; third submission stays serialized; completed entries do not accumulate |
| Same-column admission order / thenable callback / write options | Deterministic participating order; synchronous contract still enforced; options forwarded exactly |

Run focused frontmatter/FileManager/Base ownership and failure-retry suites,
typecheck/build, then coordinator-assigned actual related flows and full gates on
the frozen integrated branch. Require independent review of guards, scheduling
tails and exact coverage language. No implementation/tests/app runs accompany
this design-only artifact, and no parity status is promoted by the proposal.
