# Editor-aware command dispatch

**Date:** 2026-09-01
**Status:** Accepted — the documented Command contract is approved scope for this delivery

## Problem

Geode's command registry only dispatches global `callback` and `checkCallback` handlers. Hosted plugins cannot register editor-only commands or receive the actual active Markdown editor and view through every existing invocation path.

## Constraints and non-goals

- Keep command-palette, hotkey, guest-hotkey, and programmatic call sites converged on `CommandRegistry`.
- Preserve existing global callback behavior, hotkey ownership/overrides, plugin cleanup, and crash attribution.
- Use only the active leaf's live/source `MarkdownView`; reading mode and non-Markdown leaves have no editor command context.
- Do not change `Workspace.activeEditor`, `MarkdownView`, or files touched by open PR #153.
- Do not add dependencies or build the full Obsidian `Editor` abstraction in this bounded change. Geode currently exposes the raw CM6 `EditorView`; that is an explicit partial-parity bridge.

## Options considered

| Approach | Advantages | Tradeoffs |
|---|---|---|
| Inject a lazy editor-context provider into `CommandRegistry` | One testable policy for every invocation path; no registry-to-App cycle | Adds one small internal dependency to the registry |
| Resolve App/workspace directly inside the registry | Fewer constructor arguments | Couples the registry to renderer classes and risks import cycles |
| Pass context separately from every call site | Registry remains context-free | Duplicates policy and lets palette/hotkey/programmatic behavior drift |
| Build a complete Obsidian `Editor` adapter now | True editor-object compatibility | A separate, much larger public API change with roughly thirty methods |

## Decision

Inject an optional lazy provider that returns the editing `MarkdownView` and its non-null editor for the current invocation source. Host-document and programmatic dispatch use the active leaf. While a guest hotkey is being dispatched, the provider uses the guest-owning leaf so a stale active Markdown leaf cannot receive a command typed in a Web Viewer or Canvas guest.

`Plugin.addCommand` validates that exactly one of `callback`, `checkCallback`, `editorCallback`, or `editorCheckCallback` is defined before the command reaches the registry or cleanup registration. Mixed and zero-style command shapes are rejected with a `TypeError`.

For `editorCheckCallback`, `checking=true` must return `true` before execution calls the same handler with `checking=false`. The existing global `checkCallback` availability behavior remains unchanged in this delivery. Plugin guards use the established `command:<id>` execution and `command-check:<id>` availability boundaries for synchronous throws and rejected promises.

The context is the active `MarkdownView`, not a synthesized `MarkdownFileInfo`. The editor argument is the exact live CM6 `EditorView` already exposed by that view. This proves routing and identity but does not claim the documented CM5-style Obsidian `Editor` method surface.

## Riskiest assumption

Reading mode must be treated as unavailable even though the `MarkdownView` retains an underlying editor instance; tests must distinguish live/source from reading mode and non-Markdown leaves.

## Done when

- RED/GREEN tests cover both editor callback variants, availability and execution phases, missing/reading/non-Markdown context, all registry invocation paths, exact-one-style validation, unload cleanup, and synchronous/async plugin crash attribution.
- An Electron plugin fixture proves the callbacks receive the active leaf's real live editor/view and are hidden/non-dispatchable outside editing context.
- Focused and full unit, relevant Electron/plugin, mobile, typecheck, build, parity, and diff gates pass.
- API docs and parity evidence describe only the observed routing subset and retain the full-Editor limitation.
