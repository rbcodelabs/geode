# Spec: Geode Mobile MVP — Slice 1C Native Managed Vault

**Status:** Approved by [ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md).

**Approach:** Replace the WKWebView/localStorage proof filesystem with a first-party
Capacitor Swift plugin backed by an application-container Documents vault. A
`CapacitorHostServices` adapter implements the existing portable contracts while the browser
fake remains deterministic for Chromium tests.

## Files affected

- `ios/App/App/` — first-party Swift vault plugin, registration, privacy manifest, tests/probes
- `src/renderer/host/capacitor-host.ts` — native implementation of registry/files/runtime services
- `src/renderer/mobile.ts` — select Capacitor host on native and browser proof host on web
- `src/renderer/host/contracts.ts` — only additive result/error types proven necessary
- `tests/unit/host/`, `tests/mobile/` — adapter, validation, and browser regression coverage
- `README.md` — managed-vault location, proof/storage distinction, native build/test procedure

## Required managed-vault semantics

- Create/open a stable default vault below the application Documents container.
- List recursively with relative normalized paths and authoritative type, size, creation time,
  and modification time.
- UTF-8 text read/write, binary read, mkdir, exists, recursive folder rename/trash, and file
  rename/trash.
- Reject absolute, traversal, dot-segment, NUL, drive/UNC, symlink escape, and destination
  collision paths in Swift even if TypeScript validation already ran.
- Writes use a temporary sibling and coordinated atomic replacement; acknowledgement occurs
  only after bytes are durable enough for immediate terminate/relaunch verification.
- App-originated mutations echo the caller's mutation id so the shared Vault suppresses only
  its own echo. External/reconciliation events remain uncorrelated.
- Trash is recoverable inside an app-owned trash area and excluded from normal vault listing.
- Stable, coded errors distinguish invalid path, not found, collision, unavailable storage,
  and I/O failure; raw absolute container paths are not exposed to renderer/plugins.
- Mobile `vault.adapter` remains `DataAdapter`, never `FileSystemAdapter`.

## Key decisions

- The managed vault is the safety baseline; File Provider/security-scoped folders follow in
  Slice 5 and are not emulated here.
- Portable vault settings may remain in existing device storage during this slice; note bytes
  must be native files.
- Add the Apple privacy-manifest reason required by any file timestamp API used.
- The native bridge may batch list results but must not pass unbounded binary data as text
  without an explicit supported-size/error policy.

## Riskiest assumptions

1. Capacitor's JavaScript/Swift bridge can move representative note and attachment payloads
   without unacceptable latency or memory pressure.
2. Atomic replacement plus app lifecycle callbacks is sufficient to prevent acknowledged
   managed-vault writes from being lost on immediate termination.

## Out of scope

- Security-scoped File Provider folders, iCloud two-device coordination, and conflict copies.
- Background indexing worker, native Web Viewer, mobile plugins, sync, and Threads execution.

## Done when

- Native iPhone and iPad builds use `CapacitorHostServices`, not the browser proof filesystem.
- Real native journeys create, edit, rename, reopen, and trash notes/folders and round-trip one
  binary attachment; terminate/relaunch preserves acknowledged bytes.
- Negative native probes prove path escape and collision rejection without source mutation.
- Managed vault files are visible in the app Documents location and `.geode-trash` is excluded.
- DEBUG smoke evidence reports adapter kind, vault identity, file bytes, and lifecycle result.
- Typecheck, unit tests, mobile Chromium, native compile/journeys, full build, parity, and Electron
  E2E remain green.
