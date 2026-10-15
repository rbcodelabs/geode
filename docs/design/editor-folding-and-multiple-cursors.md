# Editor folding and multiple cursors

Scope: HELP-7ada99e267bd and HELP-6fe9c0ba52bd. Authorized by the overnight parity instruction (2026-10-14), Compass plan 8754c2d2-26fa-4695-b2d5-5ef973ae8489 revision 73e29b29-1fe8-495f-95b0-3d4d8f702e17. Stop at a tested PR.

Compass delivery Task: f5337037-795c-4e4c-93de-2fa837226b97 → Solution 7e7d8e2a-e5e3-4a78-ba2c-1bb9a6ff708e → KR c3b390f0-92a8-479c-b629-2b6745d577d5.

## Behavior

In Source mode and Live Preview, heading and list sections fold using gutter chevrons. Heading folding and indent folding default on and have independent Editor settings. Existing explicit saved values remain respected. Fold all / Unfold all headings and lists operate on the document; Fold more selects the nearest unfolded enclosing section; Fold less unfolds the nearest folded enclosing section. Nested fold state survives parent unfolding. Folding does not change Markdown files. Open-note folds survive workspace restoration when the document still matches, and invalid or stale persisted ranges are ignored.

Alt/Option-click adds cursors; unmodified clicking and Escape clear additional selections. Shift+Alt/Option drag and middle-button drag create rectangular selections. Typing and deletion apply to all ranges, with normal undo behavior.

## Approach and alternatives

Use the installed CodeMirror parser, fold effects/state, and selection extensions. A small custom gutter and commands share a syntax-aware range helper so the two folding settings govern all actions consistently. CodeMirror's stock Markdown fold service does not consult app settings. Merely enabling its default gutter would leave the independent settings ineffective; implementing a second text parser would duplicate grammar and misidentify fenced code.

Persist folded positions in existing workspace leaf state, validating the current document before restoration. This adds no files to the note and no new dependency. Keep the strict portable editor.json sync wire format unchanged; indent folding remains a local setting until a separately reviewed compatible migration.

## Verification

Unit tests first cover nested and setext headings, nested/ordered/task lists, blank and single-line sections, syntax that resembles headings inside fences, independent settings, nearest enclosing fold commands, state mapping, and stale persistence. Electron coverage exercises real gutter input, command palette, settings/restart, multi-cursor typing/undo/Escape, and both rectangular drag gestures. Run typecheck, all units, build, targeted Electron checks, then the full repository gate under the coordinated E2E slot. Capture the implemented UI and inspect it before review.

Sources checked 2026-10-14: https://obsidian.md/help/folding and https://obsidian.md/help/multiple-cursors. Installed CodeMirror declarations and source are the API reference.
