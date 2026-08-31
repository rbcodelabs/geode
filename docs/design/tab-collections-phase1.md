# Phase 1 Product Specification: Named Tab Collections

**Status:** Accepted and implemented (Phase 1); Phase 2 remains unapproved pending rendered human review
**Date:** 2026-08-31
**Product:** Geode desktop
**Phase:** 1 of 2; tab orientation is a separate Phase 2 decision

## 1. Summary

Phase 1 adds named, colored, collapsible collections to the tabs in each main document split. A collection helps a user keep related documents together without changing the underlying files, folders, links, or vault structure.

Collections are local to one main split pane. Moving a tab to another split removes its collection membership. Left and right sidebars are unchanged. Tab orientation remains at the top in this phase; the approved single per-vault Top/Left orientation setting belongs to Phase 2.

## 2. Outcome and validation

### Desired outcome

Users with many open documents can preserve task context, find related tabs, and temporarily reduce tab-strip clutter without creating folders or changing note structure.

### Evidence confidence

**Weak:** the feature direction currently has one direct stakeholder/user source. The behavior is sufficiently defined to prototype and test, but not yet supported by multiple independent user signals.

### Telemetry-free success criteria

Geode will not add product analytics for this feature. Validate with:

- A moderated usability pass using workspaces with 12-20 tabs and one, two, and three splits.
- A five-task script: create a collection, rename/recolor it, reorder it, collapse and recover a member, and move a member to another split.
- Success target: each participant completes all five tasks without instruction after the initial feature introduction; no task has more than one navigation or membership error.
- A seven-day opt-in diary from dogfood users: whether collections survived relaunch, whether any tab appeared lost, and whether users kept at least one collection rather than immediately dismantling all of them.
- Automated persistence/restore fixtures and visual snapshots; these are quality evidence, not behavioral telemetry.

### Riskiest assumption and smallest test

The riskiest assumption is that a collapsed collection can hide its headers while leaving its active document visible without making the workspace feel inconsistent. The smallest useful test is a clickable prototype with an active member, a collapsed label, and activation from the All tabs menu. If most participants believe the active document was removed, moved, or no longer belongs to the collection, revise the collapsed-active treatment before implementation.

### Abandon or revise if

- Users repeatedly lose track of the active document after collapsing its collection.
- Dragging across collection boundaries produces accidental membership changes in the usability pass.
- Community-theme compatibility requires replacing the established workspace tab DOM rather than extending it.

## 3. Scope and terminology

- **Split pane:** one main document content area and its tab strip (`TabGroup` in the current workspace model).
- **Collection:** an ordered, named, colored block of one or more tabs in one split pane.
- **Collection label:** the colored, interactive header immediately before its member tabs.
- **Ungrouped tab:** a normal main-area tab with no collection membership.
- **Member:** a tab belonging to a collection.

A tab belongs to zero or one collection. Collections never span split panes and cannot contain sidebar panes.

## 4. Detailed interaction specification

### 4.1 Creation entry points

Provide these desktop entry points:

1. A main-tab context-menu item, **Add tab to new collection**.
2. A main-tab context-menu submenu, **Add tab to collection**, listing collections in that tab's current split.
3. A command-palette command, **Tabs: Add active tab to new collection**.
4. Dropping an eligible ungrouped tab onto an existing collection label adds it to that collection. Dragging one ungrouped tab directly onto another tab does not create a collection; this avoids an ambiguous high-frequency drop target.

Creation places the collection at the original tab's visual position, gives it the defaults below, and focuses inline name editing. Enter accepts the name; Escape accepts the default rather than undoing creation. Clicking elsewhere also accepts the current value.

There is no multi-select tab model in Phase 1. Users add additional tabs by drag/drop or the context-menu submenu.

### 4.2 Default name and color

- Default name: **New collection**.
- Empty or whitespace-only names are normalized back to **New collection**.
- Trim leading/trailing whitespace.
- Maximum stored name: 80 Unicode code points. The UI truncates visually with an accessible full-name label; it does not mutate shorter names to fit available width.
- Use a fixed semantic palette of eight theme-aware color tokens: gray, blue, cyan, green, yellow, orange, red, and purple.
- New collections use the next palette color not already used in that split; when all are used, continue round-robin. Color selection is deterministic from the split's collection order, not random.
- Color is an accent on the label and member indicator, never the sole indication of membership or state.

### 4.3 Rename and color changes

The collection label context menu provides **Rename collection** and **Collection color**. Double-clicking the label text also starts rename. The color submenu shows all palette options with text labels and a selected state.

Renaming or recoloring is immediate, undo-independent workspace configuration. It does not modify files or file history. Each change triggers the normal debounced workspace save.

Collection names need not be unique. Menus disambiguate duplicate names using their color swatch and current visual order.

### 4.4 Visual ordering model

Each split has one ordered sequence composed of:

- ungrouped tabs, each as one item; and
- collection blocks, each comprising its label followed by its contiguous ordered members.

Members of a collection are always contiguous in the visual and persisted order. A collection block may sit between ungrouped tabs or other collection blocks.

### 4.5 Drag and drop

All drops show an insertion marker and a membership preview before commit. Invalid targets keep the normal cursor and do not mutate state.

#### Tabs within the same collection

- Drag between member tabs to reorder within the collection.
- Dropping on the collection label appends the tab to the collection.
- Reordering does not expand or collapse the collection.

#### Ungrouped tabs

- Drag between ungrouped items or collection-block boundaries to reorder as ungrouped.
- Drag onto a collection label or between two visible members to join that collection at the indicated position.
- Drag into the leading or trailing outside edge of a collection block to remain ungrouped before or after the entire block. The insertion preview explicitly says **Ungrouped** at these boundaries.

#### Dragging a member out

- Drag to an ungrouped insertion target to remove membership and insert there.
- Drag into another collection to transfer membership and insert at the indicated member position.
- Drag to another split pane uses the existing split drop behavior and always removes membership, even when the destination contains a collection with the same name/color.
- Drag to a newly created split also removes membership.

#### Collapsed collections

- A collapsed label is a drop target; dropping onto it appends the tab without expanding it.
- Dragging a hidden member begins only from a menu/command that exposes a move action; Phase 1 does not provide a synthetic drag handle for hidden members.
- Dragging the collection label moves the entire collection block within its current split. It cannot be dragged to another split in Phase 1.

#### Collection and tab order

- Dragging a collection label before/after an item moves the entire block and preserves member order and collapsed state.
- Collections cannot nest.
- An insertion point never splits one collection block unless the dragged tab is explicitly joining that collection.

### 4.6 Expand and collapse

- Clicking the label's disclosure control toggles collapsed/expanded state.
- Expanded: label and all member tab headers are visible.
- Collapsed: only the collection label is visible; member tab headers are hidden, but member tabs remain open and retain their order, view state, pin state eligibility, and file buffers.
- The label shows the member count and an active-member indicator when applicable.
- Collapse state persists per collection per vault.
- Collapsing/expanding does not change the active leaf, close views, or alter navigation history.

#### Collapsing a collection that owns the active tab

The active document remains visible in the pane. Its tab header becomes hidden with the other members. The collection label receives the active styling and exposes the active member's title in its tooltip/accessibility description (for example, **Research, collapsed, 4 tabs, active: Interview notes**).

Clicking the collapsed label's main surface keeps the current document active and the collection collapsed. Only the explicit disclosure control, expand command, or equivalent accessibility action changes collapsed state.

#### Activating a hidden member

When a hidden member is activated from **All tabs**, the command palette, a quick switcher, an internal API call, session restore, or next/previous-tab cycling:

1. The member becomes active using the existing activation behavior.
2. Its document content is shown.
3. The collection remains collapsed and its label receives the active styling and updated active-member accessibility description.
4. Focus returns to or remains in the document; no hidden tab header receives focus.

Only an explicit disclosure/expand action reveals member headers. Activation and expansion are deliberately independent so a user's saved clutter-reduction choice is not undone by navigation.

### 4.7 Moving tabs between splits

Collection membership is scoped to the source split and never carries across a split move. The moved tab becomes ungrouped at the destination insertion position. Its live view, active state, pin state, and view-specific state otherwise follow existing move behavior.

If removing the tab leaves no members, delete the source collection. A one-member collection remains valid.

Moving an entire collection between splits, copying a collection, or automatically matching same-named collections is out of scope.

### 4.8 Final tab leaving or closing

- One-member collections are valid and persist normally; creating a collection from one tab is complete without requiring an immediate second action.
- When the final member leaves, closes, moves, or fails to produce any restorable tab, remove the now-empty collection metadata and label immediately.
- Closing the final member follows existing tab-close/view teardown behavior; no replacement empty tab inherits the collection.

### 4.9 Pinned tabs

Pinning and collection membership are orthogonal states. Geode's current pin behavior protects a leaf from in-place navigation reuse; it does not create a leading pinned segment or imply a different visual order.

- Pinned tabs may be ungrouped or belong to any collection in their split.
- Pinning or unpinning never changes collection membership, collection state, or tab order.
- Drag/drop and collection commands treat pinned members like other members.
- When opening a file from a pinned active leaf causes Geode to create a new leaf rather than reuse the pinned one, the new tab starts ungrouped. It does not inherit the active tab's collection.
- Existing bulk-close protection for pinned tabs remains unchanged.

### 4.10 Close operations

The collection-label context menu provides **Close collection**, which closes all member tabs through the existing close lifecycle and removes the collection. It requires no additional confirmation beyond any confirmation already required by a member view.

Existing bulk actions use flattened visual order, where collapsed members still occupy their stored positions:

- **Close other tabs:** closes all other closable, unpinned tabs in that split, including hidden collection members. Normalize affected collections afterward.
- **Close tabs to the right:** closes all closable, unpinned tabs after the target tab in flattened order. If invoked on a collection label, close all closable tabs after the collection block; do not close its members.
- Closing one member does not close its collection unless collection normalization dissolves it.
- Pinned tabs remain protected exactly as they are today.
- If a member vetoes or fails close, it remains open and collection normalization uses the members that actually remain.

### 4.11 All tabs menu and commands

The split's **All tabs** menu renders collection headings in visual order, with members nested beneath them and collapsed state indicated. Ungrouped tabs remain top-level items at their visual positions. Selecting any member follows the hidden-member activation rule.

Add commands:

- **Tabs: Add active tab to new collection**
- **Tabs: Remove active tab from collection**
- **Tabs: Rename active tab's collection**
- **Tabs: Toggle active tab's collection collapsed**
- **Tabs: Move active tab to collection...**

Commands that require collection membership are unavailable when the active tab is ungrouped. Commands apply only to the active main-area tab, never sidebar panes.

### 4.12 Keyboard and accessibility

- Collection labels and disclosure controls are keyboard reachable and use native button semantics.
- The label exposes name, color name, member count, expanded/collapsed state, and whether it owns the active tab. Use `aria-expanded` and an explicit relationship to the member-tab container.
- Member tabs retain the established tab semantics. Hidden members are removed from sequential focus navigation while collapsed.
- Left/Right arrows move among visible tab-strip items; a collapsed collection counts as one item. Home/End move to the first/last visible item.
- Enter or Space on the disclosure toggles state. Enter on the label keeps collapse state unchanged and activates the collection's current member, or its first member if none is current. An explicit expand action is required to reveal hidden headers.
- Provide keyboard-accessible menu actions for every drag-only membership/order outcome. Reordering commands are **Move tab left/right**, **Move collection left/right**, and **Move active tab to collection...**.
- Drag previews and color are supplemented by text, shape, or placement. All palette combinations must meet the existing theme contrast target in light and dark modes.
- Reduced-motion preferences disable collection expand/collapse animation.
- Screen-reader announcements describe membership changes, for example, **Interview notes moved to Research, position 2 of 4**.

### 4.13 Mobile

Mobile is unchanged in Phase 1. Mobile does not show collection labels or collection commands and must not rewrite or discard collection metadata when it reads/saves other workspace state. A desktop-created collection restores unchanged on the next desktop launch.

### 4.14 Community themes

- Preserve existing `.workspace-tabs`, `.workspace-tab-header-container`, `.workspace-tab-header`, and active/pinned hooks.
- Add namespaced collection classes and CSS custom properties rather than changing the meaning of existing selectors.
- Theme-safe color tokens must derive from current theme variables and provide fallbacks.
- Labels must remain usable when a community theme changes tab height, typography, border radius, overflow, or active-tab styling.
- Geode's default theme owns minimum hit targets, focus rings, disclosure visibility, and overflow safety; community-theme cosmetics may override appearance but not remove accessible state indicators.
- Visual regression fixtures must cover the default light/dark themes plus at least two structurally different community themes already supported by the test harness.

## 5. Persistence and restore

### 5.1 Persistence model

Persist collection state in the per-vault `.geode/workspace.json` center-region tab node. The implementation design should use stable collection IDs scoped to a tab node, with:

- a split-local collection registry containing collection ID, name, semantic color token, and collapsed state; and
- an optional `collectionId` association on each canonical persisted leaf.

Leaf order remains the single canonical flattened tab order. Members of one collection must be contiguous. Collection block order derives from the first member/run in canonical leaf order; it is not stored as a second, potentially divergent block-order field. Collection records do not duplicate member order or view state. Sidebars do not gain collection fields.

The recommended architecture is a flat leaf order with split-local collection metadata, documented in an ADR before implementation. The schema change should be versioned as workspace layout v3 and migrated in memory before restore. Exact TypeScript shape remains an implementation/architecture decision, but it must preserve unknown additive fields where the existing writer does so.

### 5.2 Backward compatibility and normalization

- v1/v2 workspaces migrate with every leaf ungrouped and no collections.
- Missing collection fields mean no collections.
- A leaf referencing an unknown collection restores ungrouped.
- Duplicate collection IDs, non-contiguous membership, invalid colors, empty names, empty collections, and out-of-range order data are normalized deterministically without preventing workspace restore.
- Invalid color becomes gray; invalid/empty name becomes **New collection**.
- Non-contiguous members are gathered at the position of their first member while preserving their relative order. Unaffected tabs retain relative order.
- Empty persisted collections are removed during normalization; one-member collections remain valid.
- Saving after successful migration writes the current schema; migration is one-way, with the existing workspace backup/recovery mechanism responsible for rollback safety.

### 5.3 Missing files during restore

Phase 1 preserves Geode's current workspace policy: missing Markdown or Canvas files do not become durable tombstones or relinkable placeholders.

- Prune each missing file leaf during restore.
- Preserve the relative canonical order of every surviving leaf.
- Recompute each collection's contiguous surviving member run after pruning.
- Preserve a collection's ID, name, color, and collapsed state when at least one member survives, including when persistence filtering leaves exactly one member.
- Remove collection metadata only when zero members survive.
- Multiple missing members are pruned independently; unrelated tabs and collections retain relative order.
- Do not add **Locate file**, **Retry**, a missing-file view type, or durable missing-file state in this phase.

### 5.4 Active state on restore

- Restore and normalize collection metadata and surviving leaves before resolving the active index.
- If the persisted active member belongs to a collapsed collection, keep the collection collapsed, show its document, and apply active styling to the label. Restore alone does not expand it.
- If the persisted active member is missing, activate the nearest surviving leaf by the pre-pruning flattened order, preferring the next item and then the previous one.
- A zero-member collection removed during normalization cannot remain active; a one-member collection remains a collection and retains its collapse state.

## 6. Error and edge-state rules

- Failed rename/color persistence keeps the in-memory change for the session and surfaces the existing workspace-save error path; do not revert silently.
- A drag canceled with Escape or dropped outside a valid target makes no change.
- Closing or moving a tab while inline rename is open accepts the current valid name before applying the operation.
- Plugin-provided/deferred main-area views may join collections and preserve membership across provider absence, using their existing deferred placeholder behavior.
- Empty New tab views may join transiently but are omitted by current persistence. If filtering leaves one persisted/restorable member, the collection remains valid; only a zero-member collection is removed.
- Duplicate file tabs are independent leaves and may belong to different collections in different splits.
- Vault switching saves collections with the source vault and restores the destination vault's own state; no collection crosses vaults.

## 7. Explicitly out of scope

- Left-side/vertical main tabs, rail sizing, and the per-vault Top/Left setting (Phase 2).
- Any change to left/right sidebars or mobile UI.
- Collections spanning splits, nested collections, or collection folders in the vault.
- Dragging/copying a whole collection to another split.
- Syncing collection definitions independently of `.geode/workspace.json`.
- Shared/team collections, templates, rules, automatic grouping, smart groups, or grouping by folder/tag.
- Multi-select tabs.
- Collection-specific content views, dashboards, icons, emoji, or custom arbitrary colors.
- New analytics or telemetry.
- Public plugin API for creating/managing collections. Existing workspace lifecycle events may fire as normal; an API can be designed after the data model stabilizes.
- Changes to file paths, Markdown content, backlinks, bookmarks, or folders when grouping tabs.

## 8. Risks and mitigations

| Risk | Impact | Mitigation / validation |
|---|---|---|
| Active document appears orphaned when its collection collapses or hidden-member navigation changes content | User loses context | Keep collapse state stable, update active label/title description, and prototype-test All tabs plus next/previous navigation |
| Ambiguous boundary drops accidentally group/ungroup tabs | Unexpected organization changes | Explicit insertion preview and wider outside-edge ungrouped targets; usability task |
| Missing files change collection membership during restore | Unexpected layout change | Deterministically prune only missing leaves, retain surviving relative order/metadata, and test zero/one/many survivors |
| Community themes hide labels or state | Inaccessible/broken tab strip | Preserve DOM hooks, add namespaced hooks, visual matrix across themes |
| Bulk close has surprising effects on hidden members | Accidental tab closure | Menu labels/count previews where available; deterministic flattened-order rules |
| Persistence corruption blocks whole workspace | Severe launch failure | Versioned migration, deterministic tolerant normalization, recovery snapshot tests |
| Collection names/colors add too much horizontal pressure | Increased overflow | Compact label, count, truncation, existing scroll behavior; stress fixture with long names |

## 9. User stories and acceptance criteria

### Story 1: Create and identify a collection

As a knowledge worker, I want to group related open documents under a named color so that I can recognize my current workstream without changing vault structure.

Acceptance criteria:

- [ ] An eligible main tab can create a collection from its context menu and the command palette.
- [ ] Creation uses **New collection**, a deterministic palette color, and starts inline rename.
- [ ] A second eligible tab can join through drag/drop or **Add tab to collection**.
- [ ] Pinned main-area tabs may join collections without changing pin state; sidebar tabs cannot join.
- [ ] Names are trimmed, bounded, accessible in full, and need not be unique.

Definition of Done:

- [ ] Unit tests written for all new logic.
- [ ] E2E test covers the primary user-facing flow.
- [ ] User-facing doc page created or updated.
- [ ] Screenshots regenerated and committed for the UI change.
- [ ] TypeScript compiles clean.

### Story 2: Reorder tabs and collections predictably

As a user organizing a busy pane, I want drag/drop to make membership and order explicit so that I do not accidentally lose my arrangement.

Acceptance criteria:

- [ ] Users can reorder members, ungrouped tabs, and whole collection blocks.
- [ ] Drops onto/between members join a collection; outside-edge drops remain ungrouped.
- [ ] Every valid target previews final position and membership before drop.
- [ ] Canceled and invalid drops cause no mutation.
- [ ] Keyboard/menu alternatives cover membership and reordering outcomes.

Definition of Done:

- [ ] Unit tests written for all new logic.
- [ ] E2E test covers the primary user-facing flow.
- [ ] User-facing doc page created or updated.
- [ ] Screenshots regenerated and committed for the UI change.
- [ ] TypeScript compiles clean.

### Story 3: Collapse clutter without losing the active document

As a user focusing on one workstream, I want to collapse a collection while keeping my active document open so that I reduce header clutter without interrupting work.

Acceptance criteria:

- [ ] Collapsing hides member headers but never closes views or changes the active leaf.
- [ ] A collapsed collection owning the active member shows active state, count, and accessible active title.
- [ ] Selecting a hidden member through any supported activation route activates its content and label while keeping the collection collapsed.
- [ ] Collapse state survives relaunch.
- [ ] Reduced-motion and keyboard behavior meet section 4.12.

Definition of Done:

- [ ] Unit tests written for all new logic.
- [ ] E2E test covers the primary user-facing flow.
- [ ] User-facing doc page created or updated.
- [ ] Screenshots regenerated and committed for the UI change.
- [ ] TypeScript compiles clean.

### Story 4: Move a tab between splits safely

As a user rearranging my workspace, I want a tab moved to another split to become ungrouped so that collection scope remains predictable.

Acceptance criteria:

- [ ] Moving a member to any existing or new split removes membership.
- [ ] The destination tab is ungrouped at the indicated position and otherwise retains live view state.
- [ ] The source collection is removed only when no members remain; a one-member collection stays valid.
- [ ] Same-named destination collections do not capture the moved tab automatically.

Definition of Done:

- [ ] Unit tests written for all new logic.
- [ ] E2E test covers the primary user-facing flow.
- [ ] User-facing doc page created or updated.
- [ ] Screenshots regenerated and committed for the UI change.
- [ ] TypeScript compiles clean.

### Story 5: Trust collections after relaunch and file loss

As a user, I want surviving tab organization to restore deterministically when files are missing so that opening Geode does not unpredictably rearrange the rest of my workspace.

Acceptance criteria:

- [ ] Workspace persistence restores names, colors, order, membership, collapsed state, active state, and pinned state per vault.
- [ ] v1/v2 workspaces restore with tabs ungrouped and migrate without losing leaf state.
- [ ] Missing Markdown/Canvas leaves are pruned without tombstones while surviving leaves retain relative order.
- [ ] Collection metadata persists with one or more surviving members and is removed only with zero survivors.
- [ ] If the persisted active member is missing, the nearest survivor is selected, preferring next and then previous in flattened order.
- [ ] Malformed collection data is normalized deterministically without blocking workspace restore.

Definition of Done:

- [ ] Unit tests written for all new logic.
- [ ] E2E test covers the primary user-facing flow.
- [ ] User-facing doc page created or updated.
- [ ] Screenshots regenerated and committed for the UI change.
- [ ] TypeScript compiles clean.

### Story 6: Close tabs in a collection without surprises

As a user cleaning up a workspace, I want individual and bulk close actions to have deterministic collection behavior so that hidden tabs are not treated inconsistently.

Acceptance criteria:

- [ ] **Close collection** uses existing close lifecycle behavior for every member.
- [ ] Close-others and close-right operate on flattened stored order, including hidden members, while retaining pinned protections.
- [ ] Failed/vetoed closes leave those tabs open and normalization reflects actual survivors.
- [ ] Empty collections are removed and one-member collections remain valid according to section 4.8.

Definition of Done:

- [ ] Unit tests written for all new logic.
- [ ] E2E test covers the primary user-facing flow.
- [ ] User-facing doc page created or updated.
- [ ] Screenshots regenerated and committed for the UI change.
- [ ] TypeScript compiles clean.

## 10. Phase 1 approval checklist

Before implementation begins, confirm:

- [ ] Collapsed-active behavior is accepted after prototype review.
- [ ] Pinning is orthogonal to collection membership/order, and new leaves created because reuse is blocked start ungrouped.
- [ ] One-member collections remain valid; only empty collections are removed.
- [ ] Missing-file restore follows the existing prune policy with zero/one/many-survivor coverage.
- [ ] An ADR records the v3 flat-leaf-order and split-local collection-registry design before implementation.
- [ ] QA maps unit, E2E, accessibility, restore-corruption, and community-theme coverage from this specification.
