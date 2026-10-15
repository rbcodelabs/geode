# Base external reload ordering verification

Implements accepted [ADR0041](../adr/0041-base-external-reload-ordering.md).
Production and unit-test checkpoint: `3d8a53c`, based on frozen preview/Vault
`c4ac07b`. This is the standalone Base algorithm; native integration still must
retain RenderScope cancellation, draft/conflict and retirement checks separately.

## Confirmed behavior

A controlled actual Electron test uses normal UI clicks and sort selection. A
valid provider cache miss allows an own-write read to capture the first default
`file.name` sort and remain pending. The user selects `note.priority`; the test
waits for the actual priority-sort YAML on disk before releasing the old bytes.
On unchanged baseline source this fails the original exact eight-row order:
its trace shows the priority save acknowledged, then stale `applyText` replacing
its definition with file-name sorting. The baseline clone has only the copied
test changed; production/dependency diffs are empty.

On the fixed source, both the original sort/filter/edit flow and the controlled
flow pass without retries (2/2, 4.9 seconds). The original eight-row ordering is
asserted and captured. Both then filter to Gamma and edit priority to 5. Final
actual Base bytes contain `note.priority` ASC and `note.status == "Done"`;
actual Gamma Markdown contains priority 5. These disk checks do not depend on
the controlled cache, which deliberately returns undefined.

The inspected [synthetic proof record](../evidence/base-reload/controlled-ui-proof.json)
contains the exact rows, final raw YAML/Markdown and relevant baseline trace.
The repeated earlier full-suite failure is consistent with the proven race;
its precise original schedule was not captured and is not claimed here.

## Bounded verification

- Initial stale-read unit reproducer failed against unchanged source. Expanded
  regression-first ordering matrix had 8 failures / 2 passes; the notification
  test separately confirmed a missing visible error boundary.
- Final new matrix: 17 tests passed. Includes stale own writes, latest external
  notifications, pending/newer persist tails, file/path/Vault/root/inline/close
  invalidation, same original write/read rejection, no automatic recovery reads,
  synchronous modify echo without self-wait, and the final-request cleanup race.
- Six focused test files: 44 passed. Typecheck and desktop/mobile build passed
  locally; PM configuration has no compute-offload entry.
- Real unchanged-source controlled baseline: 1 expected failure, retries disabled.
- Fixed original + controlled UI: 2 passed, retries disabled. An earlier fixed
  pair also passed before adding explicit final raw-disk capture/assertions.
- Full-unit gate is coordinator-owned and pending at this checkpoint. No full
  Electron or combined native/daily/PDF gate is claimed by this report.

## Method inventory and limits

`persist` invalidates at synchronous mutation admission. `doPersist` invalidates
pending start, acknowledgment and clear. `applyText` invalidates accepted known/
definition state. `setFile`, `mountInline`, `onOpen` and `onClose` invalidate the
owner/lifetime capture; close failure preserves existing retry policy. The drain
captures target/Vault/root, revision and request generation, waits for the actual
captured persistence tail, and repeats a current read when superseded. A failed
tail/read returns its original error and terminates the drain; event notifications
observe it and expose its message. No acknowledgment or automatic retry is added.

This does not serialize external filesystem writers, plugin mutation outside the
participating methods, independent Base owners or Markdown host-note buffers.
It does not add filesystem atomicity or public APIs. Existing lifetime witnesses
and sort assertions remain intact; native cancellation/error policy must be
independently verified when this patch is carried onto that baseline. No new
visual surface was introduced, so this evidence uses exact data/trace oracles
rather than new screenshots. Shared reporting-provider publication remains the
coordinator's separate handoff requirement.
