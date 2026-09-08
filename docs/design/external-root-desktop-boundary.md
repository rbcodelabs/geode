# External project roots: desktop boundary

This is the second implementation slice of [ADR-0015](../adr/0015-external-project-roots.md)
and the [Phase 1 spec](external-project-roots-phase-1.md). It supplies the internal
desktop service. The additive [explorer/source-view slice](external-projects-explorer.md)
uses this boundary without enabling external file editing, indexing, watching,
execution, or vault semantics.

## Ownership and internal contract

`ExternalRootService` lazily initializes one application-wide registry and store.
Each active vault window receives a session facade. Main derives its instance key
from the canonical vault path; renderer input cannot choose a vault/window owner.
Switching vaults or closing a window invalidates its facade and closes directory
cursors. Embedded guest contents cannot call these IPC endpoints.

Grant persistence stages JSON first, then rechecks the session/contribution just
before initiating the atomic rename. That rename is the commit point: invalidation
before it cancels the staged write; an already initiated commit is not rolled back
by a later window switch. Registry mutations remain serialized throughout.

The optional `HostServices.externalRoots` service is macOS-only. It offers
contribution/listing, attach/reconnect/detach, directory pages, bounded UTF-8
reads, and core grant management. It is a narrow internal integration, not an Obsidian `App`, `Vault`,
`TFile`, or adapter API. Browser and mobile hosts do not provide this service.

Contributions contain a Project ID, display label, and optional native-picker
starting location. Contributions alone grant no access. Native confirmation names
the selected directory, states that access is read-only, and separates it from
agent execution permission. Confirmation defaults to Cancel. Reconnect explicitly
replaces the existing root's locator; detach removes only the binding.

## Persisted association details

Root storage uses schema version 2 to include physical device/inode identity.
The earlier foundation was not wired to production attachment. Unsupported or
malformed stores fail closed without being overwritten; no legacy cwd is promoted
to a grant during loading.

A binding optionally records a SHA-256 `sourceFingerprint` of the Project's cwd
hint at attachment. It contains no absolute path. A changed hint, or a legacy
binding without the fingerprint, displays as disconnected and requires explicit
detach followed by attachment. This also works after restart and does not mistake
a user-selected directory for a silent change to Threads' execution cwd.

Removing a live contribution immediately removes its access from that session.
Disable/unload retains stored bindings. An observed Project deletion removes only
the matching current-vault binding through guarded, serialized persistence; it
retains the root grant and other-vault bindings. Initial or malformed snapshots
never infer deletions. Core Settings exposes explicit removal of inactive
associations and unreferenced grants, guarded against same-vault active windows,
stale confirmations, and changed references. Renderer descriptors omit host
locators and other-vault Project labels.

## I/O guarantees and limits

- Files are addressed only by `{rootId, relativePath}`. Host responses omit
  absolute locators and physical identity. Error envelopes carry bounded error
  codes, not filesystem error messages containing paths.
- Directory iteration examines at most 250 immediate entries per page, without
  a recursive scan or whole-directory materialization. Hidden/special entries
  count toward the scan bound, so pages may contain fewer visible entries.
- Single-use cursors are session/root/directory scoped, expire after 30 seconds,
  and are capped at 16 per session. Refresh, expiry, eviction, and disposal close
  iterator handles. Directory identity is checked before and after each page.
- `.git` and `.DS_Store` are hidden; special filesystem nodes are omitted.
  Directory symlinks remain non-traversable. Contained file symlinks may open.
- Reads use read-only, no-follow, nonblocking handles, so a FIFO replacement
  cannot hang an open. Short reads continue to EOF within a 2 MiB + 1 byte
  buffer. The inclusive 2 MiB limit, fatal UTF-8 decoding, and NUL rejection are
  enforced before returning text.
- Root and file path/physical identity are revalidated. Detected replacement,
  modification, or session change discards the result. These are fail-closed
  checks on detected races, not a descriptor-relative sandbox against a hostile
  local process, as the ADR states.
- In-flight reads and pages also compare the current registry grant to their
  captured root after I/O/handle closure, rejecting content from a previous
  locator when another window reconnects that root ID.

Availability is probed on explicit listing/refresh without a watcher. Missing or
revoked roots keep their stable descriptor and expose a recovery state. No external
file enters vault metadata, search, backlinks, or the vault file list.

## Verification surface

Unit tests cover registry persistence/overlap, containment, symlinks, bounded
reads/pages, stale sessions/contributions, fingerprints, and per-vault access.
Electron integration tests use throwaway vaults and stub native dialogs to check
the preload/main route, denied guest access, vault-file isolation, and cancellation
when a pending picker outlives its vault. Explorer/source-view verification is
described in its separate slice; real native-dialog visual verification is not
claimed by these stubbed-dialog tests.
