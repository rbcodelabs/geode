# Properties Reading transition correction

Task `79b2bf7c-1727-4ee3-905c-f7dc9ef29216` → Solution
`523dc576-9b4d-4028-a8d3-e2e5f765d45a`, parent Properties Task
`e7954a61-948a-4c00-b74d-227692c1c0fc`. The coordinator approved these reversible
corrections under the overnight tested-PR authority. Original worktrees and frozen
regression source `707699d` remain preserved.

## Confirmed causes and limits

Two controlled unit witnesses use actual MarkdownView transition/RenderOwnership,
PropertyEditor/FileProperties adapters and CodeMirror state, with synthetic DOM.
A delayed native flush makes the centre body inert. A sidebar Enter is correctly
refused, but a later unfocused metadata refresh discarded its typed draft/error.
Separately, two accepted same-turn Reading edits advanced the current buffer while
the coalesced refresh retained the first snapshot and cancelled before rendering.
The original full-suite old-metadata failure is consistent with these paths; its
exact schedule has not been established by these unit witnesses.

The initial dummy Compartment fixture caused an effect.is error and is excluded
for that case. With a real Compartment, both assertions failed with 14 existing
cases passing (`geode-properties-reading-diagnostic-valid-red.log`). Expanded
regressions failed six cases before production changes. After the bounded fix,
seven focused suites passed 115 tests; typecheck and build passed on the local
host (no compute_offload entry). Actual browser witnesses are prepared, unrun.

## Narrow behavior

PropertyEditor retains a rejected-draft latch across unrelated refreshes, even
when focus leaves. Blur does not resubmit that failed edit. Enter/the original
action retries through the same current-owner, expected-value and current-type
checks; Escape or a successful explicit action clears the latch. Recreating the
control owner discards old controls; detached callbacks cannot replay the draft.
This does not make an inert, held, read-only or failed native scope editable.

Reading records the latest requested snapshot and its exact file/editor/mode,
Vault/root and transition generation. One shared promise covers guarded native
replacement. A cancelled snapshot advances only to a newer request from that
unchanged current owner with current source/editability/admission. Native refusal,
flush/read errors and cancellation without a newer matching request propagate;
there is no generic automatic retry, timer or polling loop. The shared promise
settles only after the selected latest render settles. Existing child preparation,
complete-forest retirement and temporary inert protection remain authoritative.

## Evidence surface

The unit matrix covers rejected draft retry/discard, metadata/type/owner changes,
same-turn two and queued three accepted edits, delayed actual rendering, promise
settlement, native refusal, real flush rejection, no-newer-request cancellation
and file/editor/mode/Vault/root/generation/admission invalidation. Existing stale
Reading owner/Vault tests and native/Footnotes suites remain in the focused gate.

`properties-reading-transition.spec.ts` defines two real Electron witnesses:
refusal during a gated real flush followed by explicit retry, and three accepted
Reading edits followed by latest projection/disk and independent undo checks.
A separate test-only sibling on unchanged `707699d` supports the RED run; the
same test blob runs against the fixed branch. Original file-properties workflows
remain unchanged. No full app gate, complete parity or screenshot publication
claim follows from prepared or synthetic evidence.

## Exact rejected field correction

Independent coordinator review identified that an unrelated field's no-op Enter
or successful action could clear the first draft. Two actual-adapter regressions
failed against `374ee07` before this correction. The editor now captures the exact
wired input through a synchronous action context; it does not guess ownership
from a key or whichever element happens to be focused. Until that field's own
retry/discard or owner destruction, unrelated Enter/no-op, Escape, apply, remove,
checkbox, type and add-row actions refuse visibly without changing the original
draft/error or stealing focus. Other actions are not queued for later replay.

Only a wired field advertises Enter/Escape recovery. Generic checkbox/type errors
do not create a field gate. A separate failed type-picker retry regression first
failed because the generic error survived successful registry update; the explicit
successful retry now clears that generic error. External registry changes still
cannot clear an owned rejected text field. The final focused matrix covers 40
FileProperties cases, including the original 14 cases and 26 additions. No actual
Electron proof has run at this documentation checkpoint.
