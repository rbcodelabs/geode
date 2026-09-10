# Durable companion panes

Geode provides an optional workspace extension for plugins that repeatedly open
context beside a main conversation or editor. This is **not an Obsidian API**;
plugins supporting other hosts must feature-detect it.

```ts
workspace.getOrCreateCompanionLeaf(
  ownerKey: string,
  anchorLeaf: WorkspaceLeaf,
  leadingRatio: number,
): { leaf: WorkspaceLeaf; reused: boolean }
```

Call after `workspace.onLayoutReady`. Supply a stable namespaced owner key,
such as `example-plugin:context`, and an attached center anchor leaf. Calls before
layout readiness, during restoration, with an empty owner, or with an invalid
anchor throw without creating a destination. The ratio is the anchor's share
when a new split is required (for example, `0.3`); existing sizes are preserved.
Invalid ratios follow the existing split API's equal-split fallback.

The owner identifies one center split per workspace, independently of its view
type, content, runtime leaf ID, or plugin instance. An existing designated tab
is returned with `reused: true`, including a pinned tab; the plugin explicitly
chooses its navigation target. Otherwise a destination tab is created inside
the owned split, or a new split is created beside the anchor if necessary.
The API selects a destination synchronously; callers open content and reveal it.

Ownership survives plugin reloads, workspace restoration, document/browser
changes, and deferred plugin views. Closing the designated tab while other tabs
remain retains split ownership. Moving that tab elsewhere clears its designation
and retains the original split, even if empty. Closing the split releases its
ownership, including the last center group that Geode replaces with an empty tab.
New tabs/copies do not inherit another tab's designation.

Optional `companionOwner` fields on the saved tab node and designated leaf carry
this state in the existing workspace format. The split is authoritative; the first
center split and matching leaf in persisted order win if duplicate metadata is
present. Redundant or malformed ownership and sidebar ownership are discarded;
tab content is preserved. Older layouts remain supported. Durability follows the
existing debounced workspace-save guarantee.

Unmarked panes from older plugins are never adopted heuristically. Users may
close pre-existing duplicates manually. Disabling a plugin does not close its
companion content. See [ADR-0018](../adr/0018-durable-companion-panes.md).

## Verification

Build the updated Agent Threads distributable, then run this from the Geode repo:

```sh
GEODE_AGENT_THREADS_DIST=/path/to/agent-threads/dist npm run test:e2e -- tests/e2e/companion-plugin-integration.spec.ts
```

The integration loads the actual `main.js`, `manifest.json`, and `styles.css`
through Geode's plugin manager in a disposable vault. It checks companion reuse
through destination closure, plugin reload, and two app relaunches. No agent
sessions or credentials are needed. The test skips by default when the artifact
directory environment variable is absent; ordinary host lifecycle tests still run.
