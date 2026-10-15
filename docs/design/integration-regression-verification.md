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
