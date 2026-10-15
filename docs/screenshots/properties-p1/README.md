# Properties integration visual evidence

Captured 2026-10-15 on Linux test-worker-2 in lockfile-installed Electron 42.10.0
from source `80a9d20`. All notes and values are synthetic. Real controls drive the
actual app; all six P1/P2 and refusal captures were inspected for alignment,
focus, body preservation, complete datetime strings and overflow.

- [Live Preview and file pane](live-preview.png): 1280×840. Shared controls, one comma-containing list item, unsaved body preserved after undo.
- [Reading and file pane](desktop.png): 1280×840. Reading immediately displays buffer `status: reading`.
- [Narrow window](narrow.png): 920×680. Both sidebars open and property controls fit.
- [Refused draft](properties-refused-draft.png): 1280×815. Sidebar retains `refused draft` while body/source still displays `old`; sibling count focus does not discard the field. The visible message requests returning to that field to retry or discard.

The new refusal test uses the actual Markdown conflict-read-only guard as a
controlled stimulus; it does not simulate a complete sync-conflict workflow.
It asserts exact connected input identity, draft retention, unchanged live buffer
and disk, then own Enter retry and Escape discard. The five P1/P2/refusal flows
all pass first attempt. Full remote suite: 384 ordinary passes, one unrelated
Note Composer merge retry pass, 15 existing skips, zero repeated failures.
Full report: configured archive `Products/Geode/Runs/geode-2026-10-15-properties-delivery-qa.md`.
These captures are branch verification, not complete Properties parity or release verification.
