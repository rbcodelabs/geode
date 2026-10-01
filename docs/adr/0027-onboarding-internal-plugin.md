# ADR-0027: Onboarding internal plugin and step registry

**Date:** 2026-09-30
**Status:** Accepted

Numbering note: `docs/adr/` already has duplicate numbers (0003, 0004, 0007,
0015, 0016, 0022). 0027 was the next number unused by any file.

## Context

Geode needs a getting-started checklist with a completeness score, and plugins
installed in a vault should be able to recommend their own setup steps. The
Mermaid internal plugin established the pattern for features Geode ships but
builds on the public plugin API (`src/renderer/plugin.ts`), so this follows it.

## Decision

`onboarding` is an internal plugin (`src/renderer/internal-plugins/onboarding/`),
instantiated by `App` next to Mermaid and unloaded on vault reopen and close.

**Registry.** `OnboardingRegistry` is a pure, DOM-free store. A step is
`{ id, ownerId, title, description?, group?, order?, optional?, commandId?, check?, docsUrl? }`.
`id` must be `"<ownerId>:<stepId>"`. `registerStep(step)` returns a disposer and
rejects a duplicate id with `OnboardingRegistryError`. `unregisterOwner(id)`
removes all of an owner's runtime steps.

**Two registration styles, merged.**
- Runtime: `app.onboarding.registerStep(...)` or
  `app.plugins.getPlugin("onboarding")?.registerStep(...)`.
- Static: an optional `onboarding: { steps: [...] }` in `manifest.json`, parsed
  leniently by `parseOnboardingSection` (invalid entries are skipped with a
  `console.warn`; the manifest never becomes invalid). Static steps are
  namespaced `<pluginId>:<id>` and shown even while the plugin is disabled
  ("Plugin disabled. Enable it to continue."). A runtime step with the same id
  overrides the static one field by field, which is how a plugin adds a `check`.

**Load order.** `App` constructs and loads the onboarding plugin and awaits
`ready` (persisted state loaded, view registered) before `new PluginManager` /
`initialize()`. So `app.onboarding` exists before any vault plugin's `onload()`;
no buffering is needed. The registry is also created in the constructor, so a
registration made before `onload()` is retained. `app.plugins.getPlugin` falls
back to `App.getInternalPlugin(id)` because `PluginManager.getPlugin` only knows
vault plugins.

**Owner unload.** Plugins should `this.register(disposer)`. As a safety net,
`PluginManager` gained `onChange(listener)` (fired after enable, disable and
rescan); on each event the plugin re-syncs static steps and calls
`unregisterOwner` for every installed-but-disabled plugin.

**State.** Stored with the plugin's own `loadData`/`saveData`
(`.geode/plugins/onboarding/data.json`, therefore per vault):
`{ version: 1, completed: { [stepId]: { completedAt, source: "manual" | "auto" } }, dismissedSteps, dismissedOnboarding }`.
Loading is tolerant of malformed data. `check()` runs on open and on
"Re-run checks"; a throw, rejection, non-`true` value or 5s timeout is treated
as incomplete and never propagates. A passing check auto-completes the step,
and that completion is sticky (milestones such as "open the graph" are
transient conditions). Steps with a `check` cannot be toggled by hand.

**Score.** `computeCompleteness` is a pure function returning
`{ completed, total, percent, byGroup, byOwner, optional }`. Optional steps and
steps the user skipped (while incomplete) are excluded from the required total.
An empty total is 100%.

**UI.** Side-pane view `onboarding-checklist` (docked right, lazily imported to
avoid the `api/obsidian` init cycle noted in `app.ts`), commands
`onboarding:open`, `onboarding:rerun-checks`, `onboarding:reset`. No ribbon icon.

**Auto-open on launch.** `App` queues `autoOpenIfOutstanding()` via
`workspace.onLayoutReady`, so it runs after layout restore. It runs the checks
first, then docks the pane in the right sidebar (`active: false`, sidebar reveal
only, so the editor keeps focus) if a required step is incomplete and not
skipped. It does nothing if onboarding is dismissed, the pane is already open
(restored layout), or the app is headless. Headless is read from
`window.geode.isHeadless`, which the preload derives from `GEODE_HEADLESS=1` /
`--headless` (the same test `main.ts` uses), so existing e2e specs are
unaffected.

## Consequences

- `PluginManifest` gains an optional `onboarding` field; `PluginManager` gains
  `onChange`. Both are additive.
- Completeness can drop when a plugin with required static steps is installed.
  Steps can be skipped, or declared `optional`, to avoid penalising users.
- Step `title`/`description` come from third-party plugins and are rendered with
  `textContent`; `docsUrl` is opened only when it is an `http(s)` URL.
- The first-party `commandId`s are asserted against `app.ts` by a unit test.
