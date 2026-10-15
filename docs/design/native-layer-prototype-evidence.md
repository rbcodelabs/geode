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
