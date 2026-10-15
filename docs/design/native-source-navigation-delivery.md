# Native source navigation delivery

This package implements the ordinary navigation boundary from accepted
[ADR0045](../adr/0045-source-owned-native-markdown-integration.md), following
[ADR0038](../adr/0038-durable-native-markdown-presentations.md).

## Delivery provenance

Tracking: Compass Task `707fbc6c-3509-49ea-a516-f8ce984c56b8`, parent native task
`5ebcf1f8-5fab-421f-8ab8-1989300588b7`, Solution
`ac76d20b-1183-4698-af07-21e3d0560dfe`. The user's overnight parity authorization
covers this reversible implementation and verification; merge and release remain
separate.

The original production regression is preserved at
`49c68b09c1110606ae64fd7faec7d54179bd9307`: a trusted literal child-link click
saved a pending Base draft before navigation could refuse. Earlier pre-click
layout failures were setup evidence, not navigation regressions.

The focused implementation was independently reviewed and verified at
`1be794744b1434412f9bfd07756ab0b7be8ccaea`, job
`01M509GZDRYFDBN51QJNXVTMGT`: typecheck, 69 affected unit tests, normal build
and all 12 actual Electron cases passed (14.3 seconds, no retries). Artifact
manifest SHA256:
`9c90702702bebd5d1d38da4ca53e27ff081a77d1a46e37f7c874899840e2c3ef`.

This delivery composes only the reviewed navigation delta onto prerequisite A
`b53aa3a0ff85a3820044b7a9ffa9b8525f8577b4`. Seventeen original delta blobs are
byte-identical to the focused implementation. Base retains A's complete reload
revision/drain/lifecycle/persist ordering; Canvas retains A's exact owned recovery
alert cleanup. The existing renderer's four literal NUL bytes remain unchanged.
No prototype manager, fixture, layout scaffold or persistent layer wiring is
imported. The additional reload-order unit fixture supplies the real constructor's
table navigation cleanup collaborator and checks it is called once on close;
all existing stale-read assertions remain.

## Resulting behavior

A genuine content navigation gesture stages a synchronous readiness check before
browser focus changes. The real click dispatches one intent with current owner,
descendant lifetime, control and target checks. The source pane's existing queue
revalidates before effects. Refusal retains the connected native input and draft,
provider bytes, source view and history. Successful routes retain source-pane,
existing destination, new-tab, missing-note and awaited heading behavior.

Ordinary Base filename selection keeps deliberate focus/save behavior; the
separate double-click/Enter navigation is guarded. Existing explicit recovery-copy
buttons keep their recovery route. Authorized effects already committed before a
later failure are preserved, with a failed outcome rather than a zero-effect
refusal or rollback.

## Verification boundaries

The composed package requires its own typecheck, affected tests, exact 12-case
runtime guard, complete unit suite and complete Electron suite. Focused historical
proof does not replace that delivery gate. Current evidence and synthetic captures
are archived in `Products/Geode/Runs/geode-2026-10-15-native-source-navigation-qa.md`
in the configured Obsidian reporting archive.

Persistent Live Preview integration and background application no-save behavior
remain separate acceptance work. Original edit-induced clipping and the five-row
Canvas toolbar overlap remain open; the focused two-row selection fixture is not
layout approval. Toolbar follow-up Task `bcf8cdcc-7ffe-47c5-974b-5e60b0fc877c`
requires actual trusted accessibility evidence before a source correction. No
persistent Live Preview layer/Lightbox wiring or complete parity is claimed here.
