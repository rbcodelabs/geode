# File Properties and property types delivery

Date: 2026-10-15. Current delivery combines P1 reusable in-note/sidebar controls and
P2a shared persisted property types under Solution
`523dc576-9b4d-4028-a8d3-e2e5f765d45a`, KR
`c3b390f0-92a8-479c-b629-2b6745d577d5`, Tasks
`e7954a61-948a-4c00-b74d-227692c1c0fc` and
`c8d407d1-9e59-40ae-bb64-6b7862649752`.

Authority: user's overnight audit/design/implementation/verification instruction
through tested PRs; plan Doc `8754c2d2-26fa-4695-b2d5-5ef973ae8489`, revision
`73e29b29-1fe8-495f-95b0-3d4d8f702e17`. Merge/release remain separate.

The [accepted design](properties-parity.md) is copied unchanged from `b0b44d2`.
Original P1/P2 implementation notes and screenshots are historical evidence;
their deferred P2 wording and local compute decisions are not current status.
Current complete verification uses the configured shared testq pool.

The isolated delivery branch stacks on tested Editor implementation `a47e26d`.
Only the eight original P1/P2a commits were replayed. Shared App/Markdown/CSS
integration retains Outgoing and Editor behavior. The final shared PropertyEditor
blob is copied exactly from `3bb4705`; no native Reading coalescer, RenderScope,
PDF, Footnotes or native child ownership code is included.

Current nonnative regressions reproduce the refused-field loss before the fix:
10 new failures and 16 passes (14 existing cases plus two already-correct new
cases). After the exact control fix, all 26 cases pass. Refused text fields retain
their exact draft across blur/metadata refresh and block unrelated actions until
their own retry or explicit Escape; blocked checkboxes restore their presentation.
Generic checkbox/type errors retain appropriate recovery actions.

A controlled real Electron regression sets the existing Markdown conflict-read-only
guard, then tests refusal, guard clearance without refresh, blur/metadata refresh,
sibling no-op, unchanged buffer/disk and exact input identity. Own Enter retry and
Escape discard recover explicitly. This exercises the actual guarded adapter;
it is not a complete sync conflict workflow test. It runs in the full remote gate.

The independently reviewed SSH EOF-diagnostic prerequisite `4069b8d` is copied as
a separate five-file patch. Its standalone verification/Task remains separate;
copying its patch does not establish git ancestry or imply its separate PR passed.

At preparation time, full packaged typecheck, units, build and entire Electron
suite remain pending. Durable current QA/results and fresh capture embeds live
at `Products/Geode/Runs/geode-2026-10-15-properties-delivery-qa.md` in the
configured reporting archive. No complete Properties/Obsidian parity claim.
Global property inventory/search/rename, document presentation and remaining
keyboard behavior remain outside this P1/P2a package. Generic config read still
conflates absent and malformed/unreadable JSON; no stronger claim is made.


## Completed branch verification

Exact implementation `80a9d20` passed all six remote steps on test-worker-2:
types/build, 330 unit files with 4,847 ordinary passes, one inherited expected
failure and three opt-in benchmark skips; complete Electron 384 ordinary passes,
one unrelated Note Composer merge retry pass and 15 existing skips, zero
repeated failures. The five Properties/type/refusal flows pass first attempt.
Artifacts fetched with checksum manifest verification; six fresh synthetic
captures inspected and delivered with source/date/Linux/dimension captions.
Later documentation/capture updates do not change source, tests or dependencies.
This supersedes the preparation-time pending checkpoint above, not its history.
