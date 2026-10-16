# ADR-0030: Core iCloud Sync Over a Native Container Bridge (Electron + iOS)

**Date:** 2026-10-15
**Status:** Proposed
**Supersedes (in part):** [ADR-0029](0029-icloud-drive-sync-provider-plugin.md) (placement and platform scope only; its provider semantics are kept)

## Context

[ADR-0015](0015-plugin-provided-vault-sync.md) made sync a host-orchestrated engine with pluggable transports. [ADR-0029](0029-icloud-drive-sync-provider-plugin.md) (PR #381) shipped an iCloud transport as a community plugin, `packages/geode-icloud-sync`: plain Node `fs` plus `brctl`, macOS only, remote root `~/Library/Mobile Documents/com~apple~CloudDocs/Geode/<remote folder name>/`. Its provider id is `icloud`.

The product decision (user, 2026-10-15) is that iCloud sync becomes a **core plugin** (ships in the app, toggled under Settings -> Core plugins) and **uses the native bridge**, so one provider serves Electron and iOS (Capacitor).

Facts established from the repository (not assumptions):

- Core plugins are classes extending `Plugin`, constructed in `src/renderer/app.ts`, gated by an app setting (`slidesEnabled`) via `syncSlidesPlugin()`, with UI hand-written in `renderCorePluginsTab`. `app.ts` is shared by `mobile.ts`, so a core plugin runs on iOS too.
- A host-bridge precedent for exactly this shape exists: the built-in hub provider uses optional `HostServices.hubSync` (Electron: `ipcMain.handle("hub-sync")` in `src/main/hub-sync-ipc.ts`, preload `hubSync.call/abort`, `electron-host.ts` passthrough, `legacy-facade.ts`), and on mobile a different transport behind the same provider.
- `SyncService.register()` throws `Sync provider already registered` on a duplicate id, so core and community cannot both register `icloud`.
- iOS today has one custom Capacitor plugin, `GeodeManagedVaultPlugin` (`jsName GeodeManagedVault`, registered via `bridge?.registerPluginInstance` in `GeodeBridgeViewController`), plus Keychain and sync-private stores. Vaults live in the app sandbox or in a user-picked folder via security-scoped bookmark. It already uses `NSFileCoordinator` and already splits `.name.icloud` stubs (`splitICloudPlaceholders`).
- **There is no iOS entitlements file, no iCloud capability, and no `NSUbiquitousContainers` today.** Bundle id is `com.rbcodelabs.geode` (iOS and the Electron `appId` agree), Apple team `6M8F464WCQ`, iOS deployment target 15.0.
- The macOS build is Developer ID signed, hardened runtime, notarized (`build/entitlements.mac.plist`: `allow-jit`, `audio-input` only; no provisioning profile).
- iOS CI is `ios-testflight.yml` (unsigned archive, then export with cloud-managed signing via an App Store Connect API key, `-allowProvisioningUpdates`). `verify.yml` has no Xcode/Swift test job; iOS XCTests run only in the local `scripts/ios-mvp-acceptance.sh`.

### The core problem

iOS cannot read `~/Library/Mobile Documents/com~apple~CloudDocs/Geode`: an iOS app sees only its own ubiquity container (or a user-picked scoped URL). So the "remote" must move from "a folder in iCloud Drive" to "a folder in Geode's own iCloud container", which both platforms can reach, and the iOS side must use `NSFileCoordinator`/ubiquity APIs rather than Node-style `fs`.

### Hard constraints

- One TypeScript provider; platform differences live behind a bridge. No second copy of conflict/idempotency/marker policy in Swift.
- Keep ADR-0029 semantics so existing remotes and device-local sync baselines survive: `mtime:size:sha256` revisions, path-based ids (`p:<NFC path>`), `.geode-sync/marker.json`, `.geode-sync/ops/`, `.geode-trash/`, placeholders produce `partial`, conflict copies produce `partial`, scans are complete snapshots or fail closed.
- Fail closed everywhere; an unavailable container is `unavailable`, never an empty snapshot.
- Do not take on paid infrastructure; an Apple Developer capability on the existing team is not new spend, but it is a portal action only the user can perform (see Decision 1 and Open questions).

## Decision

Recommended (details and alternatives below):

1. Introduce an optional host service `HostServices.icloudContainer` (type `IcloudContainerBridge`, `src/shared/icloud-container.ts`) made of **small, natively atomic primitives**. All sync *policy* (folder naming/selection, marker, op index, trash layout, conflict-copy heuristics, placeholder-to-`partial` mapping, scan assembly, capabilities) stays in one shared TypeScript provider that is the existing PR #381 logic re-pointed at the bridge.
2. Both platforms address **the same remote**: the app's iCloud container `iCloud.com.rbcodelabs.geode`, subfolder `Documents/<remote folder name>/`. iOS uses the real container API; the Mac Electron app reads the same container's on-disk mirror `~/Library/Mobile Documents/iCloud~com~rbcodelabs~geode/Documents/<remote folder name>/` **directly with Node fs, with no iCloud entitlement or provisioning profile** (to be confirmed by a spike, see Decision 1). The Mac release process does not change.
3. Ship it as a core plugin `IcloudSyncPlugin` (setting `icloudSyncEnabled`, default false), with its UI in the Core plugins tab, available only where `host.icloudContainer` exists. The old Mac-only `com~apple~CloudDocs/Geode` location is retained as a hidden "iCloud Drive folder (legacy)" location so existing remotes keep working, with a guided copy to the container.
4. Supersede the community plugin in the host (skip loading `geode-icloud-sync` when the core plugin is enabled) and import its folder choice once.
5. Land in four small PRs: (1) bridge interface + Electron impl + core move, (2) Swift plugin + iOS project wiring, (3) mobile UI/settings, (4) migration affordances and docs. Only PR 2 needs the user's Apple portal action.

## 1. Platform-neutral bridge and the two implementations

### Options considered: where the platform line is drawn

| Option | Pros | Cons |
|---|---|---|
| **A. Atomic primitives native, policy in shared TS (recommended)** | One policy implementation, exactly the PR #381 tested logic; native code stays small enough to unit test with a temp dir; conditional writes are atomic where it matters (inside the native coordinated block); hashing stays native so file bytes do not cross the bridge to be hashed | Many fine-grained bridge calls unless `walk` is batched (it is); bridge contract must be designed carefully and versioned |
| B. Whole provider implemented natively per platform (Swift + Node) | Fewest bridge calls | Two implementations of conflict/idempotency/marker semantics that must stay byte-compatible on a shared remote; divergence corrupts data silently; violates "single JS provider" |
| C. Provider in JS on top of generic file primitives (Capacitor Filesystem / existing managed-vault `list/read/write/rename`) | No new native code | Cannot reach the ubiquity container (Capacitor Filesystem knows only sandbox directories); no coordinated atomic compare-and-replace from JS, so the check-to-rename window is async across the bridge, which is strictly worse than #381; cannot read download status |
| D. Append-only-history provider ([ADR-0016](0016-causal-append-only-vault-history.md)) over the container | Needs no atomic conditional write | Heavier, storage grows without GC, different remote layout that would orphan every existing remote, and iCloud cannot give cross-device atomicity either way |

### Bridge interface (pseudocode; engineer finalizes types)

All paths are container-relative, NFC, `/`-separated, under a single *root folder* the provider chose (`Documents/<name>`). The bridge never accepts absolute paths, `..`, or names that escape the root. Every call takes an `AbortSignal` and is cancellable.

```
interface IcloudContainerBridge {
  availability(): Promise<
    | { state: "available"; containerId: string }
    | { state: "unavailable"; reason: "not-signed-in" | "icloud-drive-disabled"
        | "container-not-found" | "unsupported-platform" | "permission-denied" }>
  listRoots(): Promise<string[]>                       // folders under Documents/ that are valid remote roots
  inspectRoot(name): Promise<"missing" | "empty" | "marked" | "foreign">   // marker present? (policy stays in TS; this is a convenience)

  walk(root, opts): AsyncIterable<WalkBatch>           // batched, so one scan is O(files/500) bridge calls
  // WalkBatch.entries[]: { path, kind: "file"|"folder", size, mtimeMs,
  //   revision,                                        // "mtime:size:sha256", computed natively, cached by dev/inode/mtime/size
  //   availability: "current" | "downloading" | "not-downloaded",   // platform differences normalized here
  //   conflict?: { kind: "unresolved-version" | "name-copy-suspected", ... } }
  // WalkBatch.final: { complete: boolean, problems: string[] }    // symlink / unreadable => complete=false

  read(path, { offset?, length?, expectedRevision? }): Promise<{ bytes: ArrayBuffer, revision }>   // ranged for the 100 MiB cap

  beginWrite(): Promise<WriteHandle>                   // staged, chunked: mirrors chunked-binary.ts; no giant base64 payloads
  appendChunk(handle, bytes): Promise<void>
  commitWrite(handle, { path,
      precondition: { absent: true }                   // create-only (hard link / exclusive create), never overwrites
                  | { revision: string } }): Promise<{ revision }>   // re-hash + compare + replace inside ONE native critical section
  discardWrite(handle): Promise<void>

  move(from, to, { expectedRevision, createParents }): Promise<{ revision }>   // conditional; trash is move into .geode-trash/...
  mkdir(path): Promise<void>
  removeEmptyFolder(path): Promise<void>

  startDownload(paths): Promise<void>                  // brctl download | startDownloadingUbiquitousItem
  waitForDownload(paths, { timeoutMs }): Promise<{ ready: string[], pending: string[] }>

  watch(root, onChange): Disposer                      // presence only: "something changed"; never carries truth
  pendingUploadCount?(root): Promise<number>           // optional, for status UI
}
```

Errors are typed: `PreconditionFailed` (maps to `SyncPreconditionError`), `NotFound`, `Unavailable`, `Aborted`, `TooLarge`. The provider declares `capabilities` exactly as today (`binary, conditionalWrites, completeSnapshots, atomicMoves, trash` true; `delta` false; `maxFileSize` 100 MiB).

What stays in TS (moved verbatim from `packages/geode-icloud-sync/src/provider.ts` and `folders.ts`): folder-name sanitization and resolution, `p:` ids, junk-name filter, marker policy and the `marker-missing` partial, op index records, trash path layout, conflict-copy heuristic (`name 2.ext` beside `name.ext`), placeholder-to-`partial` mapping, diagnostics, `maxFileSize` handling.

`watch` and `pendingUploadCount` are hints only. Correctness always comes from the next full snapshot scan (`delta: false`).

### Electron implementation (keeps PR #381 semantics exactly)

- Location: `src/sync-node/icloud-container.ts` (Node `fs`, no Electron import, unit-testable against a temp dir), reusing `src/sync-node/node-icloud.ts` (`hydrateIcloudPaths`, brctl runner) and the path-lock/atomic-write helpers already in `sync-node`. IPC glue `src/main/icloud-container-ipc.ts` modeled on `hub-sync-ipc.ts` (owner = webContents id, per-request `AbortController`, `closeOwner` on `destroyed`); preload exposes `icloudContainer.call/abort/watch`; `electron-host.ts` passes it through; `legacy-facade.ts` stubs it. The preload exposes it only when `process.platform === "darwin"`.
- Semantics preserved: revision `mtime:size:sha256` with the same cache key; conditional write = re-hash from disk, temp file in the same folder, fsync, re-verify, atomic rename; create-only = hard link; `.name.icloud` stubs and dataless files (`blocks === 0 && size > 0`, already in `node-scan.ts`) reported as `availability: "not-downloaded"`; `brctl download` + bounded poll.
- Because the implementation is plain Node, the same module can later back `geode-wiki sync` for a headless iCloud hub at no extra design cost.
- Known limit carried over: the check-to-rename window is not atomic against iCloud's own daemon (ADR-0029). Closing it on the Mac needs native `NSFileCoordinator` code in a signed helper; deferred, see Consequences.

### iOS implementation (Swift Capacitor plugin)

- New `ios/App/App/GeodeIcloudContainerPlugin.swift` (`CAPPlugin, CAPBridgedPlugin`, `jsName "GeodeIcloudContainer"`), registered next to the managed-vault plugin in `GeodeBridgeViewController` (`bridge?.registerPluginInstance`). Registered on the JS side with `registerPlugin<...>("GeodeIcloudContainer")` in `capacitor-host.ts`, surfaced as `host.icloudContainer`. All logic lives in a pure `IcloudContainerEngine` struct taking a root `URL` and a coordinator seam, so XCTest can drive it with a temp directory; the plugin is thin glue.
- Container resolution: `FileManager.default.url(forUbiquityContainerIdentifier: "iCloud.com.rbcodelabs.geode")?.appendingPathComponent("Documents")`, called off the main thread (it can block on first use). Availability uses `FileManager.default.ubiquityIdentityToken` (nil = not signed in / iCloud Drive off) plus a non-nil container URL.
- Reads: `NSFileCoordinator.coordinate(readingItemAt:)`. Writes and moves: `coordinate(writingItemAt:options: .forReplacing / .forMoving)`; inside the block re-hash, compare to `precondition.revision`, write the staged temp file, `FileManager.replaceItemAt`. This closes the check-to-write window against *coordinated* writers, including iCloud's own daemon, so iOS is **stronger** than the Mac Node path.
- Download state: `URLResourceKey.ubiquitousItemDownloadingStatusKey` (`.current` / `.downloaded` / `.notDownloaded`) normalized to the bridge's `availability`; `FileManager.startDownloadingUbiquitousItem(at:)` for `startDownload`; `waitForDownload` polls the status key (and `NSMetadataQuery` updates) with a bound. The JS layer never sees `.icloud` stubs: the plugin maps a stub back to its real name and reports `not-downloaded` (older OS behavior); dataless files report via the status key.
- Conflicts: besides the name-copy heuristic (still done in TS), the plugin reports `ubiquitousItemHasUnresolvedConflictsKey` / `NSFileVersion.unresolvedConflictVersionsOfItem` as `conflict: "unresolved-version"`; the provider treats it exactly like a conflict copy (withheld, scan `partial`). Resolving versions natively is out of scope here (fail closed first).
- Change presence: `NSMetadataQuery` with `NSMetadataQueryUbiquitousDocumentsScope`, or an `NSFilePresenter` on the root, emitting a coalesced "changed" event over the Capacitor listener. Foreground only: no background sync (consistent with ADR-0015's deferral).
- Enumeration must not use `.skipsHiddenFiles` (the marker, ops and trash are dot-folders); chunked staged writes reuse the pattern of `chunked-binary.ts` and the native `writeBinary`/`readBinaryRange` already in the managed-vault plugin.

### Same remote, both sides: container, entitlements, Info.plist

| Item | Value | Certainty |
|---|---|---|
| Container id | `iCloud.com.rbcodelabs.geode` (default form of the bundle id) | Naming convention certain. **Permanent once used:** a container cannot be renamed, so confirm the id before creating (Open question 1). |
| Mac on-disk path | `~/Library/Mobile Documents/iCloud~com~rbcodelabs~geode/Documents/<name>/` (dots become `~`) | Mapping rule certain. |
| iOS entitlements (new `ios/App/App/App.entitlements`, referenced by `CODE_SIGN_ENTITLEMENTS`) | `com.apple.developer.icloud-container-identifiers` = [`iCloud.com.rbcodelabs.geode`]; `com.apple.developer.icloud-services` = [`CloudDocuments`]; `com.apple.developer.ubiquity-container-identifiers` = [`iCloud.com.rbcodelabs.geode`] | Certain these are required for the iOS ubiquity container. |
| iOS `Info.plist` | `NSUbiquitousContainers` dict keyed by the container id with `NSUbiquitousContainerIsDocumentScopePublic = true`, `NSUbiquitousContainerSupportedFolderLevels = Any`, `NSUbiquitousContainerName = Geode` | Certain this makes the container appear in Files and Finder. The folder typically appears only after the container has content and the app has launched once on a signed-in device: **NOT VERIFIED**. |
| Apple Developer portal | Enable the iCloud capability on App ID `com.rbcodelabs.geode` and create the container; then provisioning must be regenerated | **User action** (Open question 1). Whether CI's cloud-managed signing key (`-allowProvisioningUpdates`, Admin key) can enable the capability automatically: **NOT VERIFIED**, assume manual. |
| Mac entitlement / profile | **None required in the recommended design** | Strong precedent (Obsidian's non-sandboxed Electron app reads `iCloud~md~obsidian/Documents` directly), but **a spike on the user's Mac is required** before PR 1 merges (below). |

#### The Mac Electron story

The Geode Mac app is Developer ID signed and not sandboxed, so it can read and write any path the user can, subject to macOS privacy prompts. Two options:

| Option | Pros | Cons |
|---|---|---|
| **M1. Direct fs on the container's on-disk mirror, no entitlement (recommended)** | No portal work for the Mac; no profile in the release pipeline; zero risk of a mis-provisioned notarized build refusing to launch; reuses PR #381 code almost unchanged | The folder only exists on the Mac once the container exists in the user's iCloud (created by the iOS app with a public container, or by any Mac app owning it); coordination is uncoordinated fs like today; a TCC prompt may appear |
| M2. Give the Mac app the iCloud entitlement + Developer ID provisioning profile, resolve the container via `NSFileManager` in a native helper | Mac becomes a first-class container owner (container exists without iOS, `NSFileCoordinator` available, closes the race window) | Restricted entitlements need an embedded provisioning profile; a mismatch makes the signed app **fail to launch** (AMFI) on every user's Mac; requires electron-builder `provisioningProfile`, separate helper-process entitlements, notarization re-test, and a native helper binary or Node addon |

Recommendation M1 now, M2 as a later hardening phase if the spike or field data shows a need. Consequence to state to users: the Mac folder appears after Geode for iOS has been installed on a device with the same Apple ID and opened once (a TestFlight build counts); a Mac-only user with no iOS app gets the explicit `container-not-found` unavailable state with that explanation, and can keep using the legacy Drive-folder location.

**Spike (required, cheap, user's Mac, before PR 1 merges):** with the iOS build from PR 2 installed (or an Obsidian-style public container for a throwaway id), confirm that (a) the Mac mirror directory appears, (b) the non-sandboxed notarized-style Electron app can create/read/rename/hardlink in it, (c) dot-folders (`.geode-sync`) sync both ways, (d) which TCC prompt appears. If (b) fails, fall back to M2 and re-order phasing.

#### What happens to `com~apple~CloudDocs/Geode`

| Option | Pros | Cons |
|---|---|---|
| Drop it, migrate everything to the container | One location, simplest UI | Existing Mac remotes (including users mid-trial of #381) lose their path; forced copy before anything works |
| **Keep as Mac-only legacy "iCloud Drive folder" location, container is the default and the only location on iOS (recommended)** | No data movement forced; existing bindings keep working untouched; E2E fixtures (`GEODE_ICLOUD_BASE`) keep working | Two locations to test; iOS can never join a legacy remote (it cannot see that folder) |
| Keep as the default and add the container as optional | Least change for #381 users | Defeats the goal: iOS cannot join the default remote |

The location is a per-vault device setting `location: "container" | "drive-folder"`. `drive-folder` is shown only on darwin and only when a legacy `Geode/<name>` folder with a marker exists (or `GEODE_ICLOUD_BASE` is set). A guided action "Copy this remote into the Geode container" hydrates every file, copies with verification into `Documents/<name>`, and leaves the original in place; the user then disconnects, switches location, and reconnects (preview is a no-op because contents are identical). The original is never deleted automatically.

Guard: refuse to enable (or register) the provider when the local vault itself lies inside any `Mobile Documents` tree or, on iOS, is a ubiquitous item (a picker-selected iCloud Drive folder vault), because two sync engines on one folder is the failure mode ADR-0029 already forbids. The `splitICloudPlaceholders` path in `capacitor-host.ts` is the existing signal that iCloud-hosted iOS vaults are a real case.

## 2. Migration from the community plugin `geode-icloud-sync`

Kept stable on purpose: provider id `icloud`, name, path-based entry ids, revision format, marker/ops/trash layout. This is what lets device-local baselines, cursors and journals (host-owned, keyed by provider/vault, not by plugin) continue to apply, so a migrated vault should preview as a no-op. That the baseline is keyed independent of the plugin owner is an assumption to be confirmed in PR 1 with a test.

Duplicate registration: `register()` throws on a second `icloud`. Options:

| Option | Pros | Cons |
|---|---|---|
| Do nothing; the loser's `onload` throws | Zero code | Community plugin shows a load error; user sees breakage on upgrade |
| Ship community plugin 0.2.0 that no-ops if `icloud` is already registered | Clean message | Relies on users updating; ordering-dependent |
| **Host supersede list (recommended): `PluginManager` skips loading `geode-icloud-sync` while `icloudSyncEnabled` is true, and surfaces "Superseded by core iCloud sync" in the community plugin list** | Deterministic, works for un-updated installs, no duplicate registration is ever attempted | Small host special-case (a constant like the existing `claude-threads` special cases); must unskip if core is turned off |

Data: core reads `<vault>/.geode/plugins/geode-icloud-sync/data.json` read-only once, imports the per-vault folder choice (keyed by vault path) into its own device-local state, and records `migratedFromCommunity`. The community `data.json` and plugin files are never deleted. If the community plugin is enabled and core is off, nothing changes (back-compat); Settings shows a banner with a "Switch to core iCloud sync" action which: imports the choice, enables the flag, and disables the community plugin in `plugins.json`.

Active-binding caution: if iCloud is the active provider when the community plugin unloads, the host sets `Sync provider unloaded; reconnect explicitly`. Expect one explicit reconnect plus a preview (no-op) after the switch. Whether the binding auto-restores for conditional providers after re-registration is **NOT VERIFIED** and must be tested in PR 1; the switch UI should say "Reconnect in Settings -> Sync" if not.

Whether to keep publishing the community plugin: Open question 3. Recommendation: freeze it (final 0.2.0 with a deprecation notice), stop publishing new features.

## 3. Core-plugin integration

Files:

- `src/renderer/internal-plugins/icloud-sync/icloud-sync-plugin.ts` (class `IcloudSyncPlugin extends GeodePlugin`, manifest id `icloud-sync`, calls `registerSyncProvider(createIcloudProvider({ bridge, ... }))` in `onload`).
- `.../provider.ts`, `.../folders.ts` (moved from the package, `node:*` imports removed, path helpers pure; hashing/fs removed in favor of the bridge).
- `.../folder-selection.ts` (`FolderSelection` over `bridge.listRoots/inspectRoot` + device state; pure, unit-testable).
- `src/shared/icloud-container.ts` (interface + error types), `src/sync-node/icloud-container.ts`, `src/main/icloud-container-ipc.ts`, preload/`electron-host.ts`/`legacy-facade.ts`/`contracts.ts` wiring, `src/renderer/host/capacitor-host.ts` (JS side of the Swift plugin).
- `packages/geode-icloud-sync/`: kept for one release as the frozen shim (or removed, per Open question 3); its fs code is superseded by `src/sync-node/icloud-container.ts`.

Settings and sync:

- `AppSettings.icloudSyncEnabled: boolean`, default `false`, loaded like `slidesEnabled` (`saved.icloudSyncEnabled === true`); `syncIcloudSyncPlugin()` follows the existing unload/construct/load pattern and is called with the other `sync*Plugin()` calls near `app.ts:3654`. Unlike Slides it returns early (no provider) when `!this.host.icloudContainer`, and runs `availability()` lazily at `open()`, not at load.
- Add `icloudContainer` to `HostCapabilities` (true on Electron-darwin and iOS native; false on browser, Electron non-darwin, Android) so UI does not probe an optional member.
- Pre-condition ordering: it must be constructed before `pluginManager.initialize()` (as the other core plugins are) so the supersede check is deterministic.

Where the folder UI goes: **into the Core plugins tab** (recommended) rather than a `PluginSettingTab`. Every existing core plugin that has options renders them inside `renderCorePluginsTab` (note composer, web viewer); the plugin setting tab API is community-plugin machinery, and a second place for the same toggle would split the story. A new `renderIcloudSyncSettings(container)` section shows: enable toggle; availability line (signed in / container found / reason when unavailable); Remote folder name + Apply; existing marker-bearing folders dropdown; location selector (darwin, legacy only); the migration banner. The `GEODE_ICLOUD_BASE` override is kept (it replaces the container's `Documents` root and the legacy Drive root) for E2E.

Mobile surface: `renderCorePluginsTab` is shared code, so the same section appears on iOS; the work is layout (touch targets, no hover), the platform-specific unavailable copy ("Sign in to iCloud and enable iCloud Drive for Geode in Settings"), and hiding the location selector. The sync status/preview/approval UI (Settings -> Sync) is the existing shared one.

Guards via `host.capabilities.icloudContainer` and `host.runtime`: toggle hidden when false; legacy location visible only when `runtime.platform === "darwin"` and `runtime.runtime === "electron"`; "Copy into container" only on desktop; iOS never shows `brctl`-flavored copy.

## 4. Testing strategy

| Layer | What | Where it runs | Proves |
|---|---|---|---|
| Unit: provider over a **fake bridge** | Port `tests/unit/icloud-sync-provider.test.ts` and `icloud-sync-folders.test.ts` to an in-memory `FakeIcloudBridge` (scripted availability, placeholders, conflicts, precondition failures, abort); same suite also runs against the real Node implementation on a temp dir (contract test shared by both) | `npm test` / `verify.yml` | Policy parity with #381, bridge contract, fail-closed paths |
| Unit: Node bridge | `src/sync-node/icloud-container.ts` against temp dirs with simulated stubs and dataless files; crash/replay of the op index | CI (mac and linux where applicable) | Revision semantics, atomic conditional write, hard-link create |
| Unit: core plugin | `syncIcloudSyncPlugin()` registers/unregisters, capability guard, supersede skip, community `data.json` import | `npm test` | Lifecycle and migration |
| Electron E2E | Extend `tests/e2e/icloud-sync-settings.spec.ts`: no longer copies a plugin build; instead enable via the Core plugins toggle, with `GEODE_ICLOUD_BASE` pointing at a temp base; cover container and legacy locations, folder dropdown, Apply, refusals, and an end-to-end preview/sync round trip between two temp vaults on one base | `npm run e2e` | Real IPC, preload, UI, host registration, no real iCloud touched |
| Mobile web (Playwright mobile config) | Core plugins tab renders the section against a stub `host.icloudContainer`; unavailable copy; hidden legacy selector | existing `verify.yml` mobile job | Mobile layout and guards, **not** native behavior |
| Swift analysis/build | `xcodebuild archive` already compiles the Swift in `ios-testflight.yml`; add a CI step (macOS runner) `xcodebuild build-for-testing -scheme App -destination 'generic/platform=iOS Simulator'` so Swift errors fail PRs, not tag builds | new job in `verify.yml` | Compiles, entitlements file well-formed |
| XCTest | `GeodeIcloudContainerEngineTests` against a temp-directory root with a fake coordinator: revision computation, precondition failure, create-only collision, stub-name normalization, trash move, abort, path-escape rejection. Add to the existing test target alongside `GeodeKeychainStoreTests` | Simulator on a macOS runner (new CI job, minutes cost) or the local `ios-mvp-acceptance.sh` | Engine logic. **Does not** involve iCloud |
| Release gate (manual) | Two real devices (Mac + iPhone/iPad, same Apple ID): first sync both directions, edit-edit conflict, eviction/download, large file, airplane mode mid-sync, sign-out | Release checklist | Everything below |

**NOT VERIFIED until that manual gate passes** (cannot be reproduced in CI): real iCloud propagation and latency; dot-folders (`.geode-sync`, `.geode-trash`) syncing; Mac mirror appearing and writable by the notarized Electron app; `.icloud` vs dataless-file behavior on the current OS versions; `ubiquitousItemDownloadingStatus` timing; `NSFileCoordinator` interplay with iCloud's daemon; how `NSFileVersion` conflicts versus `name 2.ext` copies actually appear for Geode's write pattern; container visibility in Files/Finder; TestFlight signing with the new capability; behavior when iCloud is signed out mid-session. Passing unit/E2E/XCTest must be reported as exactly that, never as "iCloud sync verified".

## 5. Phasing (each a separate small PR)

| PR | Scope | Verification | Release implication |
|---|---|---|---|
| **0 (spike, no PR)** | User's Mac: confirm container mirror access from a non-sandboxed Electron app; capture TCC behavior | Manual, recorded in the ADR | Decides M1 vs M2 |
| **1. Bridge + Electron + core move** | `src/shared/icloud-container.ts`; Node impl + IPC + preload + host wiring; provider ported to the bridge; core plugin, `icloudSyncEnabled`, supersede rule, Core plugins UI, community-data import; default location **legacy Drive folder on Electron until the container exists** (so nothing regresses before PR 2); unit + extended Electron E2E | tsc, unit, Electron E2E, build | Ships in a normal signed/notarized desktop release. No entitlement or profile change. Zero iOS effect. Safe to merge before any portal work |
| **2. Swift plugin + iOS wiring** | `GeodeIcloudContainerPlugin.swift` + engine + XCTests; `App.entitlements`, `CODE_SIGN_ENTITLEMENTS`, `NSUbiquitousContainers`; JS `registerPlugin` in `capacitor-host.ts`; `host.icloudContainer` on native; CI Swift build job | Simulator XCTest, `xcodebuild` build, mobile Playwright with stub | **Needs the user's Apple Developer portal action first** (Open question 1) or the export step fails (provisioning lacks iCloud). Ships through `ios-testflight.yml` on an `ios-v*` tag (tag must match `package.json`); the first TestFlight build is also the build that creates the container, which the Mac spike and PR 3's real-device gate depend on |
| **3. Mobile UI + container as default** | Core plugins section on mobile (layout, copy, unavailable states); container becomes the default location on Electron once the container is found; guards for iCloud-hosted vaults | Mobile Playwright, Electron E2E, then the two-device manual gate | Desktop release + a second TestFlight build. Beta caveat in-app until the manual gate is signed off |
| **4. Migration affordances + docs** | "Copy remote into container" action, switch banner, deprecate community plugin (final 0.2.0), update `plugin-sync-api.md` and the README, supersede ADR-0029 placement text | Unit + E2E for the copy action | Desktop release |
| *Later (optional)* | Mac M2 hardening: native `NSFileCoordinator` helper + entitlement/profile; native `NSFileVersion` conflict resolution; background refresh on iOS | Separate ADR | Changes the signed Mac release process, hence its own decision |

Each PR keeps the ADR-0029 beta posture (disposable vault copies, do not combine with another sync engine on the folder, no recommendation until the two-device soak passes).

## Consequences

- One tested policy implementation serves both platforms; native code is small and unit-testable.
- iOS gains real iCloud sync with stronger write atomicity than the Mac path; the Mac keeps the unsandboxed fs model and an unchanged release pipeline (if the spike passes).
- A user with only a Mac and no Geode iOS install has no container; the product must explain that and offer the legacy location rather than appear broken.
- The bridge becomes a versioned contract between TS and two native implementations; contract tests must run against both.
- A new permanent identifier (the container id) and a new capability on the app's App ID; they cannot be cheaply reversed.
- Host gains a small supersede special-case for one community plugin id.

## Risks

- **Container mirror access on macOS (riskiest assumption):** if a notarized, unsandboxed Electron app cannot reliably write to `iCloud~com~rbcodelabs~geode`, M1 fails and the Mac needs the entitlement + profile (M2), which changes the signed release and risks launch failure on a bad profile. Mitigated by the spike before PR 1 merges.
- iCloud may not sync dot-prefixed folders the way #381 assumes, which would break the marker/ops/trash design on both platforms. Mitigated by the spike (c) and a documented fallback to non-dot names (a layout change, so decide before users depend on it).
- Revision includes mtime; if iCloud rewrites mtime on another device the revision changes with identical bytes. Harmless (identical download) but noisy; kept for baseline continuity, revisit with a content-only revision when a migration window exists.
- Two sync engines on one folder (iCloud-hosted vault plus this provider) can corrupt data; guarded, but the guard depends on correctly detecting the vault location.
- Bridge payload size and latency on iOS (base64 over the Capacitor bridge); mitigated by native hashing, batched `walk`, and chunked/ranged transfer, but unmeasured.
- Un-GC'd op index and trash grow in the container (carried over from ADR-0029) and now count against the user's iCloud quota.
- App Store/TestFlight review of a new iCloud capability and public container is expected to be routine but is unverified.

## What would make me revise this

- The spike shows the Mac cannot use the mirror directly (switch Mac to M2 and re-order phases).
- Two-device testing shows `NSFileCoordinator` writes and Node fs writes race in practice (move the Mac to a coordinated native helper sooner).
- Bridge latency makes scans unusably slow on large vaults (move `walk` to a native-owned incremental index, or push scan assembly native).
- The user chooses a different container id or bundle id (the doc and entitlements parameterize one constant).

## Open questions for the user

1. **Apple identifiers and portal action (blocks PR 2).** Which container id should be created? (a) `iCloud.com.rbcodelabs.geode` on the existing App ID `com.rbcodelabs.geode`, team `6M8F464WCQ` (recommended; matches the bundle id and the Electron `appId`); (b) a separate shared id such as `iCloud.com.rbcodelabs.geode.sync` (only if you want the container decoupled from the bundle id; the id is permanent either way); (c) not yet, hold iOS and ship PR 1 only. If (a) or (b): you must enable the iCloud capability (iCloud Documents) and create the container in the Developer portal, or tell me to try letting the Admin App Store Connect key do it via `-allowProvisioningUpdates`.
2. **Mac signing strategy.** (a) Direct filesystem access with no iCloud entitlement, pending the spike (recommended); (b) add the iCloud entitlement and a Developer ID provisioning profile to the Mac build now (adds launch-failure risk and a profile to maintain); (c) decide after the spike. Also: can you run the spike on your Mac once the first iCloud-enabled TestFlight build has been opened on a device?
3. **Community plugin `geode-icloud-sync`.** (a) Freeze it with a final deprecation release and supersede it in the host (recommended); (b) keep maintaining it in parallel; (c) remove it outright in the same release as the core plugin (only safe if no one but you has installed it).
4. **Legacy Drive-folder location on the Mac.** (a) Keep it as a hidden legacy mode plus a guided copy into the container (recommended); (b) drop it and require everyone to migrate; (c) keep it as the Mac default and make the container opt-in (iOS then cannot join the default remote).
5. **Core toggle default and rollout.** (a) `icloudSyncEnabled` default off, with an in-app migration banner for vaults that have the community plugin enabled (recommended); (b) auto-enable for those vaults on upgrade; (c) ship hidden behind a developer flag until the two-device soak passes.
6. **CI cost.** (a) Add an Xcode `build-for-testing` plus XCTest job on a macOS runner to `verify.yml` for PRs touching `ios/**` (recommended); (b) keep Swift tests local-only via `ios-mvp-acceptance.sh`, accepting that Swift breakage is found at tag time.

## Appendix: implementation plan (for the engineer)

1. **Spike (user + engineer):** write a throwaway Node probe script (TypeScript, per repo convention) that creates, hard-links, renames and hashes under `~/Library/Mobile Documents/iCloud~<id>/Documents/spike/` and lists the TCC behavior; confirm dot-folder sync using a second device.
2. **PR 1 (bridge + Electron + core):**
   1. Add `src/shared/icloud-container.ts` (interface, error classes, batch types) and a contract test suite parameterized over implementations.
   2. Move `provider.ts`/`folders.ts` into `src/renderer/internal-plugins/icloud-sync/`; replace `node:fs/crypto/child_process` use with bridge calls; keep the exported constants and error codes unchanged.
   3. Implement `src/sync-node/icloud-container.ts`; add IPC (`icloud-container`, `icloud-container-abort`, watch events), preload object, `electron-host.ts`, `legacy-facade.ts`, `contracts.ts` (`icloudContainer?`, `HostCapabilities.icloudContainer`).
   4. Add `IcloudSyncPlugin`, `icloudSyncEnabled` (type, default, load, save), `syncIcloudSyncPlugin()` and its call site, `renderIcloudSyncSettings`.
   5. Add the supersede rule in `PluginManager` and the community-`data.json` import.
   6. Port unit tests; extend `tests/e2e/icloud-sync-settings.spec.ts`; run tsc, unit, the narrow E2E (homelab/`tq` first per machine-capacity rules), build.
3. **PR 2 (iOS):** after the portal action, add `App.entitlements`, `NSUbiquitousContainers`, `GeodeIcloudContainerPlugin.swift` + `IcloudContainerEngine` + XCTests, JS registration; add the Xcode build CI job; cut an `ios-v*` TestFlight build; run the manual real-device checks and record results here.
4. **PR 3 / PR 4:** as in the phasing table; update this ADR's status to Accepted only after the two-device gate passes, and record the NOT VERIFIED items that remain.
