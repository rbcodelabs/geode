# Markdown comments v1

Select ordinary text and run **Comments: Add comment to selection** (or use the selection button/context menu). Geode writes a paired `geode-comment:v1` marker around the selection and opens the Comments pane in the right sidebar/Details drawer.

Threads support replies, message edits/deletion, resolve/reopen, thread deletion, human/agent attribution, and reattachment after the anchored prose is removed. The `require("geode")` module exports `CommentService`, `CommentAuthor`, `CommentMessage`, and `CommentThread`; `app.comments` is the live service.

Reading view and Live Preview hide marker metadata. Raw Source mode intentionally shows it. Corrupt markers are never rewritten silently and disable mutations until repaired in Source mode.
