# Shared property types visual evidence

Captured 2026-10-15 in local locked Electron on macOS against source commit
`2bdee3f`. The note, vault and values are synthetic. Both captures were visually
inspected: the compact native type picker remains keyboard accessible, unset
checkboxes remain distinct, and the complete local datetime including seconds
fits in the roughly 280px file pane. Below a 450px property-container width, date
fields stack beneath their keys so the same controls also fit a narrow note.

- [Desktop](desktop.png): 1440 × 900 CSS pixels, shared Live Preview/file-pane types.
- [Compact](compact.png): 960 × 760 CSS pixels, complete datetime visible in both surfaces.

The actual Electron tests verify plugin/UI type agreement, local seconds, dirty
body preservation, source-buffer undo, restart, retained future type/config fields
and delayed storage rejection/rollback. All four P1/P2 flows passed without retries
on this source. The prior source passed the same flows three times (12/12) after
the test explicitly focused the body before undo; current captures include the
subsequent compact layout correction. Full-suite and independent-review evidence
remain separate; this is partial Properties parity.
