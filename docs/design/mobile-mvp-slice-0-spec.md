# Spec: Geode Mobile MVP — Slice 0 Host Boundary Proof

**Status:** Approved by the 2026-08-28 mobile MVP coding-plan approval.

**Approach:** Preserve Geode's browser-built renderer and inject a capability-based
`HostServices` boundary, initially backed by the existing Electron preload and a
deterministic browser/mobile fake host. Scaffold Capacitor only after the shared
renderer boots without direct Electron assumptions.

**Architecture:** [ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md)

## Files affected

- `src/renderer/host/contracts.ts` — portable host service contracts and capabilities
- `src/renderer/host/electron-host.ts` — adapter over the existing preload API
- `src/renderer/host/browser-host.ts` — deterministic browser/mobile development host
- `src/renderer/host/index.ts` — bootstrap selection and injection
- `src/renderer/types.ts` — renderer global typing decoupled from the preload type
- `src/renderer/app.ts` and portable renderer call sites — consume injected services
- `src/main/preload.ts` — remains the desktop transport and compatibility surface
- `esbuild.config.mjs` and mobile HTML/build inputs — separate mobile/browser bundle
- `tests/unit/host/` — contract, capability, and adapter tests
- `tests/e2e/` — desktop regression and mobile-viewport fake-host boot coverage
- `docs/adr/0007-mobile-runtime-and-platform-boundary.md` — durable decision record

Exact call-site migration may be split across follow-up commits; no desktop behavior is
removed merely to complete the seam.

## Key decisions

- Feature code depends on responsibility-specific services, not one optional mega-object.
- Capabilities are an immutable startup snapshot; unsupported actions are gated explicitly.
- `window.geode` remains available on Electron for compatibility, but is not the portable
  renderer architecture.
- Mobile must never masquerade as a desktop `FileSystemAdapter` or Node runtime.
- Vault content remains authoritative; indexes and mobile workspace state are device-local,
  derived state.
- The first native vault implementation will use a small Swift-backed Capacitor plugin;
  stock Capacitor Filesystem is insufficient for security-scoped external vault folders.

## Riskiest assumptions

1. The mature renderer can boot and edit through the injected boundary without pervasive
   Electron forks.
2. CodeMirror, startup indexing, and workspace interaction remain usable in WKWebView under
   iOS memory, lifecycle, and software-keyboard constraints.

## Out of scope for Slice 0

- Final File Provider support, mobile plugin compatibility claims, native child-WKWebView,
  App Store release, and production sync.
- Pretending the current Node/subprocess-based Claude Threads plugin runs on iOS. A separate
  product/security choice will select paired-desktop or authenticated remote execution.
- Pop-outs, Chrome cookie import, Electron artifacts, and desktop process diagnostics.

## Done when

- Existing Electron startup and behavior run through the adapter with no regression.
- The portable renderer bundle has no Electron import and boots with a deterministic fake host.
- A managed-vault note can be listed, read, edited, persisted, and restored through the shared
  contracts in automated tests.
- Capability tests prove desktop-only actions are unavailable rather than failing at runtime.
- `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`, `npm run build`, and
  `npm run parity:check` pass.
- Native iOS boot, persistence, lifecycle, and keyboard checks pass on an iPhone and iPad
  simulator/device once a full Xcode 26+ toolchain is available.
