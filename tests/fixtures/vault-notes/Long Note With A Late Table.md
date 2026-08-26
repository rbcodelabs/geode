# Long Note With A Late Table

Live Preview builds its block decorations from the CodeMirror syntax tree. That tree is not produced all at once: on state creation only the first few thousand characters are parsed synchronously, and the remainder is filled in later by a background parse worker running inside idle callbacks.

This note exists purely as an end-to-end fixture. Everything before the pipe table below is filler prose whose only job is to push the table past the synchronous parse frontier, so that the table node simply does not exist in the syntax tree at the moment the editor first opens the file.

The filler deliberately avoids internal link syntax of any kind, and avoids the basenames used by the shared demo vault, so that copying it into a throwaway vault never perturbs backlink counts, graph node counts, or base row counts asserted by the other end-to-end specs.

Padding paragraph. A background parse worker extends the tree in slices, publishing each longer tree through a transaction that carries no document change at all. Any state field that recomputes only when the document changed will therefore discard every one of those transactions and keep serving a decoration set derived from a truncated tree.

Padding paragraph. The user-visible symptom is a table that renders as raw pipe text forever and never repairs itself, no matter how long the note is left open. Toggling into source mode and back appears to fix it, but only because that reconfigures the extension compartment and forces a fresh field creation against a by then complete tree.

Padding paragraph. The correct guard compares syntax tree identity between the transaction start state and end state, which is exactly what CodeMirror does internally for syntax highlighting. Tree objects are immutable snapshots that are reassigned rather than mutated, so reference equality is a precise and cheap test.

Padding paragraph. Because the same snapshot that the guard tests is the snapshot the decoration builder reads, the guard and its consumer can never disagree about which tree is current. That coupling is what makes the identity comparison sound rather than merely convenient.

Padding paragraph. Filler continues here to keep the byte count comfortably beyond the initial viewport parse budget, with a healthy margin so the fixture stays meaningful even if that budget is raised in a future dependency bump.

Padding paragraph. More prose of no particular significance follows, purely to occupy space in the document before the table begins. The exact wording is irrelevant; what matters is the character offset at which the pipe table starts.

Padding paragraph. Still more filler, because a fixture that only barely clears the threshold would be a fragile regression test. Extra margin costs nothing and protects the assertion below from incidental drift.

Padding paragraph. The table that follows this paragraph must render as a real editable table widget with no user interaction whatsoever: no clicking, no typing, no scrolling, and no mode toggling.

Padding paragraph. If it renders only after a keystroke, the fix is not working, because a keystroke changes the document and would mask the bug behind the very code path that was already correct.

Live Preview builds its block decorations from the CodeMirror syntax tree. That tree is not produced all at once: on state creation only the first few thousand characters are parsed synchronously, and the remainder is filled in later by a background parse worker running inside idle callbacks.

This note exists purely as an end-to-end fixture. Everything before the pipe table below is filler prose whose only job is to push the table past the synchronous parse frontier, so that the table node simply does not exist in the syntax tree at the moment the editor first opens the file.

The filler deliberately avoids internal link syntax of any kind, and avoids the basenames used by the shared demo vault, so that copying it into a throwaway vault never perturbs backlink counts, graph node counts, or base row counts asserted by the other end-to-end specs.

Padding paragraph. A background parse worker extends the tree in slices, publishing each longer tree through a transaction that carries no document change at all. Any state field that recomputes only when the document changed will therefore discard every one of those transactions and keep serving a decoration set derived from a truncated tree.

Padding paragraph. The user-visible symptom is a table that renders as raw pipe text forever and never repairs itself, no matter how long the note is left open. Toggling into source mode and back appears to fix it, but only because that reconfigures the extension compartment and forces a fresh field creation against a by then complete tree.

| Metric | Value |
| --- | --- |
| Parsed | yes |
| Rendered | yes |

Sentinel paragraph after the table.
