# Private native presentation retirement feedback

Date: 2026-10-15. Task `5ebcf1f8-5fab-421f-8ab8-1989300588b7`, accepted ADR0038
prototype scope. This is a module-local correction in the unwired prototype;
generic RenderScope and production App/Markdown/Canvas/Base entries are unchanged.

The preserved fda51b2 two-case Electron diagnostic fails both original assertions.
Read-only close refusal produces 1,804 validation/retirement/Base-resume/Canvas-resume
cycles and 34,275 content mutations in the 30-second interaction timeout; the
root stays connected and provider bytes unchanged. These counters alone establish
correlation. A paired controlled scheduler test establishes the feedback mechanism:
without a resume notification, attempts stay [1,1,1,1] through three geometry turns;
with one notification from each real child resume, attempts become [1,2,3,4].
The corrected MutationObserver double implements observe/disconnect/takeRecords
and queued delivery semantics. Baseline source remains RED after that correction.

Observing all content changes during retirement preparation remains necessary:
external async completion can make a refused native view ready to close. Disconnecting
through the complete asynchronous retirement would lose that signal. Instead,
only this occurrence's scope.resume instance is wrapped, retaining its original
receiver and exact exception. Before its synchronous recursive resume, queued
external records become retry intent. Observation pauses only for synchronous
Base/Canvas redraws; finally it resumes for the same live record and requests
geometry. Async notifications after resume remain observed. Admission pauses
alone do not disable observation. The wrapper is restored only if still owned,
on record retirement or projection disposal; stale callbacks cannot reobserve a
retired/replaced/closed record.

Tradeoff: the private experiment wraps its own child scope's resume method rather
than adding a generic lifecycle hook/API. This keeps shared ownership semantics
unchanged but depends on the currently synchronous recursive resume contract.
If native resume starts awaiting redraw work, revise the explicit lifecycle seam;
do not silently broaden observer suppression to future async callbacks.

Focused checks cover own-notification suppression, independent post-refusal and
pending async notifications, queued records before resume, all four recovery
events, paused admission, original exception identity/finally observation,
closed/disposed stale callbacks and coalesced retirement. Existing fail-closed,
pending-mount and source-reconciliation tests remain. The final focused run has
29 passing checks. Actual Electron two-case and complete prototype regression
verification are still required before claiming this correction works in the app.

The second Retry hit assertion and all prior input/camera/rail actions remain
unchanged. A synchronous probe at that assertion records full ancestor/offset-parent
geometry, overflow, transforms, scroll state and hit stack. This is diagnostic
instrumentation, not a positioning correction or proof that the Retry issue is fixed.
