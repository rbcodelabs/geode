# ADR-0032: Apply named workspaces through guarded runtime replacement

**Date:** 2026-10-14
**Status:** Accepted within the authorized overnight parity scope

## Context

The pinned Obsidian Workspaces help documents save, same-name update, load and
delete for named layouts, available through a ribbon manager and command palette.
Layouts contain open files/tabs and sidebar dimensions and visibility. Geode's
existing persisted layout versions 1–3 are suitable snapshots, but `deserialize`
assumes startup: runtime use can orphan views and autosaves and fails to expand a
previously collapsed sidebar. Preserve unsaved Markdown and Canvas contents, avoid
dependencies and new public APIs, and stop at a tested PR.

## Decision

Add an optional Workspaces core plugin, initially disabled for existing installs,
and an App-owned internal runtime load coordinator. Reuse validated persisted
layouts and existing view factories, but do not invoke startup deserialization
directly against a live workspace or replace the Workspace instance.

Use per-vault `host.config.read/write("workspaces")` for a versioned array of
stable IDs, trimmed bounded names and layout snapshots. Same-name save updates an
existing record. Plugin loadData currently swallows storage errors and depends on
window.geode, so it is unsuitable here. Show corrupt/read/write failures; never
overwrite unreadable records with an empty collection. Serialize mutations, write
before publishing memory state, and check vault/session identity for queued work.
Cross-window revision-checked writes remain a documented limitation. Do not add
layouts to portable sync configuration.

The runtime transaction must:

1. Clone, validate and normalize before mutation. Bound bytes, tree depth and leaf
   count; validate finite dimensions, tab indexes, view types and vault-relative
   paths. Plugin state is bounded opaque JSON. Missing files are reported, never
   created by loading a layout.
2. Acquire an exclusive operation coordinated with vault switching, capture the
   session and leaves, cancel pending layout saves, suppress App and Workspace
   restore saves, and block interaction. Reject a concurrent load as busy.
3. Preflight all built-in writers before flushing. Recovery/conflict state,
   failed Canvas saves and differing dirty buffers for one path abort the load.
   Sequential flushing must not choose a winner between conflicting buffers.
4. Pause writers, await in-flight work, flush through existing Markdown vault
   switch hooks and Canvas persist queues, and prove no unacknowledged changes
   remain. Failure here retains the original layout/buffers and resumes writers.
5. Plan leaf placement, reusing matching file leaves one-for-one by type/path and
   preserving duplicate tabs as distinct leaves. Retain undo on reused views.
   Preserve singleton built-in panes and unavailable plugin state. Old snapshots
   must not destroy singleton resources created only at App startup.
6. Apply structure with explicit ownership: every old leaf is reused or retired,
   every retired view closes once, obsolete split listeners dispose, and both
   collapse=true and expand=false restore explicitly after dimensions.
7. Hydrate new views through existing factories. Missing or throwing plugin views
   become recoverable deferred/error placeholders and an explicit partial-load
   status. Arbitrary plugin lifecycle side effects cannot be atomically undone.
8. Resume only live retained/new writers, clear both guards and busy state in
   finally, and schedule one final ordinary layout save after success. A failure
   after structural commit leaves a coherent recoverable layout and visible
   error, with note bytes settled before teardown.

Use the existing Modal and focus conventions: labeled Name, Save, saved rows with
Load/Delete layout actions, and live error/status. Preserve input/records on
failed writes; disable concurrent manager operations during load. Register a
Manage workspace layouts command and matching ribbon action. Unload closes the
manager and removes registrations, preserving records and current layout. Delete
removes only the selected saved record, never notes or current tabs; autonomous
tests use synthetic records only.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Guarded placement with leaf reuse (selected) | Keeps live buffers/undo and explicit ownership; uses established schema | Internal transaction and cleanup tests required |
| Flush/close all, then startup deserialize | Smaller patch | Loses undo, destroys singleton resources, inherits unsafe restore assumptions |
| Swap a new Workspace instance | Conceptual isolation | Existing App/plugin subscriptions bind to the original instance; much larger refactor |

## Consequences

Named layouts restore arrangement rather than historical file contents. Loading
temporarily blocks interaction. Core singleton panes survive older snapshots.
Plugin lifecycle failures have explicit partial restoration rather than an
unreliable promise of atomic rollback.

## Risks

The riskiest assumption is that every built-in writer can prove quiescence.
Refuse the load if Canvas gestures, recovery or duplicate buffers cannot meet
that invariant. Do not blindly retry a partially throwing plugin teardown.
Revisit if a general document-session layer becomes necessary, cross-window
configuration conflicts need guarantees, or plugin failure cannot retain a
coherent layout.

## Verification required

- Save/update/load/delete and restart persistence; corrupt data and failed writes.
- Two distinct split/tab/sidebar layouts, dimensions, active tabs and expansion.
- Dirty Markdown/Canvas preserved; conflicting buffers/recovery/flush errors abort
  with original views intact.
- Close-once/disposal and no retired autosave after replacement; retained views stay.
- Missing files and unavailable/throwing plugins yield coherent explicit results.
- Concurrent load/vault switch cannot cross sessions; guards clear on every failure.
- Real Electron ribbon/palette, keyboard, unsaved edits and restart coverage.

Architect evidence: baseline b939adf and pinned local Obsidian help. This ADR
records a reversible engineering decision, not a claim of implemented parity.

## Addendum: quiescence includes rendered descendants

**Status:** Accepted prerequisite for runtime layout loading

Leaf enumeration misses writable Base/Canvas descendants. Live Preview directly
constructs Canvas views; asynchronous renderer mounts can escape disposal; Base
row-note writes and active cell drafts sit outside its definition persist queue.
The original leaf-only inventory is insufficient.

| Option | Benefit | Tradeoff |
|---|---|---|
| Internal render ownership scopes and awaited barrier (selected) | Covers nested writers, pending mounts and teardown | Lifecycle integration across renderer, Live Preview, Canvas and Base |
| Refuse every unproven descendant state | Smallest safe fallback | Named layout loading remains explicitly partial |
| Scan DOM/leaf views immediately before replacement | Small patch | Misses detached/pending mounts and separate writes; rejected |

Introduce internal, owner-bound render scopes, separate from the public plugin
API. Each scope tracks admission/generation, pending operations registered before
their first await, child scopes/native writer views, and one memoized async close.
Register children before initialization; every continuation checks generation
before publishing DOM or admitting descendants. Canceled mounts close allocated
children once through the same ownership path, including incomplete initialization.

Cover MarkdownRenderer render/transclusions/Base/Canvas, Live Preview note embeds
and direct Canvas, and Markdown inside Canvas nodes. Detached initialization is
legitimate; DOM connectivity and post-mount scanning do not prove ownership.

Before structure changes, freeze admission and interaction, invalidate pending
render generations, and settle tracked operations without losing allocated
children. Deduplicate writers and preflight drafts, recovery and overlapping file
dependencies before flushing competing buffers. Base settlement includes both
definition persistence and row-note writes; active drafts must commit through an
existing validated path or refuse loading before teardown. Never clear drafts
during disposal or guess between conflicting inline Base/Markdown/row writers.

Retire scopes through awaited idempotent closure, propagate write failures and
retain tracking until closure finishes. Synchronous dispose/widget callbacks may
initiate this tracked close but cannot independently double-close children.
Markdown/Canvas owning onClose paths await descendant drain. Abort resumes only
retained scopes/writers; retired generations stay closed. Any native writer that
cannot participate causes an explicit unsupported-state refusal with the current
layout intact. Timeout is not permission to destroy unknown state.

Risks remain arbitrary third-party lifecycle effects and incomplete registration
of native creation paths. Revisit if this needs a general document-session layer.
Saving/managing layouts can proceed independently; runtime parity cannot be
claimed from leaf-only tests.

Required tests: delayed embedded initialization racing replacement; pending Base
definition and row writes; rejected writes preserving layout/draft/retry state;
Markdown→Canvas→Markdown→Base and direct Live Preview Canvas; widget destruction
plus owner drain closing once; active drafts/conflicting buffers/recovery refusing
before teardown; abort resuming retained controls only; real Electron nested edits
surviving load with no obsolete subsequent writes.

## Addendum: Canvas redraw must preserve connected embedded editors

**Date:** 2026-10-15
**Status:** Proposed for root acceptance before redesign

### Evidence and problem

At native checkpoint 8aba291, Canvas `render()` starts asynchronous Markdown
disposal, clears its tracking collection, and immediately replaces the viewport
DOM. It runs during each node-drag frame as well as ordinary edits. An embedded
Base's close preflight can refuse an active cell draft, but that refusal occurs
after its controls have disappeared. Retaining a failed scope in memory does not
preserve a usable editor or Retry button. Blur might instead commit an edit during
removal, which is not a valid substitute for checking readiness.

Related paths also need the boundary: editing a Canvas text node replaces its
Markdown container with a textarea; deleteSelection mutates the document before
rendering; load and history restoration replace the document before redraw.
Fixing only final view close or adding an await after those mutations is too late.
Constructor-double renderer tests do not establish this real interaction.

### Options considered

| Option | Benefit | Tradeoff |
|---|---|---|
| Retain unchanged node presentations; prepare destructive changes before commit (recommended) | Keeps focused nested editors, drafts and gesture responsiveness | Keyed reconciliation plus a bounded destructive-change transaction |
| Await teardown before every complete redraw | Straightforward ownership sequence | Turns synchronous drag rendering into repeated asynchronous save/teardown; risks gesture, ordering and performance regressions |
| Refuse redraw and expose recovery | Safe only if checked before model mutation | A check inside render after callers mutate the document leaves model/UI/history inconsistent; not sufficient alone |

### Recommended contract

Keep the existing connected node wrapper, Markdown render root and owned scope
when the same node object/ID and presentation inputs remain valid. Update geometry,
selection, layering and edges without destroying or detaching that subtree. Do not
move focused editor DOM through a detached fragment: focus/blur and native state
must remain intact. Rebuild edge geometry separately from owned Markdown content.
This preserves current synchronous pointer/touch preview behavior and avoids
creating native render scopes on every drag frame.

A presentation identity includes Canvas owner/file context, node kind, source
text or target file/subpath, and any input affecting the embedded document. Do not
reuse event handlers that capture an obsolete node object after document reload or
undo replaces objects; treat that as a destructive replacement unless handlers are
explicitly rebound to the current node. Keep pending mounts registered under the
presentation from allocation, including detached initial mount.

Changing/removing a presentation, entering Canvas text-source editing, changing
file/target, document reload/recovery, history replacement and owner retirement
use an internal staged transaction. Before changing authoritative document state,
undo/redo stacks, selection, persisted bytes or connected DOM:

1. Capture owner/generation, the intended change and affected presentation scopes.
   Preflight all affected descendants before any blur/inert change can commit or
   discard a draft. An active embedded draft/recovery refuses the action with its
   original controls connected and a visible Finish/Cancel/Retry explanation.
2. Stop new affected operations and settle pending mounts/writes. Prepare every
   affected subtree before running any destructor across the set. Reuse the
   accepted internal preparation contract; do not close one sibling and discover
   another sibling's draft afterwards. Ordinary selection/geometry changes do not
   need this transaction when they preserve the presentation.
3. On pre-destructor failure, retain the entire original document/UI/undo state,
   restore allowed admission and publish reachable recovery controls. Existing
   authorized writes may have completed; keep their acknowledgements and never
   revert a file by writing a stale preimage. Do not clear an error merely because
   a scope or DOM element was removed from an inventory.
4. Once preparation succeeds, close retired presentations exactly once, then
   commit the staged document/render/history operation through its existing save
   path. A partial destructor failure remains explicitly fail-closed with visible
   recovery; do not falsely restore admission or claim an atomic rollback of
   destroyed descendants. Retained presentations remain connected.

Serialize destructive transactions per Canvas owner and reject or coalesce stale
requests without executing their captured callbacks later. Capture file identity
and generations across awaits. For drag operations that can remove/change source,
preflight before the gesture mutates the model; ordinary move/resize stays an
in-place preview with its original one-save/undo boundary. Preserve conversion's
created-note recovery path rather than repeating or deleting a successful create.

`MarkdownRenderer.dispose()` can remain a synchronous compatibility entry point
that starts tracked teardown. Native Canvas code must use an internal awaitable
owned-presentation boundary before detaching DOM. Do not infer success from the
void compatibility method, remove a failed scope from tracking, or duplicate
independent onClose calls. No new plugin-facing API is required.

### Acceptance and limits

- Real Electron: Canvas text node and file-note node each contain a Base. Type an
  uncommitted cell draft, then trigger a geometry-only redraw. The same embedded
  editor remains connected with the exact draft; redraw itself causes no blur or
  source write. Exercise node move/resize too, preserving ordinary user-initiated
  focus/blur semantics rather than requiring focus to stay in two controls.
- Delete/edit/replace the affected node, reload the Canvas or invoke undo while
  that draft/recovery is active. The action refuses before model/selection/undo/
  disk mutation; the draft's real Finish/Cancel/Retry control remains reachable.
- Delay and reject Base definition/row writes during a destructive operation.
  Old DOM remains until preparation succeeds; failure retains usable controls;
  explicit retry succeeds without duplicate writes or clearing unrelated errors.
- Race a late note/Base/Canvas mount against deletion, text editing and close.
  No late publication, detached retained owner, double close or leaked scope.
- Verify the whole Markdown→Canvas→Markdown→Base chain, repeated redraw counts,
  pointer/touch/group/edge behavior, text edit cancel, conversions, history and
  exact serialized bytes/undo boundaries with existing Canvas regression suites.

The riskiest assumption is complete classification of presentation-changing
paths among Canvas's many synchronous mutations. Review an explicit call-site
inventory before claiming this boundary complete. If one path cannot stage safely,
refuse that operation before mutation and document the partial support. This is a
native lifecycle prerequisite, not completed named-workspace parity.
