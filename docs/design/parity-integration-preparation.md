# Frozen parity packages: integration preparation

This is a source-read-only preparation checkpoint. No feature branch has been
merged, rebased or cherry-picked into this branch; its sole application baseline
is daily parity `fe659b18d36245d23137c054d16a935cf2503f4f`. Only this plan and its
[provenance record](parity-integration-provenance.json) are added. No combined
build, test pass, public Editor facade, PDF embed or complete parity is claimed.

The current native replacement/lifecycle package remains an active writer in
App, MarkdownView, Workspace, Canvas and RenderScope. Its final frozen commit and
coordinator clearance are prerequisites to source integration. Re-run task/PR
collision checks, provenance and simulations against that exact commit first.

## Package boundaries

| Package | Frozen input | Preserve |
|---|---|---|
| Daily use | `fe659b1` | Metadata source parser/cache schema and bounded whitespace fix; Outgoing links and safe live-buffer conversion; P1 Properties and shared P2 types/date controls; folding/multiple selections with YAML excluded; optional Footnotes; binary Vault copy/traversal; common test harness fixes |
| Native entry | `0bd0d5d`, production/test change `190ef7e`, parent shared lane `5c1dff2` | Native subtree preparation, Canvas presentation retention and staged replacement; exact Base draft/failure ownership; shared frontmatter lanes; focus-scroll correction and original Canvas regression witnesses |
| PDF tabs | `cf75d62`, final production/test change `398693c` | Fixed resource protocol; Node-free frame/worker; validated private port; authorized bounded reads/cancellation; App document leases; tab routing, restore and lifecycle handling; matching pinned dependency/assets and proof fixtures |
| Editor Phase 0 | `a0adc2b` context, `10e703a` source/tests, `0c8f4d7` documentation clarification; based on daily `fe659b1` | Three accepted design/context files plus the private uninstantiated adapter and isolated tests only |
| Preview tests | `8fcbbaa` + `c4ac07b` | Real render-child unload/listener/blob lifetime assertions and CSP-permitted positive/negative resource oracle; no production change |
| Failure snapshots | `f232bc7` | Generic Scope and legitimate Base pre-helper late-guard-failure witnesses; no fake simultaneous participating RMW writes |
| Native replacement | Pending final frozen input | Accepted replacement/draft/conflict receipt and lifecycle behavior; do not substitute an earlier mutable snapshot |

The PDF and native entry branches share actual ancestor `89de61c`. PDF carries
patch-equivalent native followups under different hashes, so replaying its entire
history blindly would duplicate them. PDF remains tab-only; Markdown/LP/Canvas
PDF wiring and persistent presentation work have their own pending decisions.

## Common changes: retain once

Stable patch IDs, not commit titles, establish these equivalences:

| Daily/native commit | Equivalent commit elsewhere | Intent |
|---|---|---|
| `1f6f56d` | `6f32587` | Wait for persisted Base sort order |
| `5d5185d` | `6c97451` | Ribbon persistence and released Base draft test barriers |
| `1ec6a77` | PDF `597a723`, preview ancestor `5e4f180` | Startup layout/settings write barriers |
| `bf54d83` | `236f737` | Vault binary copy and traversal root |
| `a14394a` | `16ab2c8` | Web Viewer availability polling |
| Native `6e09dd6` | PDF `019a769` | Definition retry acknowledgment status |
| Native `2d9c984` | PDF `2a3d76d` | Conflict banner test through actual native lifecycle |

Preview corrections `d3b4980` and `c4ac07b` yield byte-identical
`tests/e2e/page-preview.spec.ts` and identical scoped diffs. Their *whole trees*
are different: one sits on PDF/native, the other on Vault. Apply the two unique
preview test commits once; do not replace an integrated tree with either parent.
The provenance JSON records full input hashes and stable patch IDs.
Editor documentation followup `0c8f4d7` changes only ADR0036 and the adapter
brief; `git diff 10e703a 0c8f4d7 -- src tests` is empty. Carry that clarification
after the original two Editor commits, preserving its explicit preparation-only
status and narrow legacy transaction-dispatch boundary.

## Pairwise simulation results

These are `git merge-tree --write-tree --name-only A B` simulations. They wrote
unreferenced Git objects only, without changing any worktree, index or branch.
Exit 1 means textual conflict, not a product failure. Pairwise clean results do
not prove a complete multi-package integration is clean or correct.

| Inputs | Textual conflicts | Other shared changed files requiring semantic review |
|---|---|---|
| Daily + native entry | MarkdownView | App, live-preview, Workspace |
| Daily + PDF | App, MarkdownView | live-preview, Workspace; three common harness specs |
| Native entry + PDF | workspace-native-writers test | BaseView, RenderScope, sync-conflict-ux test |
| Daily + Editor Phase 0 | None | Exactly five new files; verify no runtime acquisition/import added |
| Native entry + preview | None | No shared changed files, but preview ancestor history is redundant |
| Native entry + snapshot test | None | One new test only |

Reading-path conflict: daily uses the live-buffer snapshot for Properties and
Reading output, with generation/file/editor/Vault identity checks. Native code
adds owned rendering and subtree retirement. Preserve both invariants within the
final accepted replacement algorithm; taking either whole side would discard
required behavior. Close must combine current-operation invalidation, owned
preparation/retirement and cleanup rather than directly destroying a retained
writer. Final native input may change these exact conflict regions.

App cleanup conflict: close property-type persistence, settle/stop Footnotes and
close all PDF leases before retiring the captured Vault/session. Also audit root
switch/error cleanup and registration order even where Git merges them cleanly.
The latest native replacement receipt policy governs view replacement; PDF
initialization/disposal must preserve its ownership and authorized-read limits.

Native/PDF test conflict: retain the current Base indexed identity fixtures and
actual failed `editCell` operation from shared-lane/native recovery tests. The
older PDF ancestor injected a generic failure directly into Scope and has no
required file index. Preserve all PDF-specific tests independently; do not revert
the strengthened Base fixture to make an old expectation pass.

## Intended source phase after clearance

1. Pin and inspect the final accepted native replacement commit. Recompute the
   complete union from its real ancestry, retaining entry/shared-lane changes and
   avoiding duplicate native fixes. Keep each original branch unchanged.
2. Integrate daily/native behavior on this isolated branch with small explicit
   conflict resolutions. Review the *auto-merged* shared files too; never choose
   an entire side as a substitute for preserving both contracts.
3. Replay the PDF-unique range after its native baseline, omitting only proven
   equivalent commits. Preserve dependency/lockfile, exact worker/frame CSP,
   preload and owned-read changes. Use this worktree's own locked install once
   dependency integration is approved; do not mutate shared dependencies.
4. Carry the two preview test corrections and separate failure snapshot tests
   exactly once. Carry Editor Phase 0 context/module/tests without wiring or
   exporting them. No broader Editor API or new feature is part of integration.
5. Freeze an integrated candidate for independent review before running the
   coordinator-assigned combined gates. Record source/base/patch mapping and every
   conflict resolution. A changed native input invalidates this simulation map.

## Joint regression strategy

Start with targeted units, typecheck and build on the final frozen tree, using
host execution with explicit unrestricted permission and the configured locked
runtime. The coordinator serializes full-unit and Electron gates; no heavy check
was run during this documentation-only preparation.

The combined actual UI gate must include daily-parity-integration plus Properties
undo/dirty-body/date-type persistence; folding with frontmatter excluded;
Outgoing live-buffer conversion/undo; Footnotes editing/persistence; Markdown
metadata references; Vault binary/traversal; Canvas-owned draft/retry/history and
plain double-click entry; actual nested Reading/LP/viewport retention; accepted
Markdown conflict/replacement behavior; PDF real selection/navigation/leases,
held/resumed port, theme/error and saved-page restart. Do not replace failing
pointer entry with keyboard entry or omit the existing lifetime witnesses.

For conflict regions, add narrowly meaningful joint witnesses if the existing
specs do not cover both sides together: a dirty Properties edit followed by an
accepted/refused Reading replacement must preserve source and undo; a folded
body/active row draft must survive the relevant native preparation refusal;
PDF disposal and Footnotes/property lifecycle must settle before root cleanup.
Exact root-switch tests depend on the final native receipt policy, not this plan.

Run complete unit and complete Electron suites on the same frozen integrated
source only in assigned slots. Existing PDF full-suite failures remain evidence,
not silently waived: Bases ordering has a proven common test barrier; preview
cleanup has new actual child/resource witnesses; conflict-driven replacement
needs the accepted native correction. Neither a clean merge nor individual
package passes clear the combined gate. Shared screenshot publication/display
verification also remains pending through the authorized reporting provider.

## Separate work

Named Workspace runtime wiring, public Editor acquisition/facade wiring, persistent
native presentation redesign, PDF embeds, search/annotations, lightbox and wider
Properties inventory/search/rename remain outside this bounded integration.
