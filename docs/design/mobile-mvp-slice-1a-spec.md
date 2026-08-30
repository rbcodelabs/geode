# Spec: Geode Mobile MVP — Slice 1A Adaptive Daily Workspace

**Status:** Approved by the 2026-08-28 full-featured mobile MVP plan and
[ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md).

**Approach:** Reuse the existing Workspace, views, editor, and command model while
adding an adaptive presentation controller and mobile navigation surfaces. Phone
sidebars become modal drawers around a single main pane; tablet widths retain docked
navigation and may expose the existing split model.

## Files affected

- `src/renderer/app.ts` — mobile navigation controls and capability-aware actions
- `src/renderer/workspace.ts` — adaptive drawer state without forking leaf/view models
- `src/renderer/mobile.ts` — mobile lifecycle/viewport bootstrap as needed
- `styles/app.css` — compact/regular layouts, safe areas, touch targets, keyboard-safe sizing
- `tests/mobile/` and `playwright.mobile.config.ts` — iPhone/iPad daily-core journeys
- User-facing mobile documentation if behavior warrants it

## Key decisions

- Compact presentation is selected by container/viewport width, not user-agent strings.
- A phone shows one main tab group; left/right sidebars are full-height overlay drawers.
- Mobile navigation exposes files, search, commands/quick switcher, create note, and settings
  without requiring hover, right-click, or a desktop ribbon.
- A drawer closes after its navigation action succeeds and can be dismissed with Escape,
  backdrop tap, or the explicit close control.
- Tablet layouts dock the left sidebar and retain a useful editor width; the right sidebar
  is available without destroying its leaf state.
- Primary controls and resize/drag affordances used on touch are at least 44 CSS pixels.
- Safe-area and dynamic viewport units protect controls from notches, home indicators, and
  software-keyboard viewport changes.
- Desktop markup/behavior remains intact when `body.is-mobile` is absent.

## Riskiest assumptions

1. Existing sidebar/leaf DOM can be adapted without forking Workspace state or breaking
   plugin-facing view identity.
2. The current desktop-first command/file actions expose enough reusable entry points for a
   discoverable phone navigation surface.

## Out of scope

- Native Capacitor project generation, Swift vault access, File Provider bookmarks, signing,
  simulator/device lifecycle evidence, and App Store packaging.
- Touch redesign of Graph, Canvas, and Bases; those are Slice 2.
- Mobile plugin execution, native Web Viewer, sync conflicts, and Claude Threads execution.

## Done when

- At an iPhone viewport, the editor occupies the main canvas and both sidebars operate as
  accessible overlay drawers with a backdrop and explicit close paths.
- A user can open/create/edit a note, search/switch files, open commands, and reach settings
  using visible touch controls; edited bytes survive reload through the Slice 0 proof host.
- At an iPad viewport, navigation is docked or otherwise persistent without reducing the
  editor to phone dimensions, and orientation/width changes preserve the open file and text.
- Primary touch controls meet the 44px target and safe-area CSS is present.
- Mobile Playwright covers phone and tablet viewport flows with zero unexpected console/page
  errors and checked screenshots for the core states.
- Typecheck, all unit tests, mobile build/E2E, full build, parity, and Electron E2E remain green.
