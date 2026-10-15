# Native layer experiment: first review checkpoint

Task `5ebcf1f8-5fab-421f-8ab8-1989300588b7`, parent Workspaces Task
`93f1491d-7139-4451-885c-fc34c4c30780`, Solution
`ac76d20b-1183-4698-af07-21e3d0560dfe`.
The coordinator accepted proposal `7b9b46b` before implementation. This is an
unwired experiment, not a production viewport fix or tested product PR.

## Fresh actual baseline

The unchanged production app at source `c0e7e5e` / evidence `49a29e0` was rebuilt
with Electron 42.10.0. The copied original viewport witness used normal click then
Enter to enter the real nested Base editor and type `9`, then scrolled actual
production CM away and back. An added post-action JSON snapshot was written
before assertions. It establishes:

- Captured input disconnected, still containing `9`.
- Actual focusout events recorded; current active element became the body.
- Source priority changed from `2` to `9`, with Original source body intact.

The provider-byte assertion failed first. This fresh run establishes an incidental
scroll-time submission and disconnected control, stronger than the older witness
whose final byte assertion was never reached. It does not establish lost saved
bytes or a prototype result. The coordinator retains the exact spec, production
bundle hashes, source commit, event/state JSON and screenshot archive. The default
`native-layer-baseline.spec.ts` remains a real failing production regression;
no full-green suite claim is possible while the layer is unwired.

## Implemented experiment boundary

The private module is imported only by the dedicated test fixture bundle. App,
MarkdownView, Live Preview, Canvas, Base, production build entries, public exports
and dependencies are untouched. The fixture owns an actual CM editor under an
existing connected Markdown-owned child scope. It mounts real Canvas instances,
which use the actual App renderer for note/Base descendants. The existing parent
scope is passed explicitly; no second native ownership registry root is created.

Each native presentation is appended to its stable layer parent before its tracked
initializer starts. CM owns only block placeholders and exact anchor leases.
Occurrence mapping keeps same-target duplicates independent and does not reuse a
removed/retargeted record. Native root placement is CSS-only; shelf clipping and a
separate scroll rail are the main unproven geometry seam. The initial experiment
uses a fixed 320px native frame, matching placeholder estimate, and at most eight
admitted records; this does not prove arbitrary dynamic native heights or a global
resource bound. Clean scopes retire only through awaited existing preparation;
refused scopes remain connected. No alternate save, cancel or retry is added.

## Checks performed

- Eight new controlled tests passed after behavior REDs: occurrence identity/map,
  retarget/removal, placement arithmetic, stale leases, real RenderScope refusal/
  retry and pending operation cancellation. Fake geometry is arithmetic evidence
  only, never native lifetime proof.
- Scope/retirement/prototype focused matrix: 38 tests in three files pass.
- Repository typecheck passes. The test fixture also passes a dedicated TypeScript
  configuration. The private browser bundle builds separately; production build
  configuration does not import it.
- Six actual Electron prototype tests are written and discovered, but **unrun**
  at this review checkpoint. They cover single nested scroll/save, resize/zoom/
  source/undo, source removal/Cancel, actual failed write/Retry, independent duplicate
  native chains and pending actual Canvas mount cancellation.

Actual input/focus/bytes/connected-parent results remain required after independent
review and a coordinator-assigned Electron slot. Tab visibility with intentional
focus transfer, multiple retained failures, narrow/dark layouts, pointer/text
editing and clean viewport churn remain additional acceptance work. No claim that
the prototype fixes production LP, preserves an active draft across a deliberate
user blur, or completes Workspaces/Obsidian parity follows from this checkpoint.

## First review correction batch

The coordinator read the complete initial module, fixture, tests and evidence.
Corrections preserve mount-error text through geometry, refuse allocation when
the current owner is frozen/closed, and prevent a retirement continuation from
allocating a replacement under a closing owner. Partial destructor failure is
retained as a terminal failed-closed record: no automatic retry/remount, inert
native root, Return hidden and a visible alert. A pre-destructor refusal retains
admission and can retry after the original draft finishes. If an external ordinary
close is still preparing, the record observes its completed drain result before
classifying it; a failed read that restores admission is not partial destruction.

Six new controlled regressions establish these classifications and preserve the
original genuine-preflight retry case. The focused matrix now passes 44 tests in
three files, including 14 prototype tests. Repository/fixture typechecks and the
private test bundle pass. Final actual-test JSON now includes captured input
connection/value/focus/blur and stable-parent metrics even on assertion failure.
The six prototype Electron tests remain unrun at this second review freeze.

Before broad wiring, a trusted Return-button pointer proof and actual duplicate
shelf hit testing are still mandatory: private Return calls, `isConnected` and
`toBeVisible` alone do not establish correct browser focus order or occlusion-free
pointer reachability. No product-safety claim is inferred from this correction.

## First actual matrix and pending-mount correction

At frozen `5dfd9e5` (private module source `84fc1d7`), six unique real Electron
42.10.0 cases ran with retries disabled: **five passed, one failed**. Single native
scroll/save, resize/zoom, removed-source Cancel, failed-save Retry and duplicate
native-chain identity passed. The inspected retained-before-save capture shows the
original focused `9` in the shelf; the file-name column is clipped by the fixed
experimental frame, so this is not complete layout/accessibility clearance.

The pending real Canvas read case failed: source removal updated the occurrence
map but waited for a geometry frame to start retirement. Releasing the read in
that gap allowed `Canvas.file` to become `Board.canvas`; the resource subsequently
closed once and disconnected. The exact assertion, including `file === null`, is
retained. Full first-case and remaining-five archives (spec, source/bundle hashes,
JSON, screenshots and results) are held by the coordinator at
`/private/tmp/geode-native-layer-prototype-first-artifacts` and
`/private/tmp/geode-native-layer-prototype-five-artifacts`.

A new controlled reconciliation regression reproduced late publication before the
fix. Reconciliation now starts removed-record retirement synchronously, using the
same preflight/prepare path as geometry retirement. Existing draft refusal leaves
the original scope usable; it never bypasses preflight or invokes an immediate
destructor. A shared coalesced retirement continuation prevents duplicate cleanup.
The focused three-file matrix passes **46 tests**, including 16 prototype cases;
repository and fixture typechecks, private bundle and normal app build pass.
The actual pending-mount regression has **not yet been rerun** on this correction.
No change was made to production entry points or the known production viewport RED.

## Trusted Return focus regression

At `e17fcc1` / corrected source `e080946`, the original six actual cases all pass
with retries disabled, including pending Canvas cancellation. Both new trusted
Return cases fail: the browser's pointer default focuses Return, blurs the original
native editor and persists priority `9` before the viewport-only handler runs.
The later-inline center hit test itself passes; its subsequent click exposes the
same focus defect. Provider body bytes remain intact. Exact JSON/screens/spec and
bundle hashes are archived at `/private/tmp/geode-native-layer-prototype-eight-artifacts`.

The bounded correction prevents only primary pointerdown's default focus on
Return. Click still invokes the ordinary viewport action; keyboard activation and
intentional focus transfers remain available. Existing two actual RED assertions
are unchanged. An additional keyboard-activation case explicitly transfers focus
with a retained failed native write and presses Enter; that deliberate blur is
not represented as the no-blur pointer invariant. Actual corrected Return results
remain pending coordinator review and an Electron slot.

At `b309e13`, the actual nine-case run finishes **8 PASS, 1 FAIL**, retries0.
Both original trusted pointer Return failures are GREEN: exact priority `2` and
Original source bytes, connected original input `9`, unchanged direct parent,
zero viewport/Return blur events and retained focus. The keyboard case fails
before activation: deliberate Return focus blurs the failed editor, its ordinary
resubmission fails, and Base's existing catch focuses the original editor again.
The final JSON records connected input `9`, same parent, two blur events and both
provider files unchanged. Return never remained focused, so keyboard activation
was not established. This remains a default-discovered failing regression; there
is no full-green suite or parity claim. No Base policy change was made.

The coordinator has exact final artifacts at
`/private/tmp/geode-native-layer-prototype-nine-artifacts`, with the actual log at
`/private/tmp/geode-native-layer-prototype-nine.log`. Selected synthetic captures
are linked from `../screenshots/native-layer-prototype/README.md`. Multiple
simultaneously retained failures and their actual rail reachability, tab visibility
semantics, readonly/partial-failure UI, narrow/dark state and clean churn still
require additional proofs before production wiring.

## Focus correction and narrow header boundary

The independently reviewed minimal Base blur-focus correction `35f0268` was ported
as `07eaeed`, without the unrelated integration/Entry changes. Its separate full
unit gate passes 380 files: 5,203 ordinary passes, one expected-failure diagnostic
and three existing skips, exit0, 247 seconds. This does not include the private
prototype branch's actual default production viewport RED.

At `07eaeed`, the actual twelve-case matrix finishes **11 PASS, 1 FAIL**, retries0.
Keyboard Return now passes without changing the original assertion. Owner close
refuses the original connected `9`, then actual Cancel permits one awaited close.
Clean viewport churn retires and reacquires a fresh actual native chain. The dark
760px desktop case keeps exact original provider bytes, focused connected `9`,
same parent and zero blur, but Return's center hit-test fails. With both desktop
sidebars visible, the remaining center pane is very narrow; the header's label
pushes Return beyond its clipped right edge. The Base priority column is also
clipped. Archive: `/private/tmp/geode-native-layer-prototype-twelve-artifacts`.

The coordinator accepted a private header-only correction: wrapping rows inside
the same fixed native frame, auto header height, shrinkable/truncated label with
full text/title preserved, and Return constrained to available width. No native
root is moved, focused or replaced. The original dark hit assertion remains.
Actual rerun is pending. Even if Return passes, this does not establish reachable
Base columns or complete narrow/mobile layout support.

At frozen `f08a1de`, the unchanged actual twelve-case matrix passes **12/12** with
retries disabled, 11.8 seconds, Electron 42.10.0. The real dark/narrow Return center
hit test now passes. Final JSON still records connected/focused `9`, unchanged
native parent, zero blur and exact original Source bytes. The dark capture was
visually inspected and committed with its viewport/source/environment caption;
the Base priority column is still clipped and no complete narrow layout claim is
made. Full results, spec, source/bundle hashes, JSON and screenshots are preserved
at `/private/tmp/geode-native-layer-prototype-header-twelve-artifacts`, log
`/private/tmp/geode-native-layer-prototype-header-twelve.log`.

Remaining acceptance includes multiple simultaneously retained failures and rail
pointer/keyboard reachability, normal outside-editor typing/undo, actual tab hide
versus intentional focus transfer, retargeted old-draft recovery and readonly/
partial-teardown UI proofs. Original production viewport failure remains open;
private twelve-case success is not a full-suite or production wiring clearance.
