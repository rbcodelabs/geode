# External Projects: read-only explorer and source view

This slice builds on the [desktop boundary](external-root-desktop-boundary.md)
and implements the explorer/source-view portion of
[Phase 1](external-project-roots-phase-1.md). It does not complete the Threads
adapter or authorize a release.

## Browsing contributed Projects

The existing File Explorer keeps its vault tree. A separate **Projects** section
appears when the internal desktop integration contributes Projects. Contributions
are metadata, not grants: an unbound Project requires **Attach folder…**, a native
folder selection, and explicit read-only confirmation before it can be browsed.
Cancelling changes no files, execution cwd, or vault.

Connected folders list only their immediate children when expanded. **Load more**
requests another bounded page; **Refresh** and re-expansion re-enumerate a
directory. There is no filesystem watcher, background recursive scan, or index.
Expired cursors require refreshing the directory.

Projects sharing a root use one tree and preserve their separate labels. Nested
working directories use the shared root identity and a relative base. Projects
inside the vault reveal the existing vault folder instead of mounting a duplicate.
The host remains authoritative for overlap and grant decisions.

Missing or unavailable roots remain visible and offer **Reconnect…**. A changed
Project cwd requires detaching the previous association before another attachment;
it never silently retargets a grant. **Detach from Geode** removes an association,
not files or the Project's independently configured execution access.

Directory symlinks and unavailable links remain visible but cannot be traversed.
Contained file symlinks are marked as links and opened only after host validation.
External rows do not offer vault file mutations, dragging, or bookmarks.

## Opening source

Files open in a distinct **Read-only · External source** view. The title and
identity line include the Project/root label. Markdown and HTML are literal text:
links, embeds, scripts, and images are not rendered or executed. The host accepts
UTF-8 text up to 2 MiB; unsupported and missing files produce recoverable error
states without changing the underlying file.

**Refresh** reloads the selected resource explicitly. Grant/contribution lifecycle
notifications invalidate stale content and recheck access; these notifications
are not filesystem watching. Tabs persist versioned `{rootId, relativePath}`
identity, never a host locator. Unknown or ungranted roots remain unavailable and
never fall back to a same-named vault file. Non-desktop restoration preserves the
identity and explains that the resource is available on desktop.

External files are not `TFile`s. Existing vault files, metadata, search, wikilinks,
backlinks, graph, Canvas, Bases, bookmarks, and Obsidian-compatible plugin APIs
retain their vault-only behavior.

## Remaining Phase 1 integration

The real Threads lifecycle adapter, portable mobile Project metadata, and core
settings management of orphan grants remain separate work. Until the adapter is
connected, existing Threads Projects are not automatically contributed to this
section. Tests exercise contributions through the internal host contract; that
does not establish completion of the production Threads integration.

Native picker/confirmation behavior is covered through dialog stubs in Electron
tests. Explorer/source-view screenshots verify renderer UI, not native dialogs.
No external editing, indexing, search, execution, remote access, mobile attachment,
or broader vault semantics are added by this slice.
