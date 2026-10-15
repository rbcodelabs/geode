# ADR-0038 persistent native layer: bounded Electron prototype

**Task:** `5ebcf1f8-5fab-421f-8ab8-1989300588b7`, parent `93f1491d-7139-4451-885c-fc34c4c30780`, Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`.
**Baseline:** `49a29e0`, source `c0e7e5e`; separate `test/overnight-native-layer-prototype` worktree. Proposal awaiting coordinator review before implementation.

## Evidence and reference

Read accepted ADR-0038 and its caller map, the preserved `c913269` actual viewport
witness, and all six static states in the durable-native-design archive (inline,
retained, multiple, removed, compact/dark and narrow). Those images demonstrate
layout only. The original viewport test remains unchanged; this prototype cannot
claim to make production Live Preview pass it.

The original actual witness first enters a nested Base cell with click then Enter,
types `9`, scrolls the real CM scroller away and back, and cannot find a reachable
input containing that draft. Its existing root remains the implementation evidence.

## Smallest useful boundary

Add an **unwired internal presentation module**, a test-only browser bundle entry
and an Electron regression file. Do not change App, MarkdownView, production Live
Preview/EmbedWidget, renderer, Canvas, Base, public APIs or dependencies.

The harness opens an ordinary synthetic Markdown owner, then mounts a temporary
prototype editor host into its connected body. The existing Markdown root owns a
prototype child scope. The prototype uses an actual CodeMirror EditorView with
normal document transactions/history/virtualization; it is not the owner's
production LP editor or a replacement for its source-save policy. The production
editor can be hidden by the test harness while the connected prototype is active;
its original state is restored only after safe prototype teardown.

A stable layer is a sibling of the prototype CM view. Each occurrence allocates
one stable presentation root directly under that layer. Register its child scope,
append its root and native Canvas container while connected, and only then await
`CanvasView.setFile`. Canvas mounts the real note/Base subtree through the actual
App renderer. No native DOM, input, writer or scope is faked. The harness bundle
passes the existing parent scope; it does not create a second App registry root.

The CM widget is only a measured placeholder/anchor lease. Widget destruction
releases that exact lease and schedules reconciliation; it never closes or moves
the native subtree. Same target twice means distinct occurrence records and
independent Canvas/Base views. Full identity includes the mapped source interval
and occurrence generation, not just filename. A replaced target gets a new record;
an unfinished old record retains its original target. A stale lease cannot clear
a newer lease. No source text or undo transaction originates in measurement.

Only the fixture's explicit, full-line Canvas embeds are recognized. This is a
bounded parser for the prototype, not general Markdown syntax support. The initial
proof uses one actual Canvas → file note → Base chain, then two same-target
occurrences. Source removal and remapping are exercised through real CM changes.

## Geometry and retained controls

Use CM `requestMeasure` read/write phases, ResizeObserver and actual scroller
observations to coalesce positioning. Read anchor/layer rectangles first; write
CSS placement afterward. Anchor placeholders reserve a measured height with a
stable initial estimate. Frame/height changes request a later measure only when
the value changed. A regression counter checks no runaway measure/resize loop.

The layer is pointer-transparent; native roots enable pointer events. Inline
records align with their connected anchor. Offscreen or removed-source unfinished
records keep **the same root and parent** and move by CSS coordinates into a
visible retained shelf. Scroll, geometry and shelf transitions never focus, blur,
make the native root inert, use display:none on it, reparent, clone or remount it.

For the two-record proof, use a bounded retained shelf with an ordinary accessible
scroll control. The roots remain direct children of the stable layer: a separate
scroll rail supplies shelf offset; CSS positioning and clipping bound retained
records to the shelf viewport. The rail must not cover native inputs. This is the
riskiest geometry seam; if clipping/scrolling cannot keep normal focus and pointer
interaction, stop and return the failed proof before broad wiring.

Retained labels identify occurrence/source/target. Return scrolls the CM editor to
the mapped valid anchor and keeps the same native root. Removed-source records
show their original target and omit Return. Original Base Save/Cancel/Retry remain
the only mutation controls; the layer does not implement another save path.
Normal deliberate focus transfer retains existing Base blur semantics. Tests that
need a draft to survive source editing first establish that the lifetime action
itself does not cause blur; ordinary user blur is not a failure witness.

A clean unanchored record prepares and closes through its existing child scope
exactly once, then removes its presentation. A refused or failed preparation keeps
its connected root and registry entry. Pending initialization is tracked from
before its first await and must cancel without late publication. No timeout drops
unfinished work. Prototype owner teardown prepares all records as one affected
forest; refusal keeps the original connected controls.

## Regression-first acceptance

1. **Controlled units:** occurrence mapping/duplicates, exact anchor leases,
   source removal/retarget identity, coalesced scheduling and successful/failed
   retirement with actual RenderScope. Fake rectangles may test arithmetic only;
   they do not count as native lifetime proof.
2. **Actual single occurrence:** click then Enter into the real nested Base, type
   `9`, scroll the actual prototype CM scroller out/back. Assert the captured input,
   native root and parent are identical/connected; draft remains reachable and
   focused without focusout; exact Source bytes remain original after each action.
   Submit with original controls and require exact saved bytes and displayed `9`.
3. **Geometry:** actual pane resize and Electron zoom, clipping and normal text
   selection/typing outside native roots; compare source and undo state before/
   after geometry. Root/Canvas/Base identities must remain stable. Light and dark
   captures plus a small-pane capture document layout limitations honestly.
4. **Duplicates and shelf:** two same-target occurrences, distinct actual writers,
   draft ownership and labels. Retained shelf scrolling makes both original
   controls reachable; no unexpected writes/blur. Return is offered only for a
   current mapped anchor. Tab hide/return preserves the same root and draft.
5. **Removal/recovery:** real CM removal/retarget keeps unfinished original controls
   connected with no Return. Exercise original Cancel and failed row write then
   actual Retry with exact post-action Source bytes. No copied draft or scope-key
   bypass. Known same-file concurrent writes are not asserted safe by this proof.
6. **Lifecycle races:** delayed actual Canvas read, anchor destroy/reacquire,
   removal before mount finishes, parent close refusal and successful clean close.
   Instrument real native instances to count allocation/close; assert one close,
   no late publish and no steadily growing clean-record registry after churn.

Run targeted units, typecheck/build and only coordinator-assigned actual Electron
slots. Freeze source for independent review before broader integration decisions.
Archive exact test/source hashes, explicit state JSON and inspected screenshots.
The prototype is successful only within the tested fixture/geometry states; full
production syntax, autosave/undo integration, arbitrary plugin render children,
PDF embeds and complete viewport/parity guarantees remain outside this package.
