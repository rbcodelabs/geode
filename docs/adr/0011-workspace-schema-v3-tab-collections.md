# ADR-0011: Workspace schema v3 for named tab collections

**Date:** 2026-08-31
**Status:** Accepted

## Context

Geode persists each vault's layout in `.geode/workspace.json`. Schema v2 models
the center, left sidebar, and right sidebar as recursive split trees. Each leaf
of that tree is still a `tabs` node with one canonical flat `leaves` array and
an `active` index. At runtime, each center `tabs` node maps to one `TabGroup`;
the same persisted node shape is also used for vertically stacked sidebar
groups.

Phase 1 named tab collections must add stable names, semantic colors,
membership, and collapsed state to each center split without changing the
meaning of existing leaf order. The design must preserve current tab cycling,
close fallback, pinned-tab behavior, plugin and deferred views, drag/move
semantics, and community-theme tab hooks. It must also recover deterministically
from old or malformed workspace files instead of making the whole layout
unrestorable.

The hard constraints are:

- A tab belongs to at most one collection, and a collection belongs to exactly
  one center `TabGroup`.
- Collection members are contiguous in canonical leaf order. A one-member
  collection is valid; an empty collection is not.
- Collapse controls header visibility only. It never changes or closes the
  active leaf.
- Pinning and collection membership are independent.
- Moving a leaf to another split removes its membership at the destination.
- Missing Markdown and Canvas files continue to be pruned; Phase 1 does not
  add tombstones or relinking state.
- Sidebars do not support collections. Mobile does not render or edit them,
  but must preserve valid desktop-created metadata.
- Phase 2 vertical tabs and a Top/Left setting are not part of this schema or
  implementation decision.

Success means a v1, v2, well-formed v3, or partially malformed v3 workspace can
be migrated and normalized in memory, restored without losing unrelated leaf
state, and saved canonically as v3.

## Decision

Workspace schema v3 keeps the flat leaf array as the only ordering authority
and adds split-local collection metadata to center tab nodes.

A representative persisted center node is:

```ts
interface PersistedTabCollectionV3 {
  id: string;
  name: string;
  color: "gray" | "blue" | "cyan" | "green" |
    "yellow" | "orange" | "red" | "purple";
  collapsed: boolean;
}

interface PersistedLeafV3 extends PersistedLeafV2 {
  collectionId?: string;
}

interface PersistedCenterTabNodeV3 {
  type: "tabs";
  leaves: PersistedLeafV3[];
  active: number;
  collections?: PersistedTabCollectionV3[];
}
```

This is an illustrative structural contract, not a requirement to introduce
those exact TypeScript type names. `collections` may be omitted when empty.
Left and right region tab nodes remain collection-free. A shared leaf type may
carry an optional `collectionId` in TypeScript for practical reasons, but the
serializer must emit and the restorer must interpret it only for center nodes.
Sidebar collection fields are ignored and are not copied into the live model.

### Ordering and identity invariants

- `leaves` is the canonical flattened visual order, including members hidden
  by collapse.
- A collection record stores presentation metadata only. It does not store a
  member list, member order, active member, or block position.
- Membership is the leaf's optional `collectionId`. Collection block order is
  derived from the first member's position in `leaves`.
- Stable collection IDs are unique only within their center tab node. They do
  not identify a vault object and are never resolved across splits.
- Members sharing a collection ID form one contiguous run after every
  mutation and normalization pass.
- `active` continues to identify a leaf in the flattened `leaves` array.
  Collapse does not alter this index or introduce a collection-level active
  pointer.

Keeping identity and presentation at the split level allows a collection to
survive when all but one of its restorable leaves disappear, while keeping
each leaf's view state in the existing leaf record.

### Migration and tolerant normalization

All supported input is migrated to an in-memory v3 shape before any leaf or
active state is restored.

1. **v1 to v3:** perform the existing v1-to-recursive-tree migration, then add
   no collections and no memberships.
2. **v2 to v3:** retain the recursive tree and leaf state, then add no
   collections and no memberships.
3. **v3:** validate and normalize each center tab node independently. A bad
   collection in one split cannot discard another split or a sidebar.

Normalization is deterministic:

- Missing collection fields mean an empty registry and ungrouped leaves.
- The first valid collection record for an ID wins; later duplicate records
  are dropped.
- A missing, empty, or non-string ID invalidates that record. References to a
  missing or invalid record are removed, leaving those leaves ungrouped.
- Names are trimmed and limited to 80 Unicode code points. Missing or empty
  names become `New collection`.
- Unknown colors become `gray`; non-boolean `collapsed` values become `false`.
- Empty collection records are removed. One-member collections remain.
- Non-contiguous members are gathered into one run at the position of their
  first member, preserving those members' relative order. Leaves not in that
  collection retain their relative order. Collections are processed in the
  order of their first member, making repeated normalization idempotent.
- Any unrecognized prototype or out-of-range ordering field is ignored;
  canonical order always comes from `leaves`.
- An invalid or out-of-range active index falls back to the first surviving
  leaf. Missing-file active fallback follows the more specific rule below.

Normalization must not throw merely because a record is malformed. A
structurally unusable node falls back through the existing workspace recovery
path; valid sibling regions and records are retained wherever possible.

### Unknown additive fields

Readers tolerate unknown additive properties at the workspace, region, node,
leaf, and collection-record levels. Migration and normalization preserve such
properties on records that survive whenever the current operation already
retains or spreads that record; for example, normalizing a recognized split
must not remove unrelated split fields. Invalid records that are dropped do
not require preservation.

This is not a promise that arbitrary future fields survive a full
deserialize-to-live-model-and-reserialize cycle. The canonical writer owns the
v3 fields it understands and may rebuild records, as the v2 writer does today.
Forward-compatible fields that must survive such a cycle need an explicit live
model or opaque preservation mechanism. Phase 1 collections are understood v3
fields and therefore do have that full-cycle preservation guarantee.

### Restore, pruning, and active state

Collection normalization runs before leaf views are created. File existence
filtering then prunes each missing Markdown or Canvas leaf rather than creating
an `EmptyView` tombstone for it. Plugin and deferred-view restoration continues
to use the existing provider-preserving behavior.

After pruning:

- surviving leaves keep their relative canonical order;
- each surviving collection keeps its ID, normalized name, color, and
  collapsed state when at least one member remains;
- a collection with no surviving members is removed;
- membership is made contiguous again if filtering exposed invalid input; and
- the active leaf is resolved only after the surviving flattened order is
  final.

If the persisted active leaf survives, it remains active. If it was pruned,
activate the nearest surviving leaf by the pre-pruning flattened order,
preferring the next leaf and then the previous leaf. If the selected leaf is a
member of a collapsed collection, restore its document as active while leaving
the collection collapsed. The collection label, not the hidden member header,
exposes active styling and the accessible active-member description.

### Desktop, mobile, and sidebar boundaries

The collection registry belongs to the shared workspace model, not only to the
desktop DOM. Mobile loads and normalizes it into that model, renders no
collection labels or commands, and serializes the same metadata back unchanged
when it saves other workspace changes. Mobile must not clear membership merely
because member headers are not displayed. Legitimate normalization, missing-file
pruning, and explicit leaf closure still apply on either platform.

Sidebars remain outside the collection model. Their tab nodes neither render
collections nor persist membership. Moving a main-area member into any sidebar
or another center split removes its source membership before the destination is
serialized.

### Phase boundary

Schema v3 contains no tab-orientation, rail-width, vertical-tab geometry, or
Top/Left setting. Phase 1 keeps `.workspace-tabs` in its established top-tab
presentation and extends existing community-theme hooks with namespaced
collection hooks. Phase 2 requires separate approval after rendered human
review of the one-, two-, and three-pane mockup and may amend this ADR if it
needs additional per-vault state.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| **Flat canonical leaf order plus split-local registry (selected)** | Preserves existing traversal, close, pin, plugin, and serialization semantics; one source of ordering truth; collection metadata survives one-member cases without duplicating view state | Requires deterministic contiguity normalization and membership-aware move helpers |
| Nested collection blocks that own member leaves | The persisted structure resembles the rendered hierarchy; contiguity is structural | Changes every consumer that expects `tabs.leaves`; complicates active indexes, tab cycling, plugin APIs, and cross-split moves; creates a larger migration surface |
| Separate ordered block list plus unchanged leaf list | Leaves existing leaf records untouched and makes block ordering explicit | Duplicates membership and order in two structures that can diverge; every mutation needs transactional updates and corruption recovery must choose which order wins |

The selected option is the smallest architecture that satisfies the approved
behavior while preserving Geode's established workspace and compatibility
contracts.

## Consequences

- Existing flat-order operations can remain authoritative after becoming
  collection-aware; collapsed members still participate in cycling and bulk
  close by their stored position.
- Collection rendering is a projection of model state. Hiding a header cannot
  hide, detach, or deactivate its leaf content.
- The v3 migration is one-way on the next successful save. The existing
  workspace backup/recovery mechanism remains the rollback boundary.
- Mutations that close, move, filter, or fail to restore leaves must finish
  with one shared normalization pass. Scattering partial cleanup among UI
  handlers would violate the invariants.
- Community themes keep the established `.workspace-tabs`,
  `.workspace-tab-header-container`, `.workspace-tab-header`, active, and
  pinned hooks. Collection markup adds namespaced classes and accessible native
  controls rather than changing existing selector meaning.
- A later public plugin API can be designed against stable behavior, but Phase
  1 exposes no collection-management API.

## Risks

- **Riskiest assumption:** users will understand an active document whose tab
  header is hidden by a collapsed collection. The required active label state,
  active-member accessible name, and rendered human review are the mitigation.
- A mutation path that bypasses normalization could persist non-contiguous
  members or orphaned registry entries. Centralized model helpers and
  corruption fixtures are required.
- Recomputing the active leaf after pruning can be off by one if it uses the
  post-pruning index. Tests must cover missing active leaves at the beginning,
  middle, and end of both grouped and ungrouped runs.
- A mobile-only serializer branch could erase hidden metadata. Mobile
  round-trip fixtures must start from desktop-authored v3 data and compare the
  registry and memberships after a mobile save.
- Community themes may assume every direct tab-strip child is a tab header.
  Fixtures must cover default light/dark plus at least two structurally
  different supported community themes.

This decision should be revisited if collections must span splits, nest, sync
independently of the workspace, acquire their own content views, or if Phase 2
orientation cannot be represented as separate per-vault presentation state.
