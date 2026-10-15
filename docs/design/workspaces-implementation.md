# Workspaces implementation checkpoint

Date: 2026-10-14. Task `93f1491d-7139-4451-885c-fc34c4c30780` → Solution `ac76d20b-1183-4698-af07-21e3d0560dfe` → KR `c3b390f0-92a8-479c-b629-2b6745d577d5`. Base: main `b939adf`. Scope follows accepted [ADR-0032](../adr/0032-named-workspace-runtime-switching.md) under the user's overnight tested-PR authorization. No merge or release is authorized.

## Independent components

- `NamedWorkspaces`: per-vault serialized configuration operations. Same trimmed name updates the existing stable ID; deletion removes only that saved record. Validate and clone the current store on each operation; unreadable data refuses writes. Configuration writes must succeed before returning a saved record. The store has a total 2 MB serialized limit, at most 100 names of 120 characters, and bounded layout nodes/depth/leaves. Old queued vault operations are rejected. Cross-window revision-checked writes remain out of scope.
- `validateNamedLayout`: validate persisted versions 1–3, finite dimensions, tab indexes, view types and vault-relative paths, then normalize through the existing migration. Plugin state is opaque bounded JSON.
- `WorkspacesModal`: existing Modal conventions, labeled Name, Save, saved rows with Load/Delete layout, visible status/errors and concurrent-action guards. Failed writes preserve input and records. [Standalone visual reference](workspaces-manager-reference.html) does not replace the separate Properties design artifact.
- `layout-writers`: generic internal adapter transaction, preflight all writers and same-path buffer consistency before any flush, pause the full set, settle each writer and verify acknowledged state. Abort resumes original writers; successful completion provides an explicit resume handle for retained writers. It is not yet connected to the runtime layout coordinator.

## Native ownership prerequisite

The accepted ADR-0032 addendum (`5f4ae06`) selects internal render ownership scopes. Markdown, Canvas and Base views now register native owner scopes before initialization; native descendants inherit their parent's scope. MarkdownRenderer/transclusions, Live Preview direct Canvas embeds and Canvas Markdown roots all carry scope identity. Pending tasks are registered before initialization runs; generation checks refuse late publication. Widget destroy and ordinary renderer disposal initiate memoized tracked close paths, while native owner close awaits descendant settlement. Failed pending writes stop teardown before a destructor can discard draft state. Failed close scopes remain registered and are not retried implicitly.

Base preflight refuses active cell drafts/recovery, and settlement awaits both definition and source-row writes. Pending targets remain tracked until every operation on that note settles. A rejected fire-and-forget definition write is observed without clearing the queue's rejected state, so the barrier can report it. Canvas preflight refuses recovery/conflict/gestures before pause could roll back a gesture, then settles its current document. Native resume callbacks recreate canceled render projections while keeping the owned note buffers.

Completed standalone read-only Markdown renders retire their temporary registry root, avoiding a strong reference leak. Standalone renders that own native writers remain visible and fail closed if no workspace owner is registered. Unknown plugin side effects remain outside atomic rollback guarantees.

Runtime layout replacement, App/vault mutual exclusion, adapters/coordinator and core-plugin registration remain unimplemented at this checkpoint. Startup deserialize is not used against a live workspace.

## Verification checkpoint

Local machine; no compute-offload entry exists in `pm-config.md`. This worktree's dependency symlink now points to the separately installed lockfile dependencies (Electron 42.10.0, Vitest 4.1.11). Nine targeted unit files pass, 66 tests, covering storage/validation, manager errors/concurrency, generic writer ordering/rollback, recursive ownership/late cancellation/close-once, actual renderer note/Base/Canvas mount producers, native writer recovery/drafts/queues and existing Bases/Canvas regressions. Typecheck and build pass on those dependencies.

No Workspaces full unit suite, Electron/runtime layout test or screenshot verification has run. These are prerequisites, not completed Workspaces parity. Required full gates and independent review remain pending runtime implementation. The native lifecycle changes are frozen for independent review before the App/Workspace transaction is implemented.
