# Combined native/daily regression corrections

Source baseline: frozen integration `ef18b43a23947c16564e55ece845f08b09215216`.
This isolated correction branch preserves the original integration and feature
branches. No complete parity, full gate or release claim accompanies this note.

## Canvas recovery alert

Task `4cfe63f9-f6c8-4282-90ef-b9e1a403c743` → native ownership Solution
`ac76d20b-1183-4698-af07-21e3d0560dfe`. The coordinator's actual full Electron
run failed both attempts after repaired nodes/edge became visible: the old alert
remained. Stable Canvas presentation reconciliation no longer clears the viewport.

A controlled DOM-tree unit using actual applyLoadedText/enterRecoveryMode/render
reproduced the stale alert: one failing case and two passing invalid/refused-load
cases. The fix retains the exact owned alert and removes it only after validated
text is accepted, before rendering recovered nodes. It does not clear the whole
viewport, dispose siblings, save bytes, change the camera or bypass preparation.
The three focused suites then passed (exact result in the run log). The unit uses
synthetic DOM elements and stubbed node content; the existing real manual Retry,
automatic repair, no-write, vendor-schema and camera recovery flow remains required.

RED: `geode-canvas-error-presentation-red.log`.
GREEN: `geode-canvas-error-presentation-green.log`.
Independent review, typecheck/build and coordinator-granted actual Electron remain
required before this correction is carried to the frozen integration.

## Footnotes native navigation

Task `d1a0384b-8282-4b1a-a352-862be5c2f0af` → Footnotes Solution
`e0b922c6-e23d-49ae-9bfe-a53df1c76a96`. The previous synchronous navigation
started an asynchronous Reading reveal and source toggle concurrently, selecting
before those transitions settled. An actual MarkdownView-method/RenderOwnership
harness reproduced thirteen failing navigation cases before source changes.

Navigation now awaits reveal, then source mode if required. Each await is followed
by captured pane, active leaf/view/editor, indexed file, Vault/root, source snapshot
and editability checks. A separate latest-navigation generation invalidates older
requests without treating ordinary metadata refresh as a new navigation. Current
real errors appear in the pane; native cancellation and stale owners remain silent.

Actual native methods also focused before the caller could check whether its pane
had closed or become hidden. Three focus regressions reproduced that behavior:
four intermediate/final focus calls in the happy path, and two after each stale
pane transition. The coordinator authorized an internal optional no-focus control
for native reveal/source toggle; Footnotes alone opts out, then focuses once after
its final checks. The public void View adapter is unchanged. Existing Workspace
subpath, App command/link/offset reveal, comment reveal and mode-refresh callers
retain default focus behavior; the default itself has a regression assertion.

The tests use actual transition/preflight/mode methods with a controlled editor and
DOM host. They prove async ordering, both await boundaries, active-owner changes,
read-only/stale snapshot/root/index cancellation, native child refusal and error
reporting. They do not prove real browser focus/layout or actual note undo/autosave.
The existing three real Footnotes flows and Canvas manual/automatic recovery flow
remain required in the coordinator-granted Electron slot.

RED ordering: `geode-footnotes-native-navigation-red.log` (13 failures).
RED focus: `geode-footnotes-native-focus-red.log` (3 failures, 16 passes).
Focused GREEN: `geode-integration-regressions-focus-green.log` (78 passes before
the additional default-focus case). Final focused/typecheck/build results are
reported with the frozen checkpoint; no full-suite or browser result is inferred.
