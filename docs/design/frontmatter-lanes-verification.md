# Shared frontmatter mutation lanes — bounded implementation

Implements accepted [ADR0039](../adr/0039-shared-frontmatter-mutation-lanes.md).
The shared `patchFrontmatter` helper serializes each participating read, synchronous
transform and awaited write by captured Vault object and exact captured path.
Base row edits and FileManager calls share that lane; independent paths and Vault
objects proceed independently. Rejected operations retain their original rejection,
and a recovered scheduling tail admits later explicit submissions without replay.

FileManager captures its Vault at admission. Base validates indexed source and
non-null Base-owner identity. Caller guards repeat at dequeue, after the awaited
read, and after transformation immediately before any modify. Renames, replaced
indexed objects, Vault switches, held owners and conflict states reject stale work.

## Evidence before independent review

- Regression-first: new lane matrix initially failed 17 of 24 cases; the source
  correction passed all 24. Two additional queued-source-deletion/Vault-switch
  cases were added before final verification.
- Final focused run: seven files, 94 tests passed, zero failures. Includes 26 new
  lane cases plus existing frontmatter, FileManager and Base retry/ownership tests.
- Typecheck and desktop/mobile build passed on the local host. This repository's
  PM configuration has no compute-offload entry.
- The only production helper call sites are FileManager and BaseView. Their
  signatures remain compatible; no dependency or public API was added.
- Existing Base fixtures now explicitly model the indexed TFile identities.
  Same-file failure-order tests now settle the preceding write before observing
  the next write, preserving latest failure and retained draft assertions.

Full unit and actual Electron regression gates remain coordinator-owned and
pending at this checkpoint. No parity or complete delivery claim is made.

## Limits

This lane does not lock direct Vault.modify calls, Markdown live-buffer edits or
autosave, external filesystem/provider/sync writers, another runtime, distinct
Vault wrappers, or rename/trash already dispatched. It does not provide filesystem
atomicity or conflict detection for those writers. No automatic retry is added.
No visual surface changes in this package require new screenshots.
