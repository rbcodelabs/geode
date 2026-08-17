# ADR 0003 — Staged in-process plugin crash resilience

**Status:** Accepted (Phase 0 and bounded Phase 1 vertical slice)
**Date:** 2026-08-17

## Context

Community plugins execute in Geode's renderer with Node integration, matching
Obsidian's trusted desktop plugin model. An ordinary plugin exception should not
take down unrelated plugins, while a renderer crash, hang, out-of-memory event,
or infinite loop cannot be safely isolated inside that same process.

## Decision

Geode keeps the compatible in-process model and adds two layers:

1. The main process records a bounded, machine-local crash journal under the
   Electron user-data directory. `render-process-gone` captures Chromium's
   reason and exit code plus the last reported enabled-plugin set. A renderer
   heartbeat detects a non-responsive event loop. One automatic reload starts
   in recovery mode with community plugins suppressed, preserving the vault's
   enabled-plugin configuration. A visible banner lets the user explicitly
   retry with plugins; a second automatic reload is prohibited to avoid loops.
2. `PluginManager` installs an error boundary before `onload`. Geode-owned
   command/check callbacks, registered DOM callbacks, plugin view factories and
   view lifecycle methods are wrapped for synchronous throws and rejected
   promises. `onload`/`onunload` failures are caught by the manager. The error is
   journaled, only the responsible plugin is unloaded, and a vault-local
   `.geode/plugin-quarantine.json` entry prevents it from auto-loading next
   launch. Settings shows the diagnostic and a reversible **Restore plugin**
   action. The user's desired enabled list remains unchanged.

The crash journal is diagnostic, not user content. Writes use a bounded JSON
array and atomic replacement. Failure to persist diagnostics never prevents
containment.

## Limits

- Infinite loops, OOM, native crashes, and code that terminates the renderer are
  recoverable but not containable or reliably attributable beyond the last
  enabled-plugin set.
- Existing `Events.on()` subscriptions and already-created interval/timeout
  callbacks do not carry plugin ownership metadata, so those callback boundaries
  are not yet individually attributable. Extending attribution there requires a
  compatible registration-context mechanism rather than changing EventRef or
  timer semantics in this slice.
- Separate utility processes and sandboxed plugin views remain out of scope.

## Consequences

Ordinary exceptions at owned boundaries disable one plugin without disrupting
the rest. Catastrophic renderer failures produce durable evidence and a
plugin-free recovery path. This materially improves diagnosis and recovery but
does not claim process isolation that the architecture does not provide.
