# Spec: Geode Mobile MVP — Slice 1B Capacitor iOS Shell

**Status:** Approved by the 2026-08-28 mobile MVP plan and
[ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md).

**Approach:** Package the verified mobile renderer as a self-contained web asset directory,
add Capacitor v8 to the existing project, generate the iOS platform, and prove that the real
shared App/CodeMirror workspace compiles, launches, edits, backgrounds, relaunches, and
restores inside WKWebView on iPhone and iPad Simulator.

## Files affected

- `package.json` / `package-lock.json` — current verified Capacitor core/CLI/iOS packages
- `capacitor.config.ts` — app id, product name, and generated mobile `webDir`
- `esbuild.config.mjs` or a small build script — self-contained `dist/mobile/` assets
- `ios/` — generated Capacitor iOS project, privacy/launch configuration as required
- `tests/mobile/` and native smoke automation/scripts — lifecycle and persistence evidence
- `README.md` — reproducible native development commands and explicit Xcode path handling

## Key decisions

- Use Capacitor v8's generated native project; do not hand-roll a WKWebView container.
- Use `com.rbcodelabs.geode` unless the generated target requires a development suffix.
- `dist/mobile/` is self-contained: HTML, CSS, renderer JavaScript, and required static assets
  use paths valid inside Capacitor's bundled web directory.
- This shell slice uses the Slice 0 proof storage adapter only to validate WKWebView boot and
  lifecycle. It is not production vault storage and must be visibly/documentarily classified.
- Commands use task-scoped
  `DEVELOPER_DIR=/Applications/Xcode-26.5.0.app/Contents/Developer`; no global `xcode-select`
  mutation is required.
- No signing, TestFlight, File Provider, or App Store claim is made in this slice.

## Riskiest assumptions

1. The shared renderer and CodeMirror behave correctly in iOS WKWebView, including software
   keyboard and viewport changes.
2. The generated Capacitor project can consume Geode's self-contained mobile build without
   leaking Electron/Node inputs or relying on `file://` paths that only Chromium accepts.

## Out of scope

- Production Swift managed-vault and security-scoped File Provider implementation.
- Native child Web Viewer, plugin native services, Threads execution, signing, and release.
- Claiming localStorage is durable vault storage.

## Done when

- Current official Capacitor package/API versions are verified before installation.
- `npm run build:mobile` creates a self-contained `dist/mobile/` and preserves the automated
  zero-Electron/Node boundary audit.
- Capacitor sync succeeds and the generated iOS project compiles through Xcode 26.5.
- The app launches on one supported iPhone and one iPad simulator, shows the real adaptive
  workspace/CodeMirror, edits a note, backgrounds/foregrounds, terminates/relaunches, and
  restores the proof note/workspace.
- Simulator screenshots and logs contain no unexpected JavaScript/native errors.
- Typecheck, unit tests, mobile Chromium tests, full build, parity, and Electron E2E remain green.
