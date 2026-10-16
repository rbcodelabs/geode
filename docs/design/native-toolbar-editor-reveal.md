# Accepted bounded Canvas editor reveal

Task `bcf8cdcc-7ffe-47c5-974b-5e60b0fc877c`, parent native task
`5ebcf1f8-5fab-421f-8ab8-1989300588b7`, Solution
`ac76d20b-1183-4698-af07-21e3d0560dfe`.

Root accepted option A from the three-option proposal in the configured archive
`Products/Geode/Runs/geode-2026-10-15-native-toolbar-reveal-design.md`, with
independent review conditions. This is a reversible camera-policy decision:
a trusted Enter/double-click that creates a new editor may minimally move only
its owning Canvas to expose it. Passive focus, existing editor Enter/commit,
refusal refocus, unrelated controls and first mousedown must not pan.

Capture the initiating cell/table/node and pre-event editing state. Deferred
work qualifies only a new connected focused input in that exact cell, nearest
Canvas, current file/node/table and live admitted descendant lifetime. Coalesce
the same transition; reject stale/replaced inputs or queued different cells.
Recheck all authority/currentness immediately before camera mutation.

Measure actual clipped ancestor/surface intersection and the owning Canvas's
real toolbar/control rectangles. Use a finite minimum vertical translation;
no horizontal correction, too-small fallback, camera reset, forced dimensions
or speculative pan where no valid placement exists. Keep the connected root,
parent, focused draft, provider bytes and source/history unchanged.

The original two actual automatic-exposure failures at f58a7a8 and the separate
manual-pan positive control at 9e4c815 remain unchanged. The manual workaround
is not automatic acceptance. Source changes require meaningful regression-first
controls, complete source review and independent review before actual/full gates.
Navigation delivery B5a95 remains immutable; no new API, dependency, global
focus manager or App wiring is authorized. If event association cannot remain
small and exact, return to explicit callback option B for review.
