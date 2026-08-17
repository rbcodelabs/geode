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
array and atomic replacement. Geode also starts Electron Crashpad locally (no
upload), keeps a bounded structured log and in-memory buffers for lifecycle,
plugin-state, navigation, and renderer-console breadcrumbs, and correlates a
renderer incident with newly observed `.dmp` filenames. Incident records include
app/runtime versions, platform, uptime, recovery state, recent process metrics,
and a unique incident ID. Log files rotate at 1 MB (three files total), the
crash journal retains 50 entries, and only the 10 newest minidumps are retained.
Failure to persist any diagnostic never prevents containment.

Diagnostics live under Electron's user-data and crash-dumps directories. The
application menu's **Help → Export Diagnostics…** action creates an allowlisted
directory bundle at a destination the user chooses. The exporter copies only a
sanitized manifest, crash journal, rotated diagnostic logs, and safe-named
`.dmp` files; it does not intentionally read or copy `geode.json`, vault files,
note/plugin source, environment variables, prompts, or IPC payloads. Console
strings and metadata are truncated and redact home-directory paths and common
secret assignments before being stored; plugin IDs and event names are recorded,
not plugin data. These controls reduce exposure but do not make an export safe
to share without inspection: a plugin can print arbitrary text to the console,
and a native minidump can contain fragments of process memory, including vault
content or credentials.

## Limits

- Infinite loops, OOM, native crashes, and code that terminates the renderer are
  recoverable but not containable or reliably attributable beyond the last
  enabled-plugin set.
- Crashpad minidumps are native evidence, not guaranteed JavaScript stacks.
  Useful native symbolication can still require exact Electron/Geode symbols,
  and a hard crash may occur without emitting a final breadcrumb.
- Redaction is intentionally conservative but cannot understand arbitrary text
  a third-party plugin chooses to print. Plugins should not log note content or
  credentials; users can inspect the local export before sharing it.
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
