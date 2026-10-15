# Base blur-save focus recovery

Task `e8e4c4b8-9f12-4641-964a-ca05c37f17f1`, parent native-layer prototype
`5ebcf1f8-5fab-421f-8ab8-1989300588b7`, Solution
`ac76d20b-1183-4698-af07-21e3d0560dfe`.

The coordinator accepted this bounded routine focus correction under the explicit
overnight build authority. Alternatives considered were retaining the focus trap,
a prototype-specific shortcut/Retry exemption, and an internal commit-trigger
distinction. The last option preserves ordinary user focus behavior without
coupling Base to the experimental presentation layer.

A real Electron keyboard Return probe at prototype source `b309e13` failed before
activation: focusing Return blurred the failed Base input, triggered a resubmission,
and failure handling focused the original input again. The input/draft and provider
bytes remained intact. This was a reachability failure, not saved data loss.

The table now distinguishes saves caused by blur from explicit Enter/mobile Save.
A failed blur save keeps the same draft and failure handling without focusing it.
Explicit failures retain recovery focus while the original input, table, or
captured explicit control still owns focus; a delayed failure does not reclaim a
new pane/control. Existing edit identity, current read-only state, error propagation,
exact Retry and acknowledgment semantics remain in force. No persistence or public
API changes are included.

New controlled actual-table-method tests first reproduced blur and delayed explicit
focus theft, then passed. They cover retained draft/value and callback identity,
Enter and mobile Save recovery, successful blur, and read-only admission. Existing
stale-session/new-editor/read-only completion and exact recovery tests remain green.
The focused seven-file matrix passes 48 tests. Repository typecheck and normal
build pass locally against the exact matching dependency lock (Electron 42.10.0).
The new worktree uses the integration dependency directory; its lock SHA256 matches
this branch. An initial attempt using the older dependency directory failed because
PDF dependencies were absent and is excluded from final verification.

Independent review, actual prototype keyboard rerun, and complete integrated gates
remain pending. The prototype remains unwired and its original production viewport
regression remains open. No keyboard accessibility or parity clearance follows from
controlled tests alone.
