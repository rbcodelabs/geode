# Markdown comments v1

Select ordinary text and run **Comments: Add comment to selection** (or use the selection button/context menu). Geode writes a paired `geode-comment:v1` marker around the selection and opens the Comments pane in the right sidebar/Details drawer.

Threads support replies, message edits/deletion, resolve/reopen, thread deletion, human/agent attribution, and reattachment after the anchored prose is removed. The `require("geode")` module exports `CommentService`, `CommentAuthor`, `CommentMessage`, and `CommentThread`; `app.comments` is the live service.

Reading view and Live Preview hide marker metadata. Raw Source mode intentionally shows it. Corrupt markers are never rewritten silently and disable mutations until repaired in Source mode.

## Add and manage a thread

1. Select ordinary prose in an open Markdown note.
2. Run **Comments: Add comment to selection**, or use the selection button or context menu.
3. Enter the comment. The Comments pane opens alongside the note.

Click a highlighted anchor to focus its thread, or click the thread's passage preview to return to the text. Use **Reply**, **Edit**, or **Delete** on messages. **Resolve** hides a thread from the default list; enable **Include resolved** to find it and choose **Reopen**. **Delete thread** removes the thread after confirmation.

## Anchors and recovery

Selections must not overlap another comment or protected Markdown syntax such as code, links, math, HTML, or Obsidian comments. If a selection is rejected, choose a smaller range of ordinary prose.

Deleting only the anchored prose leaves a detached thread. Select replacement prose and choose **Reattach to selection**. Deleting both markers removes the thread itself. After directly editing or deleting anchor text, reopening the note refreshes a stale passage preview or detached-thread state in the pane.

Comments are stored inside the note, not in a separate service. They travel with the Markdown file through rename, backup, and sync. Source mode exposes the marker payload; it is encoded, not encrypted. Do not treat hidden comment metadata as private from someone who can read the file.

If the pane reports malformed markers, preserve a backup and inspect Source mode before repairing the marker bytes. Comment mutations remain blocked while the document is malformed.

See [ADR-0017](../adr/0017-inline-markdown-comment-markers.md) for the storage design and the remaining closed-file concurrent-write limitation.
