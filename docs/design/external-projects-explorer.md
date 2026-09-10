# External Projects: read-only explorer and source view

This slice builds on the [desktop boundary](external-root-desktop-boundary.md)
and implements the explorer/source-view portion of
[Phase 1](external-project-roots-phase-1.md), including the internal Threads
adapter and local grant management. Implementation approval does not authorize
merging or a release.

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

## Threads lifecycle and mobile

Geode's internal version-1 adapter subscribes to the loaded Threads manager's
Project lifecycle. Existing Projects appear after startup, including a slow plugin
load; create, rename, cwd changes, and deletion update the section. These are
contributions only: historical cwd settings never authorize external reads.
Unsupported manager shapes fail closed. No Threads methods are patched, and no
filesystem watcher or polling loop is introduced.

Deleting a Project removes its local association but retains the root grant.
Disabling or unloading Threads withdraws live contributions and access while
retaining associations for later enablement. Stale plugin instances cannot
republish after disable, quarantine, or a vault switch.

Mobile displays portable Project IDs and labels as **Available on desktop**.
Configured, enabled Threads metadata can be read without executing an unsupported
desktop bundle. Explicit Refresh reloads metadata; there is no external filesystem
authority, desktop-path display, Files attachment, or remote proxy.

## Local folder grants

Core Settings → **Project folders** remains available when Threads is disabled.
It lists this vault's associations and unassigned grants, with counts (not labels)
for other-vault associations. Active associations must be detached from Projects;
inactive associations and unreferenced grants can be removed after native
confirmation. The native dialog identifies the exact folder, defaults to Cancel,
and makes clear that external files and execution settings are unchanged.

Confirmation and persistence recheck session ownership, active references, and
concurrent lifecycle changes. An active association in another same-vault window
cannot be removed as stale; removing a grant cannot remove a referenced root.
Grant/contribution notifications refresh affected views across windows without
watching the external filesystem.

Native picker/confirmation behavior is covered through dialog stubs in Electron
tests. Explorer/source-view screenshots verify renderer UI, not native dialogs.
No external editing, indexing, search, execution, remote access, mobile attachment,
or broader vault semantics are added by this slice.
