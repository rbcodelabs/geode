# Shared property types visual evidence

Captured 2026-10-15 on Linux test-worker-2 in lockfile-installed Electron 42.10.0
from source `80a9d20`. Note, vault and values are synthetic. Both captures were
inspected: complete local datetime including seconds fits in the roughly 280px
sidebar, and unset checkboxes remain distinct. Below 450px property-container
width, date fields stack beneath keys, including inside the narrow note.

- [Desktop](desktop.png): 1440×900, shared Live Preview/sidebar types.
- [Compact](compact.png): 960×760, complete datetime in both surfaces.

Real Electron flows prove plugin/UI type agreement, local seconds, dirty body,
source-buffer undo, restart and rejected type persistence rollback without note
edits. The two type flows and the three P1/refusal flows pass first attempt.
All six complete remote gate steps passed; full Electron includes one unrelated
Note Composer merge retry and 15 existing platform/opt-in skips.
The run report in the configured reporting archive documents full counts and
limits. No global Properties or complete Obsidian parity claim.
