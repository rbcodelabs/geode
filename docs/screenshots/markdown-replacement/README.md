# Markdown replacement captures

Captured 2026-10-15 on source `c0e7e5e`, local macOS Electron 42.10.0 with the
locked dependencies. Default Electron window: 1280 × 840; PNGs: 2560 × 1680 at
2×. No Playwright viewport override. All files, names and note contents are
synthetic. These captures were visually inspected after the final ten-test run.

- [Reading retained draft](reading-retained-draft.png): after Reading refresh was
  refused and before Enter submission. The connected Base editor still contains
  unsaved `9`; the test also checks exact original Source bytes at this point.
- [Live Preview retained draft](live-preview-retained-draft.png): after source
  replacement was refused, before submission. The Canvas is horizontally panned,
  clipping the file-name column; this captures the retained editor, not complete
  Canvas layout accessibility. The test subsequently submits Enter and requires
  both exact saved Source bytes and the actual grid's `9`.
- [Newer recovery refuses close](newer-recovery-refused-close.png): the older
  conflict copy exists, but the newer local snapshot is not preserved by it.
  Ordinary close refuses; the local editor remains connected. The test verifies
  the old copy and provider bytes remain exact. The existing banner describes
  the older preserved snapshot; the image does not prove newer bytes were copied.

These local UI captures are committed for review. They do not establish native
mobile behavior, viewport virtualization safety, full desktop visual coverage,
production delivery or complete Obsidian parity.
