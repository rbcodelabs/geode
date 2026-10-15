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
