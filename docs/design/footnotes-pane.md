# Active-note Footnotes pane

Accepted reversible implementation choice under the 2026-10-14 overnight parity
authorization. Delivery Task `43bc4c29-0f3f-4de1-b279-90ac9c4d76ff`, Solution
`e0b922c6-e23d-49ae-9bfe-a53df1c76a96`, KR
`c3b390f0-92a8-479c-b629-2b6745d577d5`. Parent plan Doc
`8754c2d2-26fa-4695-b2d5-5ef973ae8489`, revision
`73e29b29-1fe8-495f-95b0-3d4d8f702e17`. Built on reviewed metadata source
`153642f`; no changes to the shared parser. Related sidebar/buffer decision:
ADR-0031. Stop boundary: tested PR; merge/release excluded.

The public pinned help page (`en/Plugins/Footnotes view.md`, obsidian-help
`08ef563`) requires an active-note list, click-to-edit, and position navigation.
Reuse the existing portable scanner and native sidebar styling. The chosen edit
interaction reveals Source mode and selects the actual footnote text in the
note's retained editor. The user types into that editor; normal undo/autosave
owns the change. The pane does not serialize another Markdown copy or write to
disk. A separate Jump control moves the caret to the definition/inline/reference
position without replacing content.

The alternative of independently editing a sidebar textarea was rejected because
it introduces a second document mutation path and stale-buffer risk. A new
footnote parser was rejected because renderer and metadata already share one.

The optional core plugin is disabled by default, following the Slides core
pattern. Its factory and command register before layout restoration. Show
footnotes opens/reuses a sidebar leaf. Disable stops late pane opens, detaches
its leaves, then unregisters its factory/command. Lifecycle changes are queued
so rapid disable/re-enable cannot resurrect an old pane. Existing community
plugin deferral behavior is unchanged.

The projector lists definitions, inline notes and undefined-reference states;
repeated references share one definition row. Text is rendered through
`textContent`. Source identity, current buffer text, file existence, host vault
and read-only state are checked before selection/edit navigation. Hidden panes
cancel pending work and defer scans; close disposes subscriptions. Errors retain
the current subject's last-good content and offer retry by reopening.

The shared scanner still checks definition membership per reference, so this
package bounds each synchronous scan to 8,192 source characters and each view to
200 rows. Both limits are explicitly announced. A definition cut by the source
boundary is not offered for selection editing; navigation remains available.
An unterminated leading frontmatter block is excluded rather than exposing YAML
as editable footnotes. This scope remains partial for long/dense notes; an
incremental parser/index would be a separate architecture decision.

Acceptance evidence must cover exact LF/CRLF offsets, frontmatter/code exclusion,
inline and multiline definitions, repeated/missing references, stale selection,
read-only/no-note/error states, hide/close cancellation, keyboard navigation,
real Source edits/undo/autosave, and enable/disable/restart persistence. Screenshots
must show synthetic data only. The static sidebar reference accepted for the
overnight work governs compact controls and focus treatment; real Electron
verification remains required before publication.
