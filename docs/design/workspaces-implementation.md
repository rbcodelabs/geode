# Workspaces implementation checkpoint

Date: 2026-10-14. Task `93f1491d-7139-4451-885c-fc34c4c30780` → Solution `ac76d20b-1183-4698-af07-21e3d0560dfe` → KR `c3b390f0-92a8-479c-b629-2b6745d577d5`. Base: main `b939adf`. Scope follows accepted [ADR-0032](../adr/0032-named-workspace-runtime-switching.md) under the user's overnight tested-PR authorization. No merge or release is authorized.

## Independent components

- `NamedWorkspaces`: per-vault serialized configuration operations. Same trimmed name updates the existing stable ID; deletion removes only that saved record. Validate and clone the current store on each operation; unreadable data refuses writes. Configuration writes must succeed before returning a saved record. The store has a total 2 MB serialized limit, at most 100 names of 120 characters, and bounded layout nodes/depth/leaves. Old queued vault operations are rejected. Cross-window revision-checked writes remain out of scope.
- `validateNamedLayout`: validate persisted versions 1–3, finite dimensions, tab indexes, view types and vault-relative paths, then normalize through the existing migration. Plugin state is opaque bounded JSON.
- `WorkspacesModal`: existing Modal conventions, labeled Name, Save, saved rows with Load/Delete layout, visible status/errors and concurrent-action guards. Failed writes preserve input and records. [Standalone visual reference](workspaces-manager-reference.html) does not replace the separate Properties design artifact.
- `layout-writers`: generic internal adapter transaction, preflight all writers and same-path buffer consistency before any flush, pause the full set, settle each writer and verify acknowledged state. Abort resumes original writers; successful completion provides an explicit resume handle for retained writers. It is not yet connected to application views.

## Runtime integration discovery

Runtime layout replacement remains unimplemented at this checkpoint. Leaf-only autosave hooks are insufficient: MarkdownRenderer owns embedded BaseView/CanvasView instances outside Workspace leaves, and publishes their WeakMap entries after asynchronous mounts complete. Disposal invokes asynchronous closes without awaiting them. Live Preview also directly owns embedded CanvasViews. BaseView has source-note persistence and active cell drafts outside its definition persistence queue. These writers require an architect-selected ownership/admission/drain contract before loading can safely retire owners. The implementation must not call startup deserialize against a live workspace.

## Verification checkpoint

Local machine; no compute-offload entry exists in `pm-config.md`. Three targeted unit files pass, 23 tests: named storage/validation, writer transaction ordering/rollback/duplicate buffers and manager storage-error/concurrency behavior. Typecheck passes. No full units, build, Electron, runtime layout test or screenshot verification has run for Workspaces. These are independent components, not completed Workspaces parity. Required full gates and independent review remain pending runtime implementation.
