# ADR-0007: View capability actions

**Date:** 2026-08-29
**Status:** Accepted

**Extends:** [ADR-0006](0006-contextual-document-actions.md)

## Context

ADR-0006 introduced `ActionRegistry` as the canonical home for Geode-owned behavior, but its context, its menu specifications and its prose were framed entirely around files and documents: `AppActionContext` carried a `TFile`, a `TFolder`, a leaf and a `MarkdownView`. Views with no file at all, the Web Viewer and the Artifact view, were left outside the framework.

The cost showed up as a real bug. Cmd+R inside a Web Viewer tab reloaded the whole Geode renderer, destroying every open pane and every unsaved buffer, because Reload was not a Geode command: the accelerator came from Electron's stock `{ role: "viewMenu" }` and nothing in the renderer ever consumed the key. Alongside it, "bookmark this page" had drifted into two implementations that disagreed about the bookmark's title, which is precisely the failure mode ADR-0006 exists to prevent.

## Decision

Extend the action framework to non-document views through typed **capability interfaces** rather than by widening the document context.

- A capability is a narrow interface a view implements, e.g. `ReloadableView` (`reload()` plus a `reloadLabel`). It says what a view can do, not what it is.
- `AppActionContext` gains one optional field per capability. An action gates on the field: `isAvailable: (c) => !!c.reloadable`.
- **Capabilities are resolved with `instanceof` against Geode's own view classes, never structurally.** A `typeof view.reload === "function"` guard would match an arbitrary plugin view and bind a global hotkey to untrusted third-party code.
- Every dynamic `label`, `icon` and `checked` callback must be **total**. `ActionRegistry.resolve()` evaluates presentation before availability and returns them together, so a scoped action is still asked for its label in every other context. One non-total callback takes down the command palette and every context menu.
- Full-application reload stays reachable from the View menu, spelled out with no `role` and no accelerator, so it cannot shadow a Geode command.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Strip the menu accelerator only | One-line fix | Leaves Reload unreachable by keyboard and leaves the duplicated bookmark logic in place |
| Widen `AppActionContext` with concrete view types | No new concepts | Every new view type edits the shared context and every action; couples actions to classes rather than behavior |
| Structural capability detection | No registration step | Matches untrusted plugin views; binds global hotkeys to third-party code |
| Typed capability interfaces resolved by `instanceof` | Behavior-shaped, extensible, closed to plugin views | Requires an explicit `instanceof` list to maintain |

## Consequences

Actions are no longer document-only. A view opts into a keyboard shortcut, a toolbar button, a tab context-menu entry and a "More options" entry by implementing one interface, and all four surfaces then share a single implementation.

Publishing `Mod+R` also makes the main-process guest bridge swallow Cmd+R inside every `<webview>`, including canvas web-preview cards that have no reload path. There it is a silent no-op, which is strictly better than the whole-app reload it used to trigger.

## Risks

- The `instanceof` list in `App.viewActionContext` must be extended whenever a new Geode view gains a capability. Forgetting it fails safe: the action is simply unavailable.
- Capability interfaces are not a plugin extension point. Plugin-contributed capabilities remain future work, and deliberately so, given the hotkey-binding risk above.
- Every new dynamic presentation callback is a chance to reintroduce the non-total-label crash. The contract is stated on `ActionRegistry.resolve()` and pinned by tests in `tests/unit/actions.test.ts`.
