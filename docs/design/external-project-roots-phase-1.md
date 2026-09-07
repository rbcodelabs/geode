# Spec: External project roots — Phase 1 read-only explorer

**Status:** Approved design baseline; implementation remains blocked pending
separate approval of the bounded implementation breakdown.

**Approach:** Add a core, host-owned `RootRegistry` and stable
`{rootId, relativePath}` resource identities, then show explicitly attached
Claude Threads Project working directories as a read-only **Projects** section in
the existing File Explorer.

## Desired outcome

A desktop user can recognize a Threads Project in the File Explorer, expand its
external working directory, and open a file for inspection without adding that
directory to the vault or changing existing vault behavior.

Phase 1 also creates enough evidence to decide whether browse/open is the primary
need or whether the next investment should be editing, search, or broader vault
semantics.

## User experience

### File Explorer structure

```text
Files
├── Vault · Personal
│   └── existing vault tree
└── Projects
    ├── Geode
    │   └── external repository tree
    └── Compass                         Disconnected
        └── Reconnect…
```

- The current vault tree retains its existing placement and behavior. The
  **Vault · _name_** label may be visually compact, but vault files must not look
  subordinate to a Threads plugin.
- **Projects** appears only when at least one root attachment or disconnected
  Project reference exists.
- Each root row shows the Project display name and a restrained external-root
  indicator. It does not show the full absolute path by default.
- Expanding a connected root lazily lists its immediate children. Folders expand
  in place; files open through a root-aware document route.
- Phase 1 rows expose no new-note, new-folder, rename, delete, drag-out,
  drag-between-roots, bookmark, Canvas-drop, or vault document actions.
- External tabs show the Project/root label in their title or tooltip so that an
  external `README.md` cannot be confused with a vault `README.md`.
- Phase 1 opens UTF-8 text files up to 2 MiB in a distinct read-only resource
  view. Markdown is displayed as source text, not as a vault Markdown view.
  Binary, invalid-UTF-8, oversized, or unreadable files remain visible and
  produce a non-destructive unsupported/error state when opened.
- The tree refreshes a directory when it is expanded and through an explicit
  **Refresh** action. Phase 1 does not promise live filesystem watching.

### Attachment

Threads integration initiates attachment when a Project's effective cwd is
outside the active vault and has no matching registered root.

1. The Project row appears disconnected with **Attach folder…**.
2. Choosing it opens the native directory picker at the legacy/effective cwd when
   the platform allows a starting location.
3. The confirmation names the Project and selected folder and states that Phase 1
   permits Geode to browse and open files read-only. It explicitly states that
   agent execution permission is separate.
4. On confirmation, Geode canonicalizes and validates the directory, resolves
   overlaps, creates or reuses a stable root, and records the Project integration.
5. Cancel leaves the Project disconnected and changes no current vault, tab, or
   working directory.

The plugin cannot register an arbitrary absolute path silently. Threads supplies
a requested locator and Project metadata; Geode owns the picker, confirmation,
grant, root identity, and lifecycle.

### Reconnect and detach

- Missing, moved, permission-revoked, or device-inapplicable roots remain visible
  with distinct status text and a **Reconnect…** action.
- Reconnect uses a directory picker and requires the same attachment validation.
  It preserves `rootId` only when the user explicitly confirms that the selected
  directory replaces the unavailable locator for that root.
- After reconnect, persisted external tabs resolve against the preserved
  `ResourceRef`; missing files show a file-not-found state rather than opening a
  same-named file elsewhere.
- **Detach from Geode** removes the local Project-to-root reference after
  confirmation. It does not delete files, delete the Threads Project, change its
  cwd, or revoke Threads' independently configured execution behavior.
- A shared root remains registered while another Project reference uses it.

## Core model and contracts

### Root record

The implementation may refine names, but must preserve this semantic model:

```ts
type RootKind = "vault" | "project-cwd";

type RootCapability =
  | "browse"
  | "read"
  | "open";

interface HostPhysicalIdentity {
  device: string;
  inode: string;
}

interface RootRecord {
  rootId: string;
  kind: RootKind;
  label: string;
  locator: HostRootLocator;
  physicalIdentity: HostPhysicalIdentity;
  capabilities: ReadonlySet<RootCapability>;
  availability: "connected" | "missing" | "permission-revoked" | "unavailable";
  createdAt: number;
  lastConnectedAt?: number;
}

interface ResourceRef {
  rootId: string;
  relativePath: string;
}
```

- `HostRootLocator` is host-private. Renderer and plugin-facing messages receive
  opaque `rootId`s, display metadata, and normalized relative paths—not authority-
  bearing absolute paths.
- The distinguished vault root can be discoverable internally through the
  registry, but existing vault APIs remain authoritative for vault operations.
- Resource equality is `rootId` plus normalized `relativePath`, with the host's
  canonical path rules used for access and collision checks.
- `rootId` survives an explicitly confirmed reconnect to a moved or replacement
  directory. `ResourceRef` provides path identity, not inode identity: file
  rename/move stability is not promised.
- A file `relativePath` is non-empty, slash-separated, and Unicode-preserving.
  It rejects absolute paths, empty/dot segments, `..`, NUL, drive/UNC prefixes,
  and platform variants that would normalize outside the root.
- Directory entries carry explicit file/folder/symlink/unavailable-link kind and
  minimal stat information required for display.

### RootRegistry responsibilities

- Attach, reconnect, detach, look up, and list roots and their integration
  references.
- Produce stable `rootId`s and persist device-local records.
- Canonicalize locators, detect overlaps, and enforce attachment policy.
- Report capability and availability changes.
- Resolve a `ResourceRef` through containment-safe host APIs.
- Refresh cached directory listings and invalidate affected explorer nodes/tabs.
- Deduplicate exact or nested Project roots without silently broadening access.
- Own one application-lifetime store and serialized mutation queue. Per-window
  operations use a main-created facade carrying the IPC sender's current vault
  session; stale sessions cannot commit after a picker or confirmation.

The registry does not parse Markdown, create `TFile`s, add metadata records, or
decide Threads execution policy.

## Containment, symlinks, and overlap

All requirements in ADR-0015 are normative. In addition:

- Listing is lazy and bounded so attaching a large repository does not trigger a
  full recursive scan. The host returns at most 250 immediate entries per page
  through opaque 30-second cursors, capped at 16 live cursors per window.
- Phase 1 hides only `.git` internals and `.DS_Store`; other dotfiles and large
  vendor/build directories remain visible but collapsed and are never scanned
  recursively without user navigation.
- Directory symlinks are visible but non-traversable. A file symlink clearly
  identifies itself as a link and may open only when its final target is inside
  the root. Previous validation is not trusted after filesystem changes.
- An out-of-root or broken symlink is non-traversable. Opening it never delegates
  to the OS as an implicit escape from the grant.
- Exact-root deduplication and descendant reuse preserve separate Project labels
  while sharing one underlying root grant.
- Parent-overlap attachment is blocked rather than widening an existing grant.
  The user may detach narrower roots first and then attach the broader root as a
  deliberate new action.

## Desktop and mobile behavior

### Desktop

- macOS Phase 1 supports local directory attachment through the native picker.
- Connected roots may list and open resources while Geode is running.
- Expansion and an explicit **Refresh** action re-enumerate directories. Phase 1
  does not start an external-root watcher.
- Files are opened read-only regardless of filesystem write permission.

### Mobile

- A desktop `project-cwd` record does not grant or synchronize that directory on
  iOS or Android.
- Projects may appear under **Projects** as **Available on desktop** using portable
  Threads Project metadata, without exposing a desktop absolute path.
- Phase 1 mobile provides no attach-to-Files flow and no remote file proxy.
- Tapping an unavailable Project explains that its files can be browsed in the
  desktop Geode instance; it does not display an empty tree.
- A future document-provider or paired-desktop root requires its own capability
  and trust design.

## Claude Threads integration

- Threads exposes Project id, display name, effective-cwd attachment request, and
  lifecycle changes through a narrow, versioned integration contract.
- A binding key includes the originating Geode vault/plugin instance and Threads
  Project id. Project ids are portable within Threads; `rootId` and the binding
  to a local locator are device-local.
- On desktop startup, Project creation, or cwd change, Threads asks Geode to find
  or attach a matching root. A request never creates authority without the core
  attachment UX.
- Threads persists its existing `vaultFolder`, `cwdOverride`, and effective-cwd
  behavior during Phase 1. A new optional local association maps Project id to
  `rootId` (and, for descendant reuse, a relative base path).
- Existing Projects are not bulk-attached during migration. They appear
  disconnected and require one user grant each, except when several Projects
  intentionally resolve beneath an already granted root.
- Deleting a Threads Project removes its integration reference but does not
  automatically detach a root shared elsewhere.
- Changing a cwd does not silently retarget an existing `rootId`; the new location
  requires attach/reconnect confirmation.
- Disabling or uninstalling Threads removes its live integration UI contributions
  but does not corrupt the vault. Orphaned local root grants remain visible and
  removable in core settings; they are never garbage-collected silently.
- Phase 1 adds no supported external-root surface to the Obsidian-compatible
  `App`, `Vault`, `TFile`, adapter, or public plugin APIs. Desktop plugins are
  trusted same-world code with Node access, so this is a compatibility/API
  boundary rather than malicious-plugin isolation. A sandboxed plugin runtime or
  public workspace-resource API is a separate decision.

## Migration and compatibility

- Existing vault layouts, paths, caches, workspace state, plugin data, and
  `FileSystemAdapter.getBasePath()` remain unchanged.
- Existing `Vault`, `TFile`, `TFolder`, wikilink resolution, backlinks, metadata,
  graph, tags, search, bookmarks, Canvas, Bases, and plugin APIs operate only on
  the vault.
- Existing persisted vault tabs keep their current path schema. New external tabs
  use a versioned root-aware state containing `ResourceRef` and display metadata.
- Unknown, missing, or ungranted root IDs restore as recoverable unavailable tabs;
  they never fall back to the vault or an absolute path.
- Threads continues to accept existing `cwdOverride` values. The new `rootId`
  association augments rather than replaces them in Phase 1.
- Removing or rolling back Phase 1 leaves vault state readable by earlier Geode
  versions. Earlier versions may ignore external-tab and root-registry state but
  must not be asked to interpret it as vault state.

## Capabilities and failure behavior

| Capability/state | Phase 1 behavior |
|---|---|
| List directory | Allowed for connected, granted roots; lazy and bounded |
| Read/open file | Allowed; Geode view is read-only |
| Refresh | On directory expansion and explicit user action; no live watch |
| Write/create/rename/delete/trash | Not exposed |
| Search/index/metadata | Not exposed |
| Wikilinks/backlinks/tags/graph | Vault-only |
| Existing plugin access | Vault-only |
| Root missing or moved | Persist disconnected row and offer Reconnect |
| Permission revoked | Persist row, identify revocation, offer Reconnect |
| File disappears while open | Preserve tab identity and show unavailable state |
| Out-of-root symlink | Show non-traversable link; deny open |

## Non-goals

- Editing or mutating external files.
- Project-wide content search, filename indexing, metadata extraction, or Git
  integration.
- Cross-root wikilinks, embeds, backlinks, tags, graph edges, Canvas file cards,
  Bases sources, bookmarks, or Daily Notes.
- Treating external Markdown as a `TFile` or emitting vault events for it.
- A public or Obsidian-compatible plugin API for workspace roots.
- Manual non-Threads root attachment in Phase 1.
- Remote access, file synchronization, paired-desktop file proxying, or mobile
  document-provider attachment.
- Shell/terminal commands or deriving execution trust from a root grant.
- Windows/Linux release support beyond keeping contracts platform-neutral.

## Acceptance criteria

### Identity and registry

- [ ] Attaching a valid external Project directory creates a stable opaque
  `rootId` and persists a host-private locator.
- [ ] The same physical directory requested again reuses the `rootId`.
- [ ] Every external entry and tab is addressed by normalized
  `{rootId, relativePath}` with no absolute-path or `../` fallback.
- [ ] Restart preserves root and resource identities.
- [ ] Multiple vault windows share one registry/persistence queue while applying
  overlap checks against each calling window's own active vault.

### Attachment and reconnect

- [ ] A Project cwd outside the vault appears disconnected until the user chooses
  **Attach folder…** and confirms read-only access.
- [ ] Cancel changes neither root state nor the active vault/workspace.
- [ ] Switching or closing the originating vault window while its native picker
  or confirmation is open makes that request stale and commits no change.
- [ ] Missing, moved, revoked, and mobile-unavailable roots remain visible with
  correct recovery messaging.
- [ ] Reconnect can preserve `rootId` only through explicit replacement
  confirmation and never binds a same-named directory automatically.
- [ ] Detach removes no external files and does not alter the Threads Project cwd.

### Containment and overlap

- [ ] Traversal, absolute relative paths, malformed paths, and canonical targets
  outside the granted root are rejected.
- [ ] Directory symlinks cannot be traversed; contained file symlinks can open;
  out-of-root, broken, and looping symlinks cannot be traversed or opened.
- [ ] Exact duplicate and descendant Project roots reuse existing grants without
  duplicate explorer trees or resource identities.
- [ ] Attaching a parent of an existing root is blocked without silently widening
  access.
- [ ] A Project cwd inside the vault reveals the existing vault folder and does
  not create an external root.

### Explorer and open behavior

- [ ] Connected external Projects appear in a distinct **Projects** section in
  the existing File Explorer.
- [ ] Directory enumeration is lazy; expanding one directory does not recursively
  scan the root.
- [ ] Directory enumeration pages contain at most 250 immediate entries; opaque
  cursors expire and never expose or persist an absolute locator.
- [ ] Opening a supported external file produces a read-only tab whose identity
  and source root are unambiguous.
- [ ] UTF-8 text files at or below 2 MiB open as source in a distinct resource
  view; Markdown receives no vault rendering or link behavior, and unsupported
  content fails non-destructively.
- [ ] No mutation or vault-only action is shown for external entries.
- [ ] External files do not enter vault search, metadata, wikilinks, backlinks,
  tags, graph, bookmarks, Canvas, Bases, or plugin `Vault` APIs.
- [ ] A missing open file/root shows a recoverable unavailable state and never
  resolves to a same-path vault file.

### Platform and compatibility

- [ ] Desktop attachment and browse/open work without changing existing vault
  behavior or persisted vault tabs.
- [ ] Mobile shows desktop-only Projects as unavailable rather than empty or
  synchronized.
- [ ] Existing Threads Projects and `cwdOverride` continue working before and
  after attachment.
- [ ] Disabling Threads or loading an older-compatible workspace cannot convert
  external resources into vault resources.

## Validation plan

The riskiest assumption is: **for external Project roots, browse and open supply
the primary near-term value without external editing, search, or vault semantics.**

Run a small instrumented dogfood before approving Phase 2:

1. Recruit 5–8 repository-heavy Geode/Threads users for 20–30 minute observed
   tasks, then dogfood with 3–5 real Projects for two weeks. Cover a source
   repository, a documentation-heavy repository, a small scripts folder, and at
   least one missing/moved root scenario.
2. Observe four tasks: find/open a known file; browse an unfamiliar repository to
   locate a config or test; switch between a vault note and Project file; and
   reconnect a moved repository.
3. Record opt-in, content-free events: Project section viewed, root expanded,
   directory expanded, file opened, Reconnect started/completed, and explicit
   **Open in external editor** usage. Do not record paths or filenames.
4. Add a lightweight in-product prompt after several external opens: “What did
   you need next?” with choices **Nothing**, **Edit**, **Search**, **Git context**,
   and **Vault links/metadata**, plus optional free text.
5. Keep a short diary for failed tasks: what the user tried to accomplish and
   which missing capability forced them out of Geode.

Decision guidance:

- Validate browse/open if at least 80% of observed tasks complete without Finder
  or Terminal, median time to first known-file open is at most 30 seconds,
  browse/open comprise at least 70% of recorded Project-root interactions, and no
  more than 20% of sessions hit a blocked edit/search need.
- Prioritize Phase 2 editing or search if more than 30% of participants cannot
  complete because one is absent, or blocked-action demand appears in more than
  25% of active Project-root sessions.
- Revisit the ADR only if vault semantics are a frequent blocker; isolated demand
  does not justify migrating the vault model.

The sample is directional rather than statistically generalizable. Its purpose is
to choose the next slice and catch a wrong product model cheaply.

## Expected implementation surface after approval

No implementation is authorized by this proposed spec. The likely affected areas
are listed only to bound future planning:

- main-process root registry, persistence, directory picker, containment resolver,
  and lazy listing/reading;
- preload and renderer host contracts for additive root-aware operations;
- File Explorer rendering and external read-only document/tab state;
- workspace persistence/recovery for `ResourceRef` tabs;
- a narrow optional Claude Threads integration contract;
- unit tests for identity, containment, symlinks, overlap, and migration;
- Electron E2E tests for attach, browse/open, reconnect, and vault isolation; and
- mobile renderer tests for unavailable desktop Projects.

## Approval gate

The ADR and this Phase 1 spec were approved as the design baseline on 2026-09-04.
Implementation must not begin until engineering produces a bounded, test-first
implementation breakdown and receives separate approval. Implementation must use
the repository's normal isolated-worktree and verification workflow.
