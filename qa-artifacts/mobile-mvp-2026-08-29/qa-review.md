# Geode Mobile MVP QA Review — 2026-08-29

## Supersession — 2026-08-30

This review preserves the findings and release recommendation as observed on
2026-08-29. Subsequent work resolved the two simulator blockers: `7d6b306`
fixed the iPad clipping defect, `81033a9` added the native XCTest/XCUITest target
and acceptance gate, and `3f938ad` stabilized that gate against dropped or
delayed WKWebView automation events. The current iPhone 17 Pro simulator gate
passes three consecutive runs with 28/28 tests each (84/84 aggregate); definitive
result bundles are retained under
`ios-mvp-artifacts/release-final-20260830-1825/`.

The historical no-go below therefore no longer describes the current simulator
state. It is not an App Store or TestFlight readiness claim: real File Provider
behavior on physical hardware, physical-device accessibility and performance,
and a reviewed real-plugin lifecycle remain unproven.

## Recommendation

**No-go for mobile MVP release and no-go for declaring Slice 3A1 fully exited.**

The browser implementation is a strong engineering checkpoint, but native iOS product behavior is not yet adequately proven. A reproducible responsive iPad defect also survives a passing test.

## Findings

### Severity 2 — iPad workspace clips editor content after rotation

After landscape → portrait and opening/closing Details, the editor shifts left. The heading `# Tablet continuity` renders only `ntinuity`, and body content is clipped similarly.

- Screenshot: `screenshots/tablet-daily-workspace-clipped.png`
- Escaping test: `tests/mobile/mobile-renderer.spec.ts:251`
- Coverage flaw: the test checks width and `window.scrollX`, but not the editor's left-edge position or content visibility.

### Severity 2 — no native UI automation suite

The Xcode project has no XCTest or XCUITest target. The native source-contract suite validates Swift source shape, and the simulator build proves compilation, but neither proves complete WKWebView behavior.

Still unproven by durable native automation:

- WKWebView lexer/WASM initialization and mobile plugin lifecycle
- CodeMirror editing, keyboard, background/foreground, and kill persistence
- document-picker and real File Provider behavior
- native Graph/Canvas gestures and Bases keyboard avoidance
- VoiceOver and physical-device touch

### Severity 2 — File Provider safety remains simulated

The current probes use browser fake storage or app-local simulator folders. They do not prove iCloud or a third-party File Provider, eviction/re-download, concurrent two-device edits, or physical-device security-scoped access.

### Severity 2 — Slice 3A1 real-plugin exit criterion is incomplete

Fixture plugins have strong Chromium coverage. A reviewed real community plugin has not completed install → enable → restart → update → disable and recovery. Native WKWebView plugin execution also remains unproven.

## Verification performed

- Focused Vitest risk suite: **95/95 passed**.
- Focused mobile Chromium: **4/4 passed** outside the macOS sandbox.
- Native iPhone simulator: app launched and rendered the workspace.
- Native iPad simulator: first screenshot showed the launch spinner; the workspace rendered after roughly 13 seconds.
- No production or test source was changed.

## Evidence

- `screenshots/phone-daily-workspace.png`
- `screenshots/tablet-daily-workspace-clipped.png`
- `screenshots/iphone-welcome.png`
- `screenshots/ipad-note.png`
- `native/native-iphone.png`
- `native/native-ipad.png`
- `native/native-ipad-after-13s.png`

## Flaky and performance risk

- Sandboxed Chromium cannot register its macOS Mach-port service; the same focused journeys pass outside the sandbox.
- One mobile plugin journey uses a fixed 1.2-second wait.
- Prior Electron history includes one Graph click retry.
- The observed native iPad cold launch took approximately 13 seconds; no formal startup budget currently exists.
