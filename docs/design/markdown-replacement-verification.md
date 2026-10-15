# Explicit Markdown replacement: verification checkpoint

Delivery Task `4eb92b7d-3749-464a-8398-6e7fefa34682` → parent Workspaces Task
`93f1491d-7139-4451-885c-fc34c4c30780` → Solution
`ac76d20b-1183-4698-af07-21e3d0560dfe` → behavior KR
`c3b390f0-92a8-479c-b629-2b6745d577d5`.

The coordinator accepted ADR-0038 package 1, its exact recovery-receipt addendum,
and ADR-0040 under the user's explicit reversible implementation authority. This
checkpoint is for independent review, not a completion or parity claim.

## Implemented boundary

Explicit Reading refresh, mode/source changes, file replacement, external text
acceptance and recovery restoration prepare all owned projection children before
changing the buffer, mode, file/title or DOM. Root operations serialize requests;
child retirement cannot drain its own root task. Complete initial child preflight
precedes the temporary body interaction lock and asynchronous work. Failed
preparation restores the old connected controls and prior interaction state;
partial destruction remains closed. Focus restoration respects the current pane
and intentional moves to another pane/header. Resume schedules a guarded refresh.

Native App/Workspace offset/comment/subpath callers await actual replacement and
check the captured owner/file after waits. Public void reveal adapters report
refusal. A clean rename may already have completed in storage when a later pane
refresh refuses: the notification states this boundary and promises no rollback.
Any unresolved recovery in an open affected source or referencer split refuses
rename before storage mutation, even with a valid preservation receipt.

Ordinary recovery close requires an exact receipt minted from the existing actual
conflict copy or confirmed device record. It revalidates indexed destination and
bytes/current owner after mutating child preparation. Missing/mismatched receipts
keep the local view; no close-time recovery write is added. Named-layout readiness
continues to refuse unresolved recovery. Provider write guards remain unchanged.

ADR-0040 separates read validation from keyed write preparation. The complete
forest finishes preparation before validation, then performs final synchronous
preflight and another commit-gap preflight. Its private destruction indicator
allows a rejected pre-destructor commit to abort/resume once. Read refusal never
requires an invented save acknowledgment; genuine failed writes retain their keys.

## Evidence recorded before implementation

On unchanged production `1dc7e0a`, two actual Electron flows entered a nested Base
cell using click then Enter, typed `9`, and invoked Reading refresh or source-mode
replacement. Both failed because the captured input became disconnected; both
post-action snapshots proved exact original Source bytes remained unchanged.
The coordinator retains the exact source/test artifacts and logs. These are the
valid regressions for this package, separate from double-click entry and viewport
virtualization findings.

New controlled regressions also established refusal before parent flush/mode/file/
title/DOM changes, read-validation poisoning of a save key, late commit preflight,
sibling preparation/work settlement, and recovery-copy changes during child flush.
Their RED logs are retained in the coordinator's local run archive.

## Current checks and remaining gates

Focused scope, renderer, Markdown, Canvas, external-change, navigation, conflict
and preview tests pass; exact counts and checked commit are recorded by the
coordinator after source freeze. Typecheck and build run on local locked dependency
versions (Electron 42.10.0, Vitest 4.1.11); no compute offload is configured.

The default Electron regression file `markdown-owned-replacement.spec.ts` preserves
both original connected-draft assertions and adds actual Enter submission with
exact saved Source bytes. It requires the coordinator's serialized Electron slot.
Actual durable-copy ordinary close, changed-after-receipt refusal, independent
review and full unit/Electron gates remain required before a tested PR.

This package does not provide persistent presentations across CodeMirror viewport
virtualization, solve the separate double-click entry defect, implement named
Workspaces runtime switching, integrate PDF embeds or claim same-note concurrent
frontmatter-write integrity. Those remain separate work with their own evidence.
