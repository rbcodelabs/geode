# Editor API core adapter: engineering brief

Design: [ADR0036](../adr/0036-public-editor-core-facade.md), accepted by the
overnight coordinator under the user's reversible-design authority. No
implementation is included. Delivery Task: `6f88c11d-f694-4a63-8d1c-c38d5baac74d`.
Audit target: editor `b63cae9`; pinned API `9abd9605`. Use a new branch after an integrated frozen baseline;
do not reuse the folding/multiple-cursor Task or modify another engineer's files.

## Scope and seams

Create a small Editor core facade/CM adapter module and public types. Keep native
CM storage separate in MarkdownView. Migrate native consumers in MarkdownView,
App, Workspace and audio-recorder; audit every editor occurrence instead of a
global rename (live-preview also has unrelated textareas). Wire public view.editor,
activeEditor.editor, command/check callbacks and editor-menu consistently. Update
callback types and plugin fixtures to use public methods; preserve a separate
explicit test of state/dispatch/cm compatibility bridges. A base export supports
runtime Editor identity; missing deferred methods must not be silent no-ops.

Existing seams at b63cae9: MarkdownView editor76/build381/menu367–371;
App command context2798–2803; commands15–19; Workspace activeEditor3561–3565;
audio-recorder96–98. These offsets will move on the integrated native baseline.
Read the current ownership guard, not only these historical locations. The adapter
must use synchronous current-owner checks and the host's editability policy before
CM dispatch; it must not call Vault.modify or start its own debounce.

## Regression matrix before implementation

| Surface | Required scenario and assertion |
| --- | --- |
| Basic text/positions | Empty and multiline buffers; first/last line; EOF insertion; absent to; negative/oversized integer positions; reject nonfinite/fractional input without any state mutation |
| Unicode/newlines | Emoji/surrogate pairs and combining marks use UTF-16 offsets; LF positions round-trip; a CRLF note's saved bytes preserve existing line endings after an adapter edit |
| Selections | Reversed main selection, secondary nonempty selection with empty main, multiple carets, omitted heads, requested main index, overlap/duplicate normalization, invalid empty array; returned objects cannot mutate editor state |
| Mutation/history | Same replacement at all selections; explicit range only; setLine preserves surrounding line breaks; whole-buffer setValue retains existing history; each public edit undoes once, redo restores exactly, and no intermediate buffer/autosave state is published |
| Ownership | Two splits of same path, inactive valid split, file replacement at same path, rebuild, rename, close, live/source mode toggle; stale old facade always refuses and never edits another buffer |
| Guards | Current conflict/recovery, vault-switch/native hold, Reading mode and closed owner reject content writes/undo/redo before any dispatch; selection/focus/read behavior follows the documented package policy |
| Acquisition | Actual installed synthetic plugin receives the identical facade through view.editor, activeEditor.editor, callback/check callback and editor-menu; public getCursor/getValue/replaceSelection work without raw CM APIs |
| Native preservation | Native CM boolean hasFocus remains boolean and internal dispatch/geometry/folding/formatting/sync guards still use the original CM instance; explicit legacy state/dispatch and cm escape remain correctly bound |
| Persistence | Unsaved typed text is the input to plugin mutation, not disk; one normal autosave persists exact final bytes, failed persistence retains existing recovery, no file other than the owner changes |

Unit tests should exercise the actual adapter against CM EditorState/history with
small dispatch harnesses, not duplicate its conversion algorithm as an oracle.
Use actual EditorView/real Electron for focus, public plugin wiring, split/mode
lifetimes and persistence. Add meaningful RED cases before source changes and run
existing editor/commands/menu/native/sync suites after integration, then full gates
and independent review. No visual prototype or new screenshot requirement arises
from this nonvisual API package; any incidental UI changes retain normal UI gates.

## Evidence and limits

The existing plugin-editor-commands test edits through raw CM dispatch/state;
its success is routing evidence only. The folding multi-selection unit likewise
tests CM, not Editor. This package adds new public contract evidence and does not
rewrite those historical results as though they tested the adapter.

Keep transaction/processLines and command/viewport/wordAt packages separate and
partial. Correct docs/spec/03-plugin-api.md's transaction.selections to from/to
ranges and the stale HELP-37b44b79930f shortcut note; neither correction supports
status promotion. After real tests, attach evidence to exact covered ledger rows
only. Tests of ADR policy assumptions are not comparative Obsidian verification.
