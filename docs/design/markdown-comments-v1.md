# Markdown comments v1

Select ordinary text and run **Comments: Add comment to selection** (or use the selection button/context menu). Geode writes a paired `geode-comment:v1` marker around the selection and opens the Comments pane in the right sidebar/Details drawer.

Threads support replies, message edits/deletion, resolve/reopen, thread deletion, human/agent attribution, and reattachment after the anchored prose is removed. The `require("geode")` module exports `CommentService`, `CommentAuthor`, `CommentMessage`, and `CommentThread`; `app.comments` is the live service.

Reading view and Live Preview hide marker metadata. Raw Source mode intentionally shows it. Corrupt markers are never rewritten silently and disable mutations until repaired in Source mode.

## Add and manage a thread

1. Select prose in an open Markdown note — a paragraph, a heading, a list item, or a table cell.
2. Run **Comments: Add comment to selection** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>), or use the selection button or context menu.
3. Enter the comment. The Comments pane opens alongside the note.

Click a highlighted anchor to focus its thread, or click the thread's passage preview to return to the text. Use **Reply**, **Edit**, or **Delete** on messages. **Resolve** hides a thread from the default list; enable **Include resolved** to find it and choose **Reopen**. **Delete thread** removes the thread after confirmation.

## Anchors and recovery

Prose inside a heading, a list item (bullet, ordered, task, nested) or a table cell can be annotated as well as an ordinary paragraph. Only the structural syntax itself is off-limits: the `#` of a heading, a list bullet or `[ ]` checkbox, a table's `|` separators and its delimiter row.

A comment anchored inside a **table cell** carries no highlight in Live Preview. A table is replaced there by a rendered widget rather than decorated source, so — exactly as in Reading view, which strips markers outright — there is no source text left to highlight. The thread itself is unaffected: it persists in the note, appears in the Comments pane, and replies and resolves normally.

Selections must not overlap another comment or protected Markdown syntax such as code, links, math, HTML, blockquotes, or Obsidian comments. A selection that merely *straddles* structural syntax — a triple-click that takes in a heading's `#`, or a drag that starts on a bullet — is trimmed automatically to the prose it covers, and the comment anchors there. A selection with no commentable prose left in it is rejected with the specific reason, such as "Comments are not supported inside fenced code".

Deleting only the anchored prose leaves a detached thread. Select replacement prose and choose **Reattach to selection**. Deleting both markers removes the thread itself. After directly editing or deleting anchor text, reopening the note refreshes a stale passage preview or detached-thread state in the pane.

Comments are stored inside the note, not in a separate service. They travel with the Markdown file through rename, backup, and sync. Source mode exposes the marker payload; it is encoded, not encrypted. Do not treat hidden comment metadata as private from someone who can read the file.

If the pane reports malformed markers, preserve a backup and inspect Source mode before repairing the marker bytes. Comment mutations remain blocked while the document is malformed.

See [ADR-0017](../adr/0017-inline-markdown-comment-markers.md) for the storage design and the remaining closed-file concurrent-write limitation.
