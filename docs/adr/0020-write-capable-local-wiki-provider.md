# ADR 0020 — Write-capable local wiki provider

Status: Accepted
Date: 2026-09-16
Supersedes: nothing. Extends [ADR 0019](0019-readonly-local-wiki-snapshot.md).

## Context

ADR 0019 gave the portable engine a read-only view of a real local folder:
`openLocalWikiSnapshot` walks a trusted directory and returns a frozen,
detached snapshot supporting metadata, literal search, link resolution and
backlinks. That design deliberately stopped short of writes, and
`docs/design/headless-local-readonly.md` named writes as a *stop and revise
scope* trigger rather than an incidental extension.

This ADR is that revision. Writes are new scope, approved as increment 2 of
build package `bap-geode-headless-core-provider-20260915`.

Nothing downstream of a write exists yet. There is no synchronization in either
direction, no remote storage, no catalog, no external document-store
integration, and no published SDK, CLI or MCP surface. This ADR adds the local
write capability those would require; it does not begin any of them.

## Decision

Add `openLocalWikiProvider` in `src/wiki/folder-provider.ts`: a local folder
provider with validated `create` / `update` / `delete`, alongside the existing
read surface.

**The view is rebuilt, not patched.** After every applied write the provider
calls `createWikiSnapshot` over its updated capture. Resolution, search and
backlinks therefore come from the same implementation the read-only path uses.
There is no write-side fork of those semantics to drift.

**The capture step is shared, not reimplemented.** `captureLocalWikiFolder` was
factored out of `openLocalWikiSnapshot` so the provider reuses its containment,
symlink-exclusion and TOCTOU discipline verbatim. `openLocalWikiSnapshot` is now
a thin wrapper over it and behaves exactly as before.

**Contracts stay narrow.** The provider depends on two injected interfaces in
`src/wiki/contracts.ts`: `WikiIndexSink` (`upsert`, `remove`) and
`WikiEventSink` (`emit`). Neither extends a host type. This is the direct
remediation the extraction dependency map calls for on
`src/renderer/host/contracts.ts` — *"narrow engine contracts must not inherit
the whole host interface"* — and it is what lets a plain `Map` and an array
satisfy them in tests. Both are optional; the provider works with neither.

**Writes are notes only.** `create`/`update`/`delete` accept `.md` paths.
Authoring attachments through this surface is out of scope, so a non-note path
is refused with `not-a-note` rather than silently written.

### Validation and refusal statuses

Every operation validates before touching the filesystem, and each distinct
refusal has its own status rather than a generic failure:

| Status | Meaning |
| --- | --- |
| `invalid-path` | Not a portable vault-relative path: absolute, drive-qualified, escaping, backslashed, NUL-bearing, or not already normalized |
| `not-a-note` | Writes are notes only |
| `already-exists` | `create` found an entry at that path |
| `absent` | `update`/`delete` found no note at that path |
| `portability-collision` | A different path folds onto the same NFC-lowercased identity |
| `path-changed` | Root identity, containment or symlink re-verification failed at write time |
| `note-byte-limit` | Would exceed the configured per-note or total byte limits |
| `entry-limit` | The folder already holds the configured maximum number of entries |
| `capture-incomplete` | Discovery was cut short by a limit, so absence cannot be distinguished from "never seen" |
| `write-failed` | The filesystem refused the operation |

Path rules reuse `normalizeWikiPath` rather than introducing a second
normalizer, **and additionally apply the capture walk's own exclusions** —
dot-prefixed segments and `node_modules`. Without that second half the claim
"a path the engine will not resolve is also a path it will not write" is false:
a write to `.secret/Note.md` would succeed, appear in the view until the next
refresh, and then be permanently unreachable because the walk never picks it up.

When discovery was incomplete (entry, depth or visited-entry limits), every
write is refused with `capture-incomplete` rather than answered from a view
known to be partial — otherwise `update` and `delete` report `absent` for notes
that demonstrably exist.

`portability-collision` refuses a write that would produce two notes a
case-insensitive or normalization-insensitive filesystem treats as one. This
keeps a vault that was authored on Linux openable on macOS and Windows.

### Containment and race discipline

- Parent components are re-verified immediately before each write: the root is
  still the same directory **by device and inode** (name equality is not
  identity — a root removed and recreated at the same path would otherwise pass
  every check), no component is a symlink, and the parent's canonical path
  still equals the path walked to.
- For `update` and `delete` the final component is checked too: a symlink or a
  directory planted where a note used to be is refused with `path-changed`. A
  target that is simply *gone* is not a containment failure — it is an ordinary
  race, reported as `absent`, and the view converges on it.
- `refresh()` refuses with `root-changed` when the root now canonicalises
  somewhere else. Adopting the new folder silently would leave the provider
  reading one vault and writing to another, because writes stay anchored to the
  root captured at open.
- `create` uses `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, making "does this
  already exist?" one atomic question and refusing to write through a symlink
  planted at the target.
- `update` writes a sibling temp file, `fsync`s it, then `rename`s it over the
  target. Truncating in place is the obvious implementation and it loses data:
  `O_TRUNC` empties the note *before* the write, so a failure partway through
  (ENOSPC, EIO) leaves a truncated note on disk while the caller still holds a
  view asserting the old content. `rename` within a directory is atomic, so a
  reader sees either the old note or the new one, never a partial one. Because
  `rename` would happily create the target, the target is checked first and must
  still be a regular, non-symlink file — which preserves the property that an
  update cannot resurrect a note deleted from under it (it reports `absent`).
- `delete` unlinks the entry without following it, and converges the in-memory
  view when the note is already gone rather than insisting it is still there.
- Events are emitted only after the write is applied and the view rebuilt, so a
  subscriber that immediately queries the provider observes the change it was
  told about. A throwing subscriber cannot roll back a write that already
  happened or leave the view stale.

## Boundary — what this is not

**Portable Node pathname APIs are not an OS sandbox against a hostile
process.** This is the same limit ADR 0019 recorded, and adding writes does not
change it.

What the validation above does defend: malformed and malicious *input*,
symlinks planted in the tree, ancestor directories swapped mid-operation,
exclusive-creation races, notes deleted under an in-flight update, and
portability collisions. All of these are covered by tests, exercised
deterministically through the injected filesystem seam.

What it does not defend: an adversary with equal privilege racing the
filesystem in a genuinely concurrent process. The tests are single-threaded by
construction. A hostile-tree sandbox was explicitly excluded from this scope.

**Per-note content identity is deliberately not pinned across capture.** A note
edited outside this process between capture and `update` is overwritten —
last-writer-wins. Callers that must observe such an edit have to `refresh()`
first. Doing better means threading per-file `Stats` through the capture API and
comparing them at write time; that is a design change rather than a hardening,
so it is recorded here as follow-up rather than half-implemented. The
`path-changed` status therefore covers *route* verification (root identity,
containment, symlinks), not note-content identity.

**Windows-reserved names are not rejected.** `portability-collision` covers
NFC-lowercase identity collisions only. Names like `CON.md`, a trailing dot or
space, or `<>:"|?*` are accepted here and would still be unusable on Windows.

## Consequences

- The Node path can now write, which is the prerequisite any future
  synchronization or external document store depends on. Neither is built, and
  neither is authorized by this ADR.
- `tests/unit/local-wiki-provider.test.ts` covers CRUD, refusals, portability
  collisions, symlink and containment defence, concurrent mutation, and the
  injected contracts.
- `scripts/local-wiki-write-proof.mts` (npm `proof:local-wiki-write`) proves
  the full create → read → update → delete loop in a fresh Node process with no
  `window`, no `document` and no Electron, against an audited input graph.
- Search query primitives moved to `src/wiki/search.ts` so the provider and the
  desktop search view share one implementation. `createWikiSnapshot`'s
  `search()` is deliberately **not** converged onto them: it answers a
  different question (a bounded ASCII-folded literal scan that also reports
  completeness and truncation) and merging the two contracts is follow-up work,
  not an extraction.
