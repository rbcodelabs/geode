# ADR 0005 — Deferred view restore for unavailable providers

**Status:** Accepted
**Date:** 2026-08-28
**Supersedes nothing. Amends:** ADR 0003 (Consequences).

## Context

Workspace restore resolved each saved leaf's view type against the registered
view-factory map exactly once, at restore time, and permanently discarded
anything it could not resolve. There was no retry when a plugin registered its
view a moment later, and no preservation of the saved state in the meantime.

Three distinct loss paths existed:

1. **Docked sidebar panes were silently dropped.** `restoreSidebar` was
   `if (existingBuiltin) … else if (factory) …` with no `else` at all. A pane
   whose factory wasn't registered yet was never created.
2. **Centre tabs degraded to empty, then vanished.** `restoreLeafView` fell
   back to an `EmptyView`, and `serializeLeaf` returns `null` for `empty`, so
   the next debounced save dropped the leaf from `workspace.json` — destroying
   the saved `type` and `state`.
3. **Crash recovery made it permanent.** In recovery mode `PluginManager`
   enables no plugins at all, so zero factories exist during restore, and the
   recovery launch's own layout save rewrote `workspace.json` with every plugin
   pane stripped — before the user ever clicked "Restart with plugins".

A fourth, independent instance of the same shape: `graph` and `base` are
constructed directly by the app and had no registered factory, so open Graph
and Bases tabs also didn't survive a restart, via path 2.

`unregisterViewFactory` compounded all of this by calling
`detachLeavesOfType`. It runs from `Plugin.registerView`'s auto-unregister on
`onunload`, so a routine plugin *update* — disable then enable — destroyed the
user's panes on the way through.

## Decision

A saved pane is never silently discarded. If its provider isn't available, the
leaf survives as a labelled placeholder that keeps its `type` and `state`
through save cycles and hydrates into the real view the moment the factory
registers.

**`DeferredView` impersonates the persisted view type.** `viewType` returns the
saved type string; `getState()` returns the saved state object by identity.
This is what makes the mechanism cheap: `getLeavesOfType` and `serializeLeaf`
both key off `leaf.view.viewType` and already do the right thing, so
persistence is lossless with *no* `instanceof` branch in the serializer, and
the standard plugin idiom `if (getLeavesOfType(VIEW).length) return;` still
finds the pane.

Two guards make impersonation safe rather than a trade of one bug for another:

- **A built-in view-type registry**, populated by `Sidebar.addView` rather than
  hardcoded, so it stays authoritative as built-ins come and go. Built-ins have
  no factory either — they are constructed at boot and matched by leaf
  identity. Deferring one would mint a ghost pane that persists forever and
  break callers such as `App.openSearch`, which casts
  `getLeavesOfType('search')[0].view` to `SearchView` and calls `setQuery`.
- **A snapshot of the leaves that existed before the restore pass.** The
  `existingBuiltin` lookup takes `getLeavesOfType(type)[0]`, which would
  otherwise match a placeholder minted moments earlier in the same pass —
  collapsing two same-type panes into one, or (sidebars restore first) stealing
  a docked pane into a centre tab group.

**Hydration is awaited between restore and `flushLayoutReady()`.** A
placeholder satisfies the `getLeavesOfType(VIEW).length` guard, so a plugin
whose `onLayoutReady` ran while its pane was still deferred would skip opening
its view and leave a dead placeholder for the whole session — a new failure
mode. `registerViewFactory` also hydrates fire-and-forget, which covers the
post-onload-timeout and Settings-re-enable cases; only the awaited pass
guarantees the ordering.

**Each leaf hydrates inside its own try/catch.** A stale persisted state can
make a plugin's `setState` reject, and hydration runs inside the awaited
`onload` chain, where an escaping rejection would reach
`PluginManager.recordAndQuarantine` and **disable the whole plugin over one bad
pane**. On failure the leaf stays deferred with its state intact, shows the
error, and retries next launch. A generation guard reverts a hydration whose
factory was unregistered mid-flight, since `PluginManager.reload()` is
disable-then-enable.

**`PersistedLeaf` gains optional `title` and `icon`.** Both are additive and
backward compatible. Icon is load-bearing rather than cosmetic:
`Sidebar.renderIcons` builds icon-only tabs, so a deferred sidebar pane with no
icon renders as an invisible strip entry — indistinguishable from the pane
having vanished, which is the bug being fixed.

**Layout saves are suppressed in crash-recovery mode.** Belt and braces on top
of the above: deferral already makes the save lossless, but a recovery launch
is exactly the moment a future regression would be unrecoverable.

**`graph` and `base` get real factories.** `BaseView` gains
`getState()`/`setState()` carrying the `.base` file path.

## Alternatives considered

- **Keep `EmptyView` but stop filtering `empty` out of the serializer.** Would
  preserve the leaf slot but not the `type` or `state`, so nothing could be
  rehydrated; it also resurrects the empty-tab accumulation bug that the filter
  exists to prevent.
- **Have `DeferredView` report its own `viewType` (e.g. `"deferred"`) and add
  an `instanceof` branch to the serializer.** Honest, but it breaks
  `getLeavesOfType`, so every plugin's reuse guard stops finding its pane and
  duplicates appear on every launch.
- **Retry restore on a timer.** Unbounded, and still loses the state in the
  window before the retry.

## Limits

- A plugin that calls `detachLeavesOfType` in its own `onunload` still
  hard-detaches its panes. The guarantee is "Geode won't destroy your panes",
  not "no plugin can".
- Layout tweaks made during a crash-recovery session (moving a tab, resizing a
  sidebar) are not persisted. Recovery sessions are short and end in a reload.
- A pane whose plugin is uninstalled entirely stays as a placeholder
  indefinitely. Preferable to silent deletion, but there is no UI yet to sweep
  placeholders for providers the user has deliberately removed.
- `isDeferred`/`loadIfDeferred` diverge from Obsidian's semantics — see
  `docs/spec/03-plugin-api.md`.

## Consequences

A renderer crash, a slow plugin, a plugin update, a disable/re-enable cycle,
and a quarantine no longer cost the user their workspace layout. Restore
becomes idempotent with respect to provider availability: the same
`workspace.json` produces the same panes whether or not the plugins behind them
happen to be loaded yet.
