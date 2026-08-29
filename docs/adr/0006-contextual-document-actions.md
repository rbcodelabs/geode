# ADR-0006: Contextual document actions

**Date:** 2026-08-28
**Status:** Accepted

## Context

Geode's file operations were implemented independently by the file explorer, Markdown title, tab header, toolbar, and command palette. Equivalent operations consequently had different validation and availability, and the tab context menu exposed only Pin/Unpin. Obsidian presents a broader shared file menu from the tab header, editor More options control, and file explorer, while commands operate on the active document.

The public `CommandRegistry` is part of Geode's Obsidian compatibility surface. Changing its shape to carry arbitrary contextual targets would break that contract. Context menus also cannot safely use active-document commands because a user may right-click a background tab.

## Decision

Add an internal typed `ActionRegistry` as the canonical home for Geode-owned behavior, availability, dynamic labels, checked state, and warning state.

- `ActionDefinition`s own behavior and contextual state.
- `MenuSection` specifications own the ordering and grouping of each surface.
- Menus supply their explicit clicked resource or tab context.
- Command adapters resolve the active context at availability and execution time.
- The public Obsidian-compatible `CommandRegistry` remains unchanged.
- Tab bulk-close actions snapshot targets, remain within the clicked tab's group, and preserve pinned siblings. Explicit Close may close a pinned target.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Add callbacks directly to each menu | Smallest immediate diff | Continues behavior drift and cannot safely unify commands |
| Expand the public command registry with context | One registry | Breaks the Obsidian-compatible public contract and still conflates active and clicked targets |
| Internal contextual actions with command adapters | Shared behavior, explicit targets, public API stability | Adds an internal abstraction and requires migrating existing surfaces |

## Consequences

Adding another menu or command becomes composition rather than reimplementation. Background-tab targeting is explicit, and rename validation is consistent. Internal actions are not plugin extension points; plugin-contributed contextual actions remain future work. Menu specifications may intentionally differ by source while resolving the same definitions.

## Risks

- The initial synchronous availability model may be insufficient for remotely resolved or permission-dependent operations.
- A UI surface that bypasses the registry can reintroduce drift; new Geode-owned file operations should therefore be actions first.
- Future pop-out windows will require extending tab context beyond one renderer workspace.
