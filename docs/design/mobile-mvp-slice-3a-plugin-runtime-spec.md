# Spec: Geode Mobile MVP — Slice 3A Plugin Runtime and Admission

**Status:** Approved implementation spec under the user-approved mobile program and
[ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md).

**Outcome:** Mobile-compatible plugins can be installed, enabled, restarted, updated, disabled,
and recovered safely, while desktop-only or Node-dependent plugins are rejected before unsupported
code executes. Mobile never pretends to provide Node, Electron, or a `FileSystemAdapter`.

## Admission policy

- `isDesktopOnly: true` is blocked before reading/evaluating the entry module.
- A plugin explicitly declaring mobile support may load through the browser-only module resolver.
- An unknown community plugin is labelled **Unknown** and requires explicit mobile opt-in during the
  MVP. It is not silently enabled because it happened to install on desktop.
- Static or dynamic attempts to import Node built-ins, `electron`, `child_process`, native addons,
  or an unknown CommonJS specifier fail with a stable diagnostic naming the unsupported module.
- `FileSystemAdapter` remains a real desktop-only class. Mobile exposes the shared public Vault API
  through `DataAdapter` and no absolute base path.
- A plugin that throws during mobile startup is quarantined before the next boot. Safe/restricted mode
  can start the vault without evaluating it, and the user can inspect, retry, or disable it.

## Supported mobile surface

- Obsidian-compatible browser APIs already implemented by Geode, DOM APIs, shared CodeMirror/Lezer
  modules, commands, settings, CSS/themes, views, and scoped Vault/DataAdapter access.
- Mobile-safe network request and Keychain-backed secret services are capability-gated first-party
  host services. Secrets never enter vault JSON, plugin data, localStorage, logs, or diagnostics.
- Status-bar items remain logical registrations but do not render on compact phone layouts.
- Pop-outs, multiple windows, desktop process APIs, Electron WebViews, shell/process access, and raw
  filesystem paths are unavailable with explicit diagnostics.

## Lifecycle and state

- Install/update is staged and atomic. A failed validation or startup leaves the last known-good
  plugin files and enabled state recoverable.
- Enable commits only after entry evaluation and `onload()` succeed. Disable/unload removes commands,
  views, styles, events, timers registered through the public API, and secret/request listeners.
- Background/foreground does not duplicate registrations. Vault switch awaits plugin unload before
  the host root changes, using the approved transactional switch contract.
- Plugin settings/CSS may sync as ordinary portable vault state; quarantine/crash counters and secret
  references are exact-vault/device state.

## Compatibility presentation

- Community/plugin settings show **Mobile compatible**, **Desktop only**, or **Unknown**, plus the
  reason/source of the classification.
- Blocked startup/install errors name the unsupported capability/module without exposing absolute
  paths or secrets.
- Quarantined plugins show a recovery action; one plugin failure does not block vault read/edit/save,
  safe mode, or subsequent startup.
- Mobile-only controls are code-gated so desktop plugin/settings DOM contracts do not change.

## Test fixtures

At minimum:

1. pure DOM/view + command plugin;
2. CodeMirror extension using supported shared modules;
3. network request + Keychain secret plugin with redacted diagnostics;
4. CSS/theme/settings plugin;
5. explicit desktop-only manifest whose entry module contains a tripwire and is never read;
6. accidental static and dynamic Node imports whose diagnostics name the module;
7. startup-throwing plugin proving quarantine, safe-mode recovery, retry, and disable;
8. malicious path/adapter plugin proving scope isolation and honest `DataAdapter` identity.

## Test-first coverage

- Pure resolver/admission tests for every classification and supported/unsupported module, including
  nested/dynamic requires, malformed manifests, version/platform constraints, and unknown opt-in.
- Lifecycle tests for install, enable, restart, update, failed update rollback, disable/unload,
  duplicate registration prevention, vault switch, background/foreground, and quarantine expiry.
- Real mobile Chromium journeys on phone/tablet for compatibility labels, explicit opt-in, supported
  fixture operation, desktop-only pre-evaluation block, Node diagnostic, crash recovery, and safe
  vault editing after plugin failure.
- Native simulator tests/probes for network/Keychain only when those services are introduced; no
  browser fake is claimed as evidence that iOS secrets are protected.
- Existing Electron plugin/API/parity suites remain authoritative desktop regressions.

## Security invariants

1. Admission runs before entry-module read/evaluation for an explicitly blocked plugin.
2. Mobile plugin code cannot obtain a raw provider URL, bookmark, absolute vault path, Node module,
   Electron object, subprocess, or sibling-vault access.
3. Secrets remain Keychain-backed and are redacted from plugin data, errors, logs, and recovery state.
4. A failed install/update/startup cannot replace the last known-good plugin or prevent safe vault boot.
5. Unload/restart/vault switch does not duplicate plugin commands, views, events, or writers.

## Done when

- The full fixture suite passes enable/use/restart/update/disable and failure recovery on phone/tablet
  mobile profiles with exact registrations and vault bytes.
- Unsupported plugins are blocked before their tripwire code executes and show actionable diagnostics.
- One reviewed real browser-only community plugin completes the same lifecycle before release, with
  its version and compatibility evidence recorded.
- Native request/secret services have simulator evidence if included; physical Keychain/data-
  protection validation remains a release-candidate gate.
- Typecheck, unit/integration, mobile Chromium, native relevant tests, full build, parity, Electron
  plugin/API E2E, and diff hygiene pass.

## Explicit later gates

- Selection and validation of the real community plugin.
- Physical-device Keychain/data-protection behavior.
- Mobile Threads uses its separate `ThreadExecutionProvider`; it is not admitted as a normal local
  Node plugin merely because the generic mobile plugin runtime exists.
