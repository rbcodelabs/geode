# Outgoing links

Use the **Outgoing links** tab in the right sidebar, or run **Show outgoing links**
from the command palette. The pane follows the active Markdown note.

**Links** shows authored wikilinks and embeds in first-appearance order, including
heading/block references and missing targets. Counts combine repeated authored
targets. Activate a target to navigate; Cmd/Ctrl-click opens a new tab. Names have
full-path hover/accessibility labels to disambiguate duplicate filenames.

**Unlinked mentions** finds other Markdown notes named in the current note by
basename or frontmatter alias. Click **Link** to convert one occurrence. Alias
spelling and all surrounding text are preserved. The change uses the current
editor buffer and normal undo/autosave. Stale suggestions refresh without editing.
Read-only/Reading views show suggestions with conversion disabled. A mention
inside a code block can be converted, but links inside code do not enter Links.

Under **Settings → Files and links → Excluded files**, list vault-relative files,
folders or `/pattern/` (optionally `/pattern/i`) to hide potential targets. Literal
folder paths match descendants at folder boundaries. Patterns allow character
classes, anchors, and at most one `*` or `+` repetition; groups, alternation,
braces, optional repetition, backreferences and patterns longer than 128 characters
are rejected. Invalid settings preserve the last valid list. Exclusions are saved
per vault on this device and currently affect potential outgoing targets only.
They do not alter indexing, search, existing links or sync scope.

## Current coverage boundaries

Links uses the shared metadata parser. On this baseline that parser indexes
wikilinks/embeds, and does not index Markdown-style `[text](note.md)` links. The
pane masks existing Markdown links when generating suggestions, so it does not
nest new links inside them. The shared parser's fence/large-note coverage limits
also apply. Shared parser improvements are a separately tracked package; this pane
alone does not establish complete Outgoing links or linking parity.

## Preview

The screenshots below use a synthetic temporary vault with aliases and duplicate
basenames. Captured 2026-10-14 on macOS in local Electron from source commit
`a51a006` (branch `feat/overnight-outgoing-links`), at 1950×1314 and 960×760
pixels. They show the real Electron pane after converting an alias from an
unsaved editor buffer; no user vault data is included.

![Outgoing links, desktop preview](../screenshots/outgoing-links-desktop.png)

![Outgoing links, compact sidebar preview](../screenshots/outgoing-links-compact.png)
