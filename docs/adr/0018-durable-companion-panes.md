# ADR-0018: Durable companion split ownership

**Date:** 2026-09-09
**Status:** Accepted

## Context

A plugin that remembers a contextual destination in memory loses that association
when its module reloads or the workspace recreates leaf objects. It then creates
another split despite the previous context remaining visible. Tracking only a tab
also loses the split when that tab closes but sibling tabs remain.

## Decision

Provide `Workspace.getOrCreateCompanionLeaf(ownerKey, anchorLeaf, leadingRatio)`
as a feature-detected Geode extension. Persist ownership on the center tab group
and a destination designation on one leaf, independently of view state. Publish
ownership before synchronous workspace callbacks. Restore ownership before view
mounting, and reject destination creation while layout restoration is incomplete.

The group is authoritative and one owner key names one split per workspace. Moving
the designated leaf clears its designation but keeps the original split; explicit
group closure clears ownership. Existing unrelated tabs are never adopted.

## Options considered

| Option | Benefit | Cost |
|---|---|---|
| Infer from position or matching content | Plugin-only change | Can replace unrelated user content |
| Persist a runtime leaf ID | Small state change | IDs change on restore; ignores surviving split siblings |
| Persist split ownership and destination designation | Reliable across view and lifecycle changes | Small host API and additive layout metadata |

## Consequences

Plugins can recover context without storing host runtime IDs. Older layouts work;
older hosts require a plugin fallback. Duplicate markers use the first persisted
center group and matching leaf, stripping only redundant metadata. Unmarked old
panes remain manual cleanup. The API does not expand Geode's Obsidian API baseline.

## Risks

Ownership is only as durable as the existing layout save. A crash before that save
can lose a new association. The workspace-wide key deliberately limits a plugin
to one companion per key; multi-conversation ownership would need separate keys.
Future copy/split operations must continue to avoid inheriting these identifiers.
