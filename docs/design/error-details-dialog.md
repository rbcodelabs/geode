# Error details dialog pattern

Keep persistent errors compact in the workspace. Show the explanation and
technical diagnostics in an on-demand dialog, using vault refresh as the first
consumer. This is an internal renderer pattern, not a new plugin API.

## Two levels of information

- **Banner:** what failed, any immediate safety warning, and Retry / Details…
  actions. Do not place a stack trace, technical table, or long recovery guide in
  the workspace. Do not open the dialog automatically.
- **Dialog:** known cause, specific recovery guidance, accurate preservation
  status, technical details, Copy diagnostics, and Close. Bound its size and
  scroll its body so controls remain reachable in a small window.

Saving-paused warnings must remain visible even when the dialog is closed.
Never imply that retaining a file list means unsaved edits reached disk.

## Responsibility boundaries

The shared dialog owns presentation, dismissal, keyboard focus, and copy feedback.
The feature owns classification, wording, retry behavior, and lifecycle. It must
close obsolete details when the operation recovers, its failure changes, or the
underlying context changes. Avoid stacking multiple dialogs for the same failure.

Supply structured, sanitized diagnostic rows and an explicitly safe report.
The dialog must not stringify arbitrary exceptions or decide whether retrying,
deleting data, changing permissions, or reconnecting a provider is safe.

Render supplied text as text, not HTML. For vault refresh, copied reports omit
file paths, note contents, raw exception messages, and stack traces. Clipboard
failure stays in the dialog with a useful explanation, not another popup.

## Accessibility and reuse

Give the dialog an accessible title and description. Keep keyboard focus inside
while open, support Escape and explicit Close, make overflowing content keyboard
scrollable, and restore focus to the opener when it still exists.

Use application theme tokens rather than hard-coded colors. Verify both normal
and narrow windows, long diagnostic values, copy rejection, and disappearance of
the original context. Other error flows can adopt this pattern individually;
vault-refresh adoption does not change their existing behavior.
