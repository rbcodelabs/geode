# ADR-0015: Host-Orchestrated, Plugin-Provided Vault Sync

**Date:** 2026-09-06
**Status:** Accepted

## Context

Geode needs full-vault synchronization without coupling the product to a storage vendor. Synchronization can delete or overwrite user-authored files, so provider plugins must not reinvent reconciliation, conflict, and recovery policy independently. Ordinary files remain usable offline and outside Geode.

## Decision

Geode owns synchronization orchestration and one plugin-provided transport may be active for a vault. The host scans local files, evaluates scope, persists a device-local baseline and write-ahead operation journal, requires a first-sync preview, enforces conditional remote writes, moves deletions to recoverable trash, and preserves divergent remote bytes as conflict siblings. Providers own authentication and remote byte/list/create/update/move/trash operations.

The public contract is Geode-original and exported by `require("geode")`. `Plugin.registerSyncProvider()` binds registration to plugin ownership; unload aborts active work and revokes the provider. Multiple transports may be installed, but switching requires an explicit disconnect.

Device state lives under host application data, never in the vault. Electron secrets use `safeStorage`; unsupported browser/mobile proof hosts report secure storage unavailable. Capacitor retains the contract boundary without claiming Keychain support until native implementation exists.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Host orchestration, plugin transports | One safety policy; provider-agnostic; testable offline | Larger core API and durable-state responsibility |
| Plugin-owned orchestration | Small core change | Duplicated destructive logic and inconsistent conflicts |
| Remote-backed virtual vault | Remote operations map directly | Breaks local-first use and depends on provider startup |

## Consequences

- Provider authors implement a narrow capability-checked byte transport.
- Geode refuses transports lacking conditional writes, binary fidelity, authoritative snapshots/deltas, or recoverable trash.
- Initial synchronization never mutates either side before a matching preview is approved.
- Partial, cancelled, or unavailable scans never advance the cursor or imply deletion.
- V1 uses `ArrayBuffer`; streaming, CRDT merging, core E2EE, background mobile sync, and version browsing are deferred.

## Risks

- Providers must honor `expectedRevision` and stable `operationKey` values; services unable to do so cannot advertise the required capabilities.
- File identity must handle case, Unicode, and rename ambiguity conservatively. Ambiguity becomes a conflict, never an overwrite.
- Native Keychain support is required before credentialed providers can run on iOS.
