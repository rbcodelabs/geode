# Frozen parity integration: source resolution checkpoint

Task `40ee9547-0419-4945-999a-e10d732ed14c` carries the user's explicit overnight
reversible implementation authority through a tested PR. The coordinator granted
source integration into this isolated branch after the frozen Markdown review
correction. Original feature branches, worktrees and published PRs remain intact.
This checkpoint is not a completed gate, public Editor acquisition, PDF embed,
native virtualization fix or complete parity claim.

## Inputs and provenance

Daily baseline: `fe659b18d36245d23137c054d16a935cf2503f4f`; preparation head
`2e1b066f7231e08f5f6acb9d329f99e6284d17ac`. The
[commit map](parity-integration-commit-map.json) records each original and its
integration cherry-pick. Inputs are native entry `0bd0d5d`, shared lane `5c1dff2`
within that ancestry, Markdown `db4009d` / `982f85d` / `c0e7e5e`, its subsequent
E2E/docs-only `49a29e0`, PDF `cf75d62`, private Editor preparation through
`0c8f4d7`, preview test corrections `8fcbbaa` / `c4ac07b`, and failure snapshot
`f232bc7`. Base reload source is deliberately excluded until independently reviewed.

PDF's native status/banner changes `019a769` and `2a3d76d` are already carried
through patch-equivalent `6e09dd6` and `2d9c984`. PDF's common startup harness
`597a723` is equivalent to daily `1ec6a77`. These three commits were omitted from
PDF replay; no feature change was omitted. The seven common equivalence families
in the preparation provenance remain authoritative. No merge/reset/force push or
whole-side conflict resolution was used.

## Explicit conflict resolutions

- `a5cfb35` → `44b9f45`, Markdown Reading: retain the daily live-buffer property
  inspection and post-render generation/file/editor/Vault guard, inside native
  root-tracked rendering. Close retains Reading generation invalidation and native
  disposal. This intermediate state is subsequently adapted by the final transition.
- `982f85d` → `c9c35b1`: keep both PropertyTypes and ScopeCancelled App imports.
  Reading retains the daily current-buffer snapshot and property parsing, generation
  guard and cleanup; renderer receives the newly owned Reading projection. Parent
  flush belongs to the staged replacement before child retirement, so the internal
  committed render does not perform a second flush. Terminal close keeps generation
  invalidation. All other transition/receipt/rename logic is retained.
- `f1dd5fe` → `724bc96`, App cleanup: await property persistence, Footnotes lifecycle
  and stop, and PDF lease cleanup before Vault retirement. Session replacement
  retains its leaf/native preparation and plugin cleanup ordering.
- `f1dd5fe` → `724bc96`, Workspace reveal: retain awaited native Markdown reveal,
  captured leaf/view/file/path checks and finally-based background focus restoration;
  add PDF fragment handling under the same captured-owner checks.
- `32fdebd` → `9b8eab3`: retain that combined reveal implementation and adopt the
  PDF branch's static fragment-parser import. Other PDF fixes apply unchanged.

Auto-merged shared App, Workspace, live-preview and Markdown code also requires
independent semantic review. A source-byte comparison confirmed all 24 PDF-private
source/build/dependency files match frozen `cf75d62`, including the lockfile.
Private Editor core has no production imports or export/acquisition wiring.

## Joint regression and minimum guard correction

The daily sidebar mutation seam initially accepted dispatch while the native
registry held its owner, the body was inert for replacement, autosave was paused,
or terminal close was active. Four controlled cases failed before the correction
at the combined intermediate source `962742e`; preserved RED log:
`geode-combined-sidebar-guard-red.log`. The minimum correction adds those readiness
checks to `canApplySourceEdit`, preserving normal editor transactions and undo.
No acknowledgment, conflict policy or native scope protocol changed.

Six joint unit cases cover those four refusal states, a dirty body plus property
transaction/undo retained after nested draft refusal, and actual App disposal
awaiting property, Footnotes and real PDF-capacity leases before Vault cleanup.
The existing Reading fixture now includes both lifecycle generations. Its old
concurrent-flush oracle is replaced with the accepted coalescing contract: shared
promise, one flush/render, exact fresh buffer, and retained stale-owner rejection.
A native fixture gains the daily Reading generation initializer; no production
assertion is removed to conceal a failure.

Two new real UI cases are prepared for Reading and Live Preview. They commit a
property over dirty source, enter an actual nested Base input, assert original
bytes, invoke explicit replacement, and require refusal with the same connected
input/value and property/body source. Actual child Enter must save its target;
outer property undo must retain the earlier body edit and autosave exact bytes.
These cases are unrun at this checkpoint, awaiting the coordinator's Electron slot.

## Verification and remaining gates

This worktree owns its locked dependency installation; no shared install changed.
Electron is 42.10.0, Vitest 4.1.11 and PDF.js 6.4.299. No compute offload is configured.
Initial four joint source suites pass 38 tests; typecheck and build pass. These
local results do not clear the combined full-unit/Electron gates or UI evidence.
The coordinator independently reviews conflict resolutions and the guard before
assigning those gates. Further targeted results are recorded on the same Task.

Original native viewport/return failure witnesses remain present. Explicit
replacement fixes do not establish CM virtualization safety; persistent native
presentations need the separate accepted layout prototype. Base reload ordering
has a separate confirmed race and pending correction. Neither is waived here.
Screenshot publication/display verification through the shared reporting provider
remains incomplete; committed synthetic local captures do not satisfy that gate.
