# Properties P1 visual evidence

Captured 2026-10-14 in local Electron on macOS against source commit `f8038cc`. All notes and values are synthetic. The associated test drives real controls and captures the actual app; these images were visually inspected for field alignment, focus, body preservation and overflow.

- [Live Preview and file pane](live-preview.png): 1280 × 840 CSS pixels. Both surfaces share controls; commas remain within one list item and unsaved body text survives isolated property undo.
- [Reading and file pane](desktop.png): 1280 × 840 CSS pixels. Reading immediately shows the buffer's updated `status: reading`, without waiting for the metadata index.
- [Narrow window](narrow.png): 920 × 680 CSS pixels. Both sidebars remain open; property controls fit the right pane.

`tests/e2e/file-properties.spec.ts` also verifies invalid-number retention/focus, dirty-input preservation across metadata events, duplicate-name/malformed YAML refusal, active-note switching, and read-only inspection of the checked-in demo vault copied to a temporary directory. Properties plus smoke: 5/5 pass with retries disabled; final expanded Properties: 2/2 pass with retries disabled. Full-suite results and independent review are tracked separately; these captures do not establish complete Properties parity.
