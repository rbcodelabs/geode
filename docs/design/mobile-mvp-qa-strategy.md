# Geode Mobile MVP QA Strategy

**Date:** 2026-08-28
**Status:** Proposed
**Scope:** Full-featured Geode MVP for iPhone and iPad, while preserving the Electron desktop product

## Quality objective

The mobile MVP is releasable when a user can select a real Files-provider vault, use Geode's daily workflows on iPhone and iPad, suspend or kill the app without losing accepted edits, and return to the same workspace without corrupting the vault. Mobile support must not weaken path isolation, load desktop-only plugin code, or regress the Electron app.

The most dangerous failures are silent data loss, stale overwrites after an external edit, access outside the selected vault, loss of security-scoped access after restart, and UI paths that only work with a mouse or desktop keyboard.

## Current baseline

The repository currently has:

- A Node-based Vitest suite under `tests/unit` with substantial coverage of vault behavior, metadata, plugins, graph, Canvas, Bases, and pure renderer logic.
- A large Playwright Electron suite under `tests/e2e`, run serially with one retry. It exercises real Electron windows, filesystem fixtures, CodeMirror Live Preview, graph, Canvas, Bases, plugins, Web Viewer, binary embeds, and workspace persistence.
- A renderer that calls one `window.geode` bridge defined in `src/main/preload.ts`. This is a useful seam for a platform-neutral host contract, although the current exported type is inferred from Electron implementation details.
- Regression coverage for own-write watcher echoes versus genuine external note changes, but not a complete concurrent-edit policy.
- No iOS project or XCTest/XCUITest target, no Capacitor dependencies, no browser-only renderer integration harness, no device matrix, and no mobile CI job.
- Almost no mobile/responsive treatment in `styles/app.css`; current E2E gestures are predominantly mouse and keyboard events.

This strategy follows proposed [ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md): the renderer receives a capability-based `HostServices` contract, with `ElectronHostServices` and `CapacitorHostServices` implementations. Native vault and Web Viewer behavior is supplied by Geode Swift plugins. The ADR remains proposed until Slice 0 proves the boundary and the product selects a `ThreadExecutionProvider`.

## Minimum test pyramid

| Layer | Purpose | Minimum scope | Expected frequency |
|---|---|---|---|
| Contract and pure unit tests | Catch host/renderer drift and data-rule failures quickly | Every host method, path validation, event normalization, platform capability gating, merge/conflict decisions, responsive state helpers | Every change/PR |
| Browser-renderer integration tests | Prove the shared UI works without Electron globals or Node | Renderer boot with a fake host, core views, responsive layouts, touch/pointer events, lifecycle events, error/empty/loading states | Every change/PR |
| Native bridge integration tests (XCTest) | Prove actual iOS filesystem semantics | Security-scoped bookmarks, coordinated reads/writes, binary I/O, file-provider errors, lifecycle persistence | Every mobile change/PR on simulators; selected cases on device |
| Thin end-to-end journeys | Prove catastrophic user workflows across all layers | Open vault, edit/restart, external edit, search/link navigation, graph, Canvas, Bases, plugin gating, attachment, Web Viewer fallback | Mobile release candidates |
| Desktop Electron regression | Prevent shared-renderer/mobile work from breaking desktop | Existing unit, build, typecheck, Playwright Electron suite, parity check | Every change/PR |

Do not duplicate every Electron E2E spec on iOS. Most feature rules belong in unit or browser-renderer tests. Native E2E should cover only integration seams and high-value journeys that can fail specifically because of WKWebView, Files providers, iOS lifecycle, touch, or native permissions.

## Coverage map

### 1. Host contract

Create a platform-neutral contract test suite that fake, Electron, and iOS adapters must pass. Organize it by ADR-0007's services: `runtime`, `vaultRegistry`, `vaultFiles`, `config`, `metadataIndex`, `navigation`, `webContent`, `plugins`, and `diagnostics`. Use the same fixtures and expected errors wherever semantics are portable; capability-specific operations must prove honest unavailability rather than pretend to conform.

Required cases:

- Vault discovery/open/list/read/write/mkdir/delete/rename/exists and binary read/write, including empty files, Unicode and decomposed filenames, spaces, dotfiles, nested folders, and large-but-supported files.
- Config and workspace-state read/write, including absent, malformed, old-version, and interrupted state.
- Vault event subscription: create, modify, delete, folder create/delete, duplicate events, delayed own-write echoes, coalesced events, and unsubscribe/cleanup.
- Resource URL creation and cleanup for image/audio/video; URLs must not escape the selected vault.
- External URL and local-file routing, rejecting unsupported schemes and path traversal.
- `runtime` and immutable capability reporting: iOS, iPhone versus iPad, desktop-only APIs, mobile-only commands, Web Viewer capability, thread execution, background/suspend state, and attempts to mutate the startup snapshot.
- `vaultRegistry` identity and recent-vault behavior: managed versus File Provider vault, select/cancel, reopen, move/reconnect, and never substituting a new empty vault for an inaccessible one.
- `metadataIndex` fallback and partial-index states: cache validity, bounded cancellation/resume, and graph/backlink completeness signals.
- `navigation`, `webContent`, `plugins`, and `diagnostics` capability behavior, including lifecycle cleanup and stable error reporting.
- Every unsupported operation rejects with a stable typed/coded error rather than hanging or returning an ambiguous `null`.
- Contract conformance is compile-time checked and behaviorally tested so adding a method fails both hosts until implemented or explicitly marked unsupported.

Security cases must include `../`, encoded traversal, absolute paths, symlink/alias escapes where a provider exposes them, case and Unicode normalization collisions, malicious plugin inputs, and attempts to access a second vault using a stale identifier.

### 2. Browser-renderer integration

Run the shared renderer in a real browser engine with a deterministic fake host. The suite must prove the renderer never imports or calls Electron/Node at module load on mobile.

Required journeys at iPhone and iPad viewport classes:

- Boot with no recent vault, a valid vault, an empty vault, denied access, and host failures.
- File explorer navigation, create/rename/delete, search, wikilinks/backlinks, properties, attachments, and workspace restore.
- Error, loading, offline, empty, permission-revoked, and conflict states are reachable by fake-host injection and remain operable.
- iPhone single-pane navigation and drawers; iPad split layout, rotation, multitasking widths, safe-area insets, and size-class changes without destroying editor state.
- All primary actions use semantic buttons/labels, visible focus, and touch targets of at least 44 by 44 points. No action may require hover or right-click only; long-press or an action menu must exist where needed.
- Touch scrolling is not captured by editor/Canvas/graph gestures. Modals, prompts, menus, and floating panels remain within the visual viewport when the software keyboard changes its height.
- VoiceOver-accessible names and order for navigation, editor controls, Canvas/graph toolbars, Base controls, permission/conflict prompts, and destructive confirmations.

### 3. Native iOS vault bridge

Use XCTest against temporary folders for deterministic adapter tests and a small UI/device suite against document-picker/File-provider flows.

#### Security-scoped bookmark and permission behavior

- Selecting a folder creates persisted access; cold launch resolves it and reopens the exact vault.
- Access start/stop calls are balanced across normal close, vault switch, suspend, memory pressure, and thrown operations.
- A stale bookmark is refreshed without changing vault identity.
- A deleted/moved provider folder produces a recoverable choose/reconnect state, not an empty vault that could overwrite config.
- Revocation while open causes in-flight and later writes to fail visibly; unsaved renderer text is retained for recovery and is not reported saved.
- Revocation while suspended is detected before the first resume write.
- Permission for vault A cannot authorize vault B, a sibling folder, or an escaped path.
- Canceling the picker leaves the prior vault and state unchanged.

These cases need at least one real-device pass with iCloud Drive and one third-party File Provider before release; simulator-only behavior is not sufficient evidence for security-scoped and coordinated access.

#### File coordination and concurrent external edits

- Reads and writes use the agreed coordinated/atomic mechanism and never expose partial bytes.
- External modify/create/delete/rename events appear in the renderer once, even when providers coalesce or duplicate notifications.
- Own-write echoes do not reload/flicker the editor.
- External edit while the note is clean reloads deterministically and refreshes metadata, backlinks, graph, Canvas embeds, and Bases results.
- External edit while the note is dirty creates the ADR-specified conflict copy/review flow. Tests must assert exact original/conflict-copy bytes, editor text, status/error UI, and recoverability; no release while expected behavior is merely "last writer wins" by accident.
- App write and external write racing at file coordination boundaries produce one of the documented outcomes, never truncated/interleaved content.
- External delete/rename of an open note, Canvas, Base, attachment, or folder preserves a recoverable UI and correct file identity.
- Case-only rename, Unicode-normalization rename, provider-delayed rename, and folder subtree deletion are covered.

CRDT merging is explicitly out of scope. The detailed conflict-copy naming, cleanup, and review UX must be specified before its tests are finalized, but neither version may be overwritten under any naming/UI choice.

### 4. Offline, restart, and lifecycle persistence

- A fully local vault remains usable in airplane mode for reads, edits, search, graph, Canvas, and Bases.
- Cloud-placeholder files surface a distinct unavailable/offline state and never become zero-byte replacements. Managed-vault behavior remains the deterministic safety baseline.
- After an accepted edit, force-kill and relaunch preserve both file bytes and workspace state. Test kills immediately after typing, during debounce, during native write, and immediately after completion acknowledgement.
- Background/suspend flushes or journals dirty state within the documented lifecycle budget. Resume reconciles filesystem changes before autosave resumes.
- Repeated suspend/resume, memory warning, rotation, and scene disconnect/reconnect do not duplicate event listeners, saves, tabs, or plugin startup.
- Corrupt/incomplete workspace state falls back safely while vault data remains untouched.
- Search/metadata caches rebuild after stale or interrupted persistence and never outrank actual vault bytes.

Use deterministic fault injection around each persistence boundary. Timing-only sleeps are not adequate evidence.

### 5. CodeMirror editing and keyboards

- Tap positioning, selection handles, drag selection, scrolling, link/widget interaction, and toolbar actions work in source and Live Preview.
- Software keyboard does not cover the caret, inline suggestions, properties, prompts, or save/conflict status; viewport adjustments recover after dismissal and rotation.
- Autocorrect, smart punctuation, predictive text, dictation, paste, undo/redo, Markdown shortcuts, task toggles, wikilinks, tables, frontmatter widgets, and large-document virtualization do not corrupt source bytes.
- Composition/IME text is not saved mid-composition or duplicated. Include accented Latin composition and a CJK input path.
- Hardware keyboard on iPad covers Command Palette, search, new/open/close tab, undo/redo, selection, Escape, arrows, Tab/Shift-Tab, and app shortcut conflicts.
- External keyboard detach/attach and switching between hardware/software keyboard preserve focus and selection.

At least the basic keyboard/caret/selection and dictation/IME cases require real-device manual or automated evidence because desktop Chromium emulation does not reproduce WKWebView input behavior.

### 6. Graph, Canvas, and Bases

Shared rule engines stay in unit tests; mobile integration focuses on gestures, sizing, persistence, and host I/O.

- Graph: tap node opens note; pan and pinch zoom do not trigger browser zoom/scroll; filters/groups/search are usable; relayout does not lose selection; large graph stays responsive at the agreed fixture size.
- Canvas: one-finger selection/drag, two-finger pan/pinch, handles, edge creation, marquee alternative, context/action menus, text editing, media/file cards, undo/redo, and save/reopen. Every mouse-only desktop action needs a discoverable touch equivalent.
- Bases: horizontal/vertical scroll arbitration, filter/sort menus, table cell selection/editing, Cards, software-keyboard avoidance, frontmatter writeback, and live refresh after external edits.
- iPad pointer and hardware keyboard behavior must coexist with touch; phone layouts must not render desktop-sized canvases/tables with unreachable controls.
- Gesture tests assert both resulting model/file state and UI state. Pixel movement alone is too brittle and does not prove persistence.

### 7. Plugin compatibility gating

- A manifest marked `isDesktopOnly: true` is blocked before its entry module is read or evaluated.
- Static/dynamic use of `require`, Node built-ins, Electron, child processes, `FileSystemAdapter`, popout windows, and status-bar-only assumptions follows the declared compatibility policy and yields actionable UI.
- A mobile-compatible fixture can load, read/write via the public Vault API, register a view/command, survive suspend/resume, unload cleanly, and cannot bypass vault scoping.
- `mobileOnly`/desktop-only command visibility and platform CSS classes are correct on iPhone, iPad, and Electron.
- Restricted/safe mode still prevents plugin startup after a crash or lifecycle failure.
- Plugin failure does not block vault recovery, save, navigation, or subsequent startup.
- Claude Threads, if included in MVP, needs a dedicated mobile compatibility journey covering startup, a basic thread interaction, external link handling, suspend/resume, and explicit handling of its desktop `FileSystemAdapter`/working-directory assumptions.

Automatic detection of arbitrary Node usage cannot be treated as complete. Follow the ADR policy: unknown community plugins require explicit MVP opt-in, unsupported imports fail with a diagnostic naming the module, and startup failures automatically quarantine the plugin. Test fixtures must cover pure DOM/view, CodeMirror extension, network/Keychain secret, CSS theme, explicit desktop-only, and accidental Node import.

### 8. Web Viewer fallback

Electron's `<webview>` is not available in WKWebView. Test ADR-0007's native child-`WKWebView` `webContent` service as a capability-specific host operation:

- HTTP/HTTPS links use the approved in-app or system-browser fallback; unsupported schemes, popups, downloads, authentication handoffs, and navigation failures are explicit.
- Opening local vault HTML never silently grants it arbitrary vault/native access. Relative assets either work inside a scoped serving scheme or the UI states the limitation.
- Web bookmarks reopen through the same fallback and preserve the Geode workspace.
- Offline and permission-denied states are recoverable; returning to Geode restores the previous tab/selection.
- External URLs cannot navigate or replace the Geode application WebView.

The required path is a measured native child `WKWebView` with isolated storage. `SFSafariViewController`/Capacitor Browser is a reduced fallback only; using it requires explicit product approval to reduce the full-featured MVP exit criteria. Authentication, session-isolation, accessibility, keyboard, rotation, backgrounding, and native-overlay alignment need native tests.

### 9. Binary attachments

- Byte-for-byte read/write round trips for PNG/JPEG/GIF, PDF, audio/video fixture types, arbitrary unknown binary, empty binary, Unicode filename, and a large supported attachment.
- Image/audio/video embeds and Canvas cards display from scoped resource URLs, survive reopen, and release old object/native URLs when views close or content changes.
- Import/copy is atomic; interruption, out-of-space, permission revocation, provider timeout, and duplicate filename never leave a corrupt destination presented as complete.
- Cloud-placeholder/offline binary data is not cached as zero bytes.
- Memory use remains bounded when opening/closing large media repeatedly; define a supported file-size envelope before adding a performance gate.

### 10. Desktop Electron regression

Every mobile/shared-renderer change must pass, with clean output:

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm run build`
4. `npm run test:e2e`
5. `npm run parity:check`

Do not replace the Electron Playwright suite with browser-renderer tests. It is the only current evidence for Electron IPC, utility-process indexing, native recursive watching, `<webview>`, plugin startup, and desktop window behavior.

## Thin mobile E2E release journeys

The minimum release-candidate suite should be deliberately small:

1. **Vault continuity:** choose a vault, open a note, edit, background, force-kill, relaunch, and verify bytes plus workspace/caret recovery.
2. **External edit safety:** dirty note plus coordinated external edit produces the approved conflict experience with no lost version.
3. **Knowledge flow:** search, open a result, follow a wikilink, inspect backlinks/properties, and attach/render a binary.
4. **Power views:** open and manipulate one graph, one Canvas, and one Base; persist and reopen each.
5. **Compatibility boundary:** mobile-safe plugin loads and operates; desktop-only plugin is blocked before evaluation; safe mode recovers from a crashing fixture.
6. **Web fallback:** open an external link and a saved web bookmark, return to Geode, and confirm workspace state.
7. **Permission failure:** revoke/move the vault and prove visible recovery without writes or false success.

Run all seven on a current supported iPhone simulator and iPad simulator. Run journeys 1, 2, 5, and 7 on physical iPhone and iPad before the first external build.

## Explicit release gates

### Pull-request gate

- Host contract is unchanged or both hosts and shared fakes conform.
- New feature logic has unit coverage for success, error, boundary, and stale/concurrent cases.
- Browser-renderer mobile tests pass at one phone and one tablet viewport.
- Relevant XCTest tests pass on iPhone and iPad simulators.
- Typecheck, build, all unit tests, all existing Electron Playwright tests, and parity check pass.
- No skipped/quarantined test without an owner, issue, expiry, and release-risk statement.
- UI changes include reviewed phone/tablet screenshots and an accessibility/touch check.

### MVP release-candidate gate

- All seven mobile E2E journeys pass on supported iPhone and iPad simulators with zero unexpected console/native errors.
- Required physical-device journeys pass on at least one supported iPhone and one supported iPad.
- Security-scoped persistence and revocation pass against local Files, iCloud Drive, and one third-party File Provider.
- Zero open severity-1 issues: data loss/corruption, path escape, permission bypass, false save acknowledgement, unrecoverable startup, or mobile work breaking desktop vaults.
- Zero open severity-2 issues in vault open/save/restart, editor input, permission recovery, plugin gating, or lifecycle; other severity-2 issues require explicit product acceptance.
- VoiceOver smoke pass and no primary action below 44 by 44 points or available only by hover/right-click.
- Ten consecutive suspend/resume cycles and five force-kill/relaunch cycles on each physical device complete without lost edits, duplicated state, leaked access, or crash.
- Electron full suite passes on the release commit.
- Release build uses production entitlements/signing, and a fresh-install plus upgrade-from-prior-TestFlight migration pass succeeds.

## Evidence by delivery slice

The test plan advances with ADR-0007's vertical slices; later feature breadth cannot compensate for a missing earlier safety gate.

| ADR slice | Required QA evidence before exit |
|---|---|
| Slice 0 — boundary proof | Shared `HostServices` conformance against fake and Electron adapters; mobile bundle contains no Electron/Node imports; real renderer/CodeMirror spike reads and atomically writes a managed-vault note; background/restart persistence and 1k-note cache measurement on supported iPhone/iPad targets; full Electron gate green |
| Slice 1 — managed-vault daily core | Managed storage traversal/atomic-I/O XCTest; daily-core browser-renderer flows; phone/tablet touch, keyboard, rotation, lifecycle and device-scoped-layout tests; interruption never loses a confirmed save |
| Slice 2 — complex local views | Graph, Canvas, Bases gesture/model/persistence flows; binary attachment import/resource lifecycle; partial-index and memory-pressure recovery at representative sizes |
| Slice 3 — mobile plugins | All six representative fixture classes; install/enable/restart/update/disable/failure recovery for one real compatible plugin; desktop-only and accidental-Node code blocked before unsupported execution |
| Slice 4 — Web Viewer | Child-`WKWebView` navigation/history/reload/restore, isolation, auth, crash, overlay alignment, rotation, keyboard, accessibility and background tests; fallback is not counted as parity without scope approval |
| Slice 5 — vault continuity | Stale/revoked bookmark, balanced access, coordinated atomic mutations, foreground reconciliation, provider offline/eviction/redownload, conflict-copy safety, and two-device iCloud edit evidence |
| Slice 6 — Claude Threads | Tests derived from the separately approved provider/security ADR: pairing/sign-in, vault/tool scope, streaming, action approval, disconnect/reconnect, draft persistence, credential revocation, and lost-device behavior |
| Slice 7 — hardening/RC | Supported device/OS matrix, accessibility, performance budgets, migration/rollback, fresh install/upgrade, production signing/entitlements, durable parity evidence, and all explicit RC gates above |

Slice 0 cannot exit in the current local environment because ADR-0007 records that the required full Xcode 26/simulator toolchain is absent. Browser and fake-host evidence may progress, but native lifecycle/persistence results must come from an equipped macOS host.

## Tooling and approval gaps

The following are not present today and must be planned before implementation:

| Gap | Why needed | Approval/decision needed |
|---|---|---|
| Browser-renderer test environment | Current Vitest is Node-only and Playwright boots Electron | Adding a DOM/browser harness or dependency is testing infrastructure and a dependency/architecture choice |
| iOS XCTest/XCUITest targets and CI runner | No native project or iOS automation exists | Native project structure, supported iOS/Xcode versions, CI provider/cost, and signing credentials |
| Physical device lab/TestFlight path | Simulators do not validate Files providers, security scope, WKWebView input, memory, or lifecycle faithfully | User access to devices, Apple Developer account, bundle/signing setup, and TestFlight distribution |
| External File Provider test account/app | Required for realistic coordination/revocation | Which provider is supported for MVP and authorization to install/use it |
| Conflict-copy UX details | ADR selects copy/review and forbids overwrite, but filenames, cleanup, and review actions remain open | Product specification; the no-data-loss invariant is already mandatory |
| Web Viewer fallback exit criteria | ADR selects child `WKWebView`; system browser is explicitly reduced | Product approval only if the native viewer fails and MVP scope is reduced, plus privacy/security review |
| Claude Threads provider | Full mobile Threads cannot execute locally in WKWebView | Product/security ADR selecting paired desktop or authenticated remote service; this blocks MVP exit |
| Supported OS/device matrix | Determines keyboard/runtime compatibility and gate duration | Minimum iOS/iPadOS version, oldest device class, phone sizes, iPad multitasking expectations |
| Performance envelopes | Prevents arbitrary/flaky thresholds | Product targets for vault size, Canvas/graph nodes, attachment size, launch/search/save latency, and memory |
| CI changes, network shaping, and fault injection | Needed for deterministic lifecycle/provider/offline failures | QA may design them, but adding infrastructure or changing CI requires approval |
| Local Xcode toolchain | Current host lacks ADR-required Xcode 26/simulators | Access to an equipped macOS host before Slice 0 can exit |

Security penetration testing beyond the path/permission abuse cases above and formal load/performance testing should be separately scoped and approved.

## Flakiness controls

- Use condition/event-driven waits; never use fixed sleeps for filesystem coordination, autosave, or lifecycle assertions.
- Inject deterministic host/native failures at named boundaries and assert acknowledgement ordering.
- Give every test its own copied temporary vault, host state, and provider container; never mutate the checked-in shared vault.
- Assert persisted file bytes/model state in addition to screenshots or DOM.
- Keep network-dependent Web Viewer cases out of the normal PR path by using a local deterministic page; reserve real-service checks for release smoke tests.
- Separate simulator and real-device evidence in reports. Do not treat a simulator pass as equivalent for security scope, providers, keyboard, memory, or background execution.
- Record device, OS, app build, vault provider, locale, keyboard, orientation, and size class with every native failure artifact.

## Initial implementation order for QA

1. Freeze and test the host contract in the existing Vitest harness.
2. Add browser-renderer boot tests with fake Electron and iOS hosts.
3. Add Swift adapter tests alongside the first native bridge implementation, starting with permission and atomic I/O failures.
4. Port only the seven thin E2E journeys to simulator automation.
5. Add physical-device/provider and accessibility evidence before the first external build.
6. Keep the existing Electron suite green at every slice rather than deferring regression testing to the end.
