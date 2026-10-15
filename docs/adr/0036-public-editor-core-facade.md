# ADR-0036: Public Editor core facade with a separate native CodeMirror seam

**Date:** 2026-10-15
**Status:** Accepted for implementation within the authorized tested-PR boundary

Accepted by the overnight coordinator on 2026-10-15 under the user's explicit
authority to make reversible design decisions. Delivery Task:
`6f88c11d-f694-4a63-8d1c-c38d5baac74d`. This acceptance does not authorize
merging, releasing, or claiming comparative API parity. The integrated native
baseline and shared-file coordination requirements below still apply.

The accepted [Phase0 sequencing addendum](../design/editor-core-preparation-addendum.md)
permits an isolated, unwired preparation module before that integration baseline.
It does not permit product acquisition, callback wiring or public runtime exports.
Legacy dispatch preserves explicit native transaction-spec/history behavior; the
isolated undo-unit guarantee below applies to core mutation methods, not arbitrary
legacy dispatch specifications.

## Context

The pinned public API (`obsidianmd/obsidian-api` commit
`9abd9605ce081383674aae1ed111c456edde0688`, `obsidian.d.ts:3652–3912`,
`4042–4072`, `4208–4235`) describes an Editor using zero-based line/ch positions.
At Geode editor checkpoint `b63cae978d72ed3d50796d61be94ac2283e6abd0`,
MarkdownView.editor, workspace.activeEditor.editor, editor command callbacks and
editor-menu all expose a raw CM6 EditorView. There is no public Editor adapter.
The command tests establish routing, not the documented editor methods: the
plugin fixture edits through dispatch/state.doc. A plugin calling getCursor or
replaceSelection fails. CM's hasFocus is a boolean getter; Editor.hasFocus is a
method. Mutating the raw CM object would break CM consumers.

The current unsaved buffer, normal history/autosave, conflict recovery and native
ownership must survive this correction. Canvas/Workspaces and PDF integrations
own shared files now. This decision introduces no visual interface, dependency,
filesystem write path or plugin privilege boundary. It remains a partial API
implementation until behavior is verified.

## Options considered

| Option | Advantages | Costs and failure modes |
| --- | --- | --- |
| Separate facade and explicit internal CM seam | Clear public contract; no CM mutation; stable captured-document ownership; typechecking finds native consumers | Requires a coordinated migration of native editor references and plugin-facing boundaries |
| Proxy facade forwarding unknown members to CM | Fewer immediate native migrations; preserves many accidental old accesses | Method binding, reflection, identity and lifetime become surprising; forwards unsupported internals indefinitely; still cannot make hasFocus both a boolean and a function |
| Decorate the actual CM EditorView | Preserves raw object identity | hasFocus collision breaks native CM assumptions; method names and descriptors may collide as CM evolves; public writes cannot be guarded independently |

## Decision

Recommend a separate public Editor facade, with a concrete CM-backed adapter and
an explicit private native-editor seam on MarkdownView. Never change an
EditorView prototype or install Editor methods on a raw EditorView. Do not add a
general Proxy or unknown-property forwarding.

### Identity and integration

- Rename native storage to a deliberately internal seam such as `cmEditor`;
  this name is an implementation recommendation, not a new public API promise.
  Native MarkdownView, App, Workspace and audio-recorder consumers use it where
  they require CM state/dispatch/DOM/geometry. Do not replace unrelated table
  textarea properties named editor in live-preview.ts.
- Public `MarkdownView.editor` returns the facade. The command context provider,
  editorCallback/editorCheckCallback, workspace.activeEditor.editor and
  editor-menu all return that exact facade for that exact MarkdownView. Keep
  callback view identity and existing context gating; Reading mode still has
  no editor-command context. Do not broaden workspace.activeEditor to unrelated
  views or invent new activation rules during this package.
- One facade is bound to one CM instance and document identity. Ordinary edits
  and live/source compartment changes retain it. Rebuilding CM, switching file,
  accepting a replacement buffer or closing retires it before destroying CM.
  A new instance gets a new facade; an old reference never silently starts
  editing a different file. Check instance identity plus document epoch, not
  path alone. Renaming the same file without replacing its buffer need not
  retire it. Align the epoch with native ownership, without bumping it for each
  keystroke or for a harmless mode reconfiguration.
- All public operations check current ownership. Stale references throw a clear
  editor-unavailable error, including reads: do not serve a stale buffer snapshot.
  Checks do not depend on which pane happens to be active. Valid references to
  an inactive split still operate on their owning document.
- Expose a documented Geode compatibility escape `editor.cm` to the captured
  current raw CM instance; it is not pinned public Obsidian API evidence. Keep
  only explicit legacy `state` getter and bound `dispatch` forwarding for
  existing Geode callers, with current-owner/writable checks. Do not forward
  arbitrary properties or legacy boolean hasFocus. Internal code must use the
  native seam, not rely on these bridges. Document migration from raw
  editor.hasFocus to editor.hasFocus() or editor.cm.hasFocus. Raw CM access is
  trusted-plugin compatibility and can bypass adapter safeguards; it is not a
  security boundary or a complete old-CM compatibility promise.

### Package 1: core methods

Implement getDoc (returns this), getValue/setValue, getLine/setLine,
lineCount/lastLine, getRange/replaceRange, getSelection/replaceSelection,
somethingSelected, getCursor/setCursor, listSelections/setSelection/setSelections,
posToOffset/offsetToPos, focus/blur/hasFocus, undo/redo. Export the implemented
Editor base/runtime identity and position/range/selection types through the
compat module. Do not publish no-op implementations of deferred methods.

Use the live CM Text/selection model; never reread disk or reconstruct state
from metadata. Getters return fresh structural position objects, not mutable CM
objects. Preserve reversed anchor/head and main-selection identity. The line/ch
and offset conversion routines are shared by all methods, not reimplemented per
entry point. Existing Markdown serialization owns disk line endings.

Each content mutation dispatches one CM transaction, keeps native update listeners
and autosave, and changes no file directly. Isolate each public mutation as one
undo unit from adjacent typing; selection-only calls create no content undo unit.
setValue replaces the current buffer with an undoable edit rather than rebuilding
EditorState/history. Undo/redo use the existing CM history and the same write guard.
Optional origin strings annotate CM user events without affecting ownership or
creating additional transactions; absence does not fabricate a specific user event.

Read methods and selection/focus operations may use the retained buffer in
Reading mode. Content mutation, legacy dispatch and undo/redo require an editable
native owner: refuse conflict/recovery, vault switch, ownership hold, retirement
and Reading mode before dispatch. Do not rely only on contenteditable or CM's
readOnly facet, since programmatic dispatch can bypass them. Expose one private
host guard for this policy; a rejected call throws without modifying buffer,
selection, history, disk or save queues. This is a deliberate Geode safety policy,
not a claim that pinned Obsidian defines these rejection conditions.

### Explicit provisional semantics

The pinned declarations leave edge behavior unspecified. Adopt and document these
reversible assumptions, and label tests as Geode policy rather than an Obsidian
oracle until comparative evidence exists:

- Positions/offsets count UTF-16 code units, matching CM; do not reinterpret
  surrogate pairs as code points or graphemes. The buffer uses normalized LF;
  CRLF is restored by the existing save layer.
- Require finite integer position components, offsets and main indexes; reject
  malformed input. Clamp finite integer out-of-bounds line/ch/offset values to
  valid buffer positions. Empty text is one line; lastLine is zero.
- getSelection/getCursor use the main selection; from/to are sorted endpoints,
  anchor/head preserve direction. somethingSelected examines every selection.
- replaceSelection applies the same replacement to all current selections in
  one CM change set; replaceRange acts only on its explicit range. A reversed
  explicit get/replace range is normalized. Omitted to inserts at from.
- Reject an empty setSelections array or an invalid main index before dispatch.
  Omitted heads create carets. CM may normalize overlapping/duplicate ranges;
  do not promise an impossible ordering/main index after normalization. Verify
  the resulting main selection by identity/position through the CM mapping.
- Empty mutation/history operations may produce no content change. Exact native
  exception text, invalid-input behavior and history grouping are not parity
  claims solely because local tests agree with these choices.

### Deferred packages

Package 2 adds EditorTransaction and processLines: original-coordinate changes,
one atomic dispatch/undo, read-all-before-write-all and multi-line deduplication.
The pinned transaction `selections` field is EditorRangeOrCaret[] (from/to),
distinct from setSelections' EditorSelectionOrCaret[] (anchor/head). Ambiguous
combinations of replaceSelection/changes/selection/selections require a recorded
choice or comparative evidence, not inferred verification.

Package 3 adds exec's full documented command-name union, refresh, wordAt and
viewport methods. Reuse accepted folding behavior without restarting its UI work.
Do not claim that CM having a similarly named primitive establishes Editor parity.

## Consequences

Plugins gain a consistent public core interface and current-buffer edits through
all four acquisition paths. Native CM remains unchanged. The explicit compatibility
bridges reduce migration cost while exposing a limited, documented transitional
surface. Old boolean hasFocus callers must migrate; an object cannot satisfy both
shapes. Captured stale references fail visibly rather than editing a new note.

Migration touches shared files and tests. Implement only on a root-coordinated
frozen integrated native/Canvas/PDF baseline, with a dedicated Task and branch.
No concurrent MarkdownView/App/Workspace edits. PDF currently uses RenderScope
and no CM access; its future Markdown/LP wiring remains separately coordinated.

## Risks and acceptance

The riskiest assumption is that every public acquisition and every native CM
consumer is classified correctly. Inventory them before source edits and require
typecheck plus actual plugin integration. Existing native ownership holds must
continue to gate all facade writes. The `.cm` escape cannot provide such a guarantee
for arbitrary trusted plugins.

Acceptance and package boundaries are in
[the implementation brief](../design/editor-api-core-adapter.md). Keep the 49
audited Editor/selection/transaction ledger rows unknown until each has actual
evidence. Correct the transaction-selection shape and stale shortcut note as
documentation corrections, without promoting unrelated status. Revisit this
decision if real plugins require broader raw-CM forwarding, if official behavior
contradicts the assumptions, or if the native ownership lifecycle changes.
