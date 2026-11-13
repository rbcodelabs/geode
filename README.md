# Geode

**A free, open-source, local-first Markdown notes app. Your notes stay as plain `.md` files on your disk.**
Wikilinks, backlinks, graph view, live preview, and support for Obsidian-style community plugins and themes — with no account, no cloud, and no lock-in.

[![Latest release](https://img.shields.io/github/v/release/rbcodelabs/geode?label=release)](https://github.com/rbcodelabs/geode/releases)
[![License: MIT](https://img.shields.io/github/license/rbcodelabs/geode)](LICENSE)
[![Stars](https://img.shields.io/github/stars/rbcodelabs/geode?style=flat)](https://github.com/rbcodelabs/geode/stargazers)
[![Website](https://img.shields.io/badge/website-geode.rbcodelabs.com-blue)](https://geode.rbcodelabs.com)

[![Geode in action: create a note, add a wikilink, see backlinks, open the graph](docs/images/geode-hero.gif)](docs/images/geode-hero.mp4)

## Why Geode

- **Your files, your folder.** A vault is just a folder of Markdown. Open it in any other editor any time.
- **Open source (MIT).** Read it, fork it, fix it. A clean-room implementation built from public documentation only.
- **Knowledge graph built in.** `[[Wikilinks]]`, backlinks, outgoing links, tags, outline, graph view, and fast search.
- **Plugin and theme compatible.** Run many Obsidian-style community plugins and themes, with a supported catalog that verifies checksums before install.
- **Agent-friendly.** Inline comment threads with human/agent attribution, plus a headless `geode-wiki` CLI for scripts and AI tools.
- **Private by default.** No telemetry-driven account wall. Secrets live in your OS keychain.

> ⚠️ Early alpha (v0.30.20). The core loop works, but many features are still on the [roadmap](docs/spec/00-overview.md). macOS (Apple Silicon) builds only for now.

## Quick start

```bash
brew install --cask rbcodelabs/geode/geode
```

Open Geode, choose **Open folder as vault**, and point it at any folder of Markdown. Want to try it first? Open the bundled `test-vault/` demo vault.
Other install options (script, manual download) are [below](#install).

## What you get

| | |
|---|---|
| **Editing** | CodeMirror 6 editor, Live Preview, Reading view, tables, callouts, Mermaid diagrams, footnotes |
| **Linking** | Wikilink autocomplete, rename-updates-links, backlinks, page previews, graph view |
| **Organizing** | Properties, tags, search, quick switcher, command palette, custom hotkeys |
| **Extending** | Community plugins and themes, supported plugin catalog, in-app Web Viewer |
| **Collaboration** | Markdown comment threads, GitHub connection, experimental sync |

See the full [feature reference](docs/features.md) and [release history](https://geode.rbcodelabs.com/changelog/).

## Contributing

Issues and PRs are welcome. Build from source in a minute — see [Develop](#develop). Good places to start: the [roadmap](docs/spec/00-overview.md) and the open issues labeled `good first issue`.

If Geode is useful to you, a ⭐ helps other people find it.

## Install

Prebuilt macOS installers (dmg + zip, Apple Silicon only) are published on
the [Releases page](https://github.com/rbcodelabs/geode/releases) whenever a
`v*` tag is pushed. Windows and Linux builds aren't set up yet — see the
[roadmap](docs/spec/00-overview.md) item for packaging.

### Install via Homebrew

```bash
brew install --cask rbcodelabs/geode/geode
```

The cask lives in the [rbcodelabs/homebrew-geode](https://github.com/rbcodelabs/homebrew-geode)
tap and installs the same signed, notarized Apple Silicon build from the
Releases page. It is bumped automatically after each release. Geode also
updates itself in-app; `brew upgrade --cask geode` works too.

### Install/update via script

`scripts/geode-update.mts` installs the latest release, or updates an
existing install, in one command. It talks to the public GitHub API directly
(no `gh` CLI, no account, no auth needed — this repo is public) and
verifies the release's Developer ID signature, stable Apple Team ID and bundle
ID, hardened runtime, Gatekeeper acceptance, and stapled notarization ticket
before replacing an install. It preserves Apple's signature and leaves the
current app in place if verification or staging fails. Requires an Apple Silicon Mac and
native arm64 Node.js 23.6+. Intel Macs can continue using their last compatible
release, but receive no new builds. Run it straight from GitHub, no clone required:

```bash
curl -fsSL https://raw.githubusercontent.com/rbcodelabs/geode/main/scripts/geode-update.mts -o /tmp/geode-update.mts && node /tmp/geode-update.mts
```

Or, from a checkout: `node scripts/geode-update.mts`. Useful flags:

```bash
node scripts/geode-update.mts --check      # report installed vs. latest version, change nothing
node scripts/geode-update.mts --force      # reinstall even if already up to date
node scripts/geode-update.mts --version X  # install a specific release, e.g. --version 0.12.0
node scripts/geode-update.mts --user       # install to ~/Applications instead of /Applications
node scripts/geode-update.mts --keep       # keep the downloaded dmg in ~/Downloads
node scripts/geode-update.mts --help       # full usage
```

### Install manually

1. Download `Geode-<version>-arm64.dmg` for Apple Silicon from the latest release.
2. Open the dmg and drag **Geode.app** to **Applications**.
3. Launch Geode normally. Release builds are Developer ID signed, hardened,
   notarized, and stapled; do not remove quarantine metadata or re-sign them.

### Updates and the first signed release

Existing ad-hoc-signed installations must install the first Developer ID
release manually (drag from the dmg or run the script above) to establish the
trusted signing baseline. Releases after that baseline check quietly in the
background. Geode always asks before downloading and asks again before
restarting to install. **Help → Check for Updates…** runs a manual check. If
an approved download or install fails, Geode offers the Releases page as a
recovery path.

Release operators provision a protected GitHub environment named
`macos-release` with `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and
`APPLE_TEAM_ID`. `CSC_LINK` is the base64-encoded Developer ID Application
certificate/private-key `.p12`; `APPLE_API_KEY_BASE64` is a base64-encoded
team App Store Connect API `.p8`. The checked-in `EXPECTED_TEAM_ID` in
`scripts/geode-update.mts` pins RB Code Labs LLC's publisher identity to
`6M8F464WCQ`. The workflow rejects an `APPLE_TEAM_ID` secret that differs
from this pin. The workflow refuses unsigned builds or
incomplete credentials, verifies every packaged app, and publishes an update
feed only after the draft release has the complete artifact inventory.

## Develop

The internal [read-only local wiki engine](docs/design/local-wiki-usage.md)
opens a bounded folder snapshot in plain Node for metadata, literal search,
strict link resolution and backlinks. Results disclose ambiguity and incomplete
parsing. Run `npm run proof:local-wiki` for its fresh-Node acceptance demo.

The [Geode Headless Phase 0 report](docs/design/headless-phase0.md) documents
the portable parser/resolver extraction and disposable PostgreSQL transaction
proof. Run `npm run proof:headless` for the Node-only proof; this is an engineering
spike, not a released cloud service.

```bash
npm install
npm run build      # bundle main/preload/renderer with esbuild
npm start          # launch Electron
npm run fresh      # launch an isolated first-run instance (build first)
npm run dev        # esbuild watch mode
npm run typecheck  # strict tsc
npm run parity:check # verify the checked-in Obsidian compatibility ledger is current
npm run dist        # package a signed/notarized macOS build (requires release credentials)
npm run release     # same, plus publish (prefer the protected GitHub workflow)
```

A demo vault lives in `test-vault/`.

### Test a first run

`npm run fresh` launches Geode as if it had never been installed: empty app data
and an empty Documents folder, so nothing from your real install or an earlier
dev run leaks in. Run `npm run build` first; the command does not build.

```bash
npm run fresh            # temp dirs are deleted when you quit
npm run fresh -- --keep  # keep them, to inspect config or the Starter Vault
```

On first run Geode shows the vault picker; clicking "Try the sample vault" creates
and opens a `Geode Starter Vault`. That folder lives in the OS Documents directory, which `--user-data-dir` does not redirect, so the
script points `GEODE_DOCUMENTS_DIR` at a temp folder too. Your real
`~/Documents/Geode Starter Vault` is never touched. The temp dirs are named
`fresh-instance-*` rather than `geode-*` because `npm run e2e:kill` reaps
`geode-*` dirs and their processes.

### Develop the iOS shell

The iOS shell requires Node 22 or newer and Xcode 26.5. Build the portable
renderer, synchronize it into the generated Capacitor project, and compile
without changing the machine-wide Xcode selection:

```bash
npm run build:mobile
npm run ios:sync
DEVELOPER_DIR=/Applications/Xcode-26.5.0.app/Contents/Developer \
  xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /private/tmp/geode-ios-debug-derived build
```

The native managed-core acceptance gate creates an ephemeral iPhone 17 Pro
simulator, builds the shared `App` scheme, and runs the XCUITest journey three
times by default:

```bash
scripts/ios-mvp-acceptance.sh
```

The checked-in runner uses the native Capacitor adapter and real
WKWebView/CodeMirror interaction. It proves `managed://default`, root-level note
discovery without a synthetic `Vault` wrapper, touch-open/edit/new-note flows,
exact bytes after process termination and relaunch, safe-area containment, and
zero captured JavaScript/native smoke errors. The recorded final simulator gate
passed three consecutive runs with 28/28 tests each (84/84 aggregate). Result
bundles and screenshots are retained under ignored `ios-mvp-artifacts/` paths.

`dist/mobile/` is the self-contained web directory bundled by Capacitor. The
browser build intentionally keeps a localStorage-backed proof adapter for
deterministic Chromium testing. On native iOS, Geode instead uses its first-party
Capacitor vault adapter. “On this device” is backed by `Documents/Geode Vault`
inside the app container; “Choose folder in Files” uses a protected persisted
security-scoped bookmark and an opaque `external://…` identity. Cancel keeps the
current vault untouched, and a missing, unavailable, or revoked folder presents
an exact-vault Reconnect action instead of silently selecting an empty vault.
Native note bytes use coordinated atomic replacement, attachments are
read as binary (32 MiB per bridge call; sync moves larger files up to 100 MiB in chunks), and deleted items move into the
recoverable, normally hidden `.geode-trash` area under the active root. Renderer
and plugin APIs receive only normalized vault-relative paths and stable opaque
vault identities—never absolute URLs or bookmark bytes. Security-scoped access
is released on vault close and scene disconnect.

The phone workspace uses a five-action bottom navigation bar—Files, Search, New
note, Details, and More—contained within the native safe areas. Editor, drawers,
dialogs, and Settings respond to compact phone widths and wider tablet layouts;
Settings keeps its primary controls reachable above the home indicator and
software keyboard.

Each trash record contains the original vault-relative path, trash timestamp,
and untouched payload bytes. Slice 1C preserves everything needed for recovery;
an in-app restore browser is not part of this slice yet.

Slice 5A's deterministic simulator probe exercises the same bookmark registry,
stale refresh, moved/missing/revoked-folder states, coordinated I/O, and balanced
access lifecycle using a local Files-equivalent folder. It is not release proof
for iCloud Drive or a third-party File Provider. Its picker-cancel result and
security-scope start/stop counts are DEBUG seam simulations, not delegate-level
UI automation or physical-provider evidence.

Slice 5B1 adds deterministic foreground and explicit-refresh reconciliation.
For failed refreshes, see [vault refresh troubleshooting](docs/vault-refresh-troubleshooting.md)
for cause-specific guidance, preservation limits, and privacy-safe diagnostics.
Autosave pauses until an authoritative scan completes or reaches a visible,
recoverable state; incomplete scans retain the prior device-local manifest and
cannot synthesize deletes. A clean open note reloads provider bytes in place. If
the provider changes a dirty note, Geode preserves the provider version at the
original path and writes the local editor text to a collision-safe
`(Geode conflict …)` sibling. If that copy fails, the local text remains in
device recovery storage and is restored read-only after relaunch; if device
recovery storage also rejects the write, the editor stays read-only with an
explicit memory-only warning until the user retries. A physical iPhone pass
confirmed that canonicalizing the `/var` app-container alias to `/private/var`
keeps managed-vault entries at the real root: `Welcome.md` and newly created
notes open without a duplicate `Vault` subtree. Real iCloud two-device evidence,
third-party-provider eviction/re-download and offline behavior, delegate-level
picker automation, and the broader physical-device matrix remain Slice
5B2/release gates.

The current Capacitor adapter obtains that authoritative snapshot through one
native recursive `list` call. Renderer application is yielded in bounded
batches, but provider enumeration itself is not yet paged or cancellable.
Large-vault paging/cancellation and partial native scan checkpoints are an
explicit Slice 5B2 scalability gate; 5B1 does not claim them.

Slice 2A1 gives the shared Graph renderer a touch-specific pointer state
machine: tap selects, a second tap or the visible Open action opens a note,
empty-space drag pans, and two-pointer centroid gestures pan and zoom within
bounded limits. Mobile Graph controls expose search, linked-node filtering,
folder grouping, local/global mode, relayout, and fit with 44px targets. The
browser proof covers iPhone/iPad pointer cancellation, background release,
rotation, and device-local camera/selection restoration. This renderer-only
slice does not claim physical multi-touch, VoiceOver ordering, or large-vault
performance evidence; those remain release gates. The current metadata model
does not expose a trustworthy partial-index progress signal, so the Graph UI
does not fabricate one.

Slice 2A2 adds touch-native Canvas interaction to the same JSON Canvas model:
tap selection, thresholded card dragging, two-pointer viewport pan/pinch, and
rollback on cancellation or backgrounding. Mobile action surfaces expose text
and vault-file creation, editing, duplication, deletion, connection, color,
select-all, and undo/redo with 44px targets and visual-viewport keyboard
avoidance. Touch-sized edge paths and endpoints support selection and reconnect,
and transparent connection/resize hit areas stay at least 44px at every supported
zoom without changing visible or serialized geometry. Transient connections cancel
on pointer loss, backgrounding, view disposal, or reconciliation pause. Canvas bytes
and history advance only after an acknowledged vault write; the visible save
status exposes a contextual retry after failure. External deletion closes a
clean Canvas, while an in-progress local gesture is preserved as a read-only
conflict copy and cannot recreate the removed path. Chromium covers these
journeys on iPhone and iPad profiles, including rotation and reload. Physical
multi-touch, VoiceOver order, software-keyboard behavior in WKWebView, and
large-canvas gesture/render performance remain release gates.

Slice 2A3 makes Bases a deliberate touch workflow rather than a squeezed
desktop table. Phone and tablet layouts provide axis-locked table scrolling,
tap selection with explicit edit/open actions, accessible filter/sort/property
panels, and a Cards layout whose primary actions remain visible above the
software keyboard. Source-note frontmatter is only reported Saved after its
vault write is acknowledged; failures retain the draft and expose Retry.
Provider changes or deletion during a dirty cell edit preserve the local
frontmatter as a read-only conflict copy without recreating a deleted note.
Mobile Table and Cards DOM rendering is capped at 200 results with an honest
result notice, while desktop rendering remains unchanged. Chromium covers the
journey with iPhone and iPad profiles, including rotation, backgrounding,
failure recovery, reconciliation, and 44px controls. Physical-device touch and
software-keyboard behavior, VoiceOver ordering, and large-Base performance are
still release gates.

Slice 3A1 admits installed vault plugins into the mobile renderer before any
plugin entrypoint is read or evaluated. Manifests explicitly marked compatible
can load immediately, desktop-only manifests remain blocked, and legacy
manifests require a per-vault mobile opt-in. The mobile CommonJS resolver exposes
only the approved Geode/Obsidian, CodeMirror, and Lezer modules; Node, Electron,
native addons, and unknown modules fail with stable diagnostics that do not
disclose host paths. A bounded, initialized module lexer rejects static imports,
dynamic imports, `import.meta`, and ESM exports before plugin code is compiled or
evaluated; its WebAssembly is inlined in the bundle with no runtime sidecar fetch.
Startup failures and mobile startup timeouts quarantine the exact plugin for the exact
vault/device state, remove partial registrations, and provide retry/disable
recovery. Enable, disable, restart, vault switching, and update rollback preserve
one active registration set; rollback swaps the manifest, entrypoint, and exact
stylesheet presence as one host-owned operation and awaits old plugin view closure.
On native iOS, plugin discovery, bounded file reads, and those exact-file swaps
run through the first-party managed-vault bridge against the active managed or
Files-provider root. The bridge keeps vault URLs and absolute paths native-only,
validates plugin-relative paths, and coordinates each update as one rollback-safe
directory replacement rather than a sequence of renderer writes.
Because admitted plugins execute as trusted browser
code, the mobile bundle permits dynamic CommonJS evaluation and is not a security
sandbox; admission and the restricted resolver are compatibility/trust gates.
Native request brokering, Keychain-backed secrets, community catalog installation,
and evidence from real third-party plugins remain Slice 3A2 gates.

### Cutting a release

Push a tag matching `v*` (e.g. `git tag v0.1.0 && git push origin v0.1.0`) —
the `.github/workflows/release.yml` GitHub Action signs, notarizes, verifies,
and staples the Apple Silicon macOS build. It uploads into a draft and publishes
only after the complete artifact inventory is present. A protected
`macos-release` environment must approve credential access. A manual Actions
run (`workflow_dispatch`) builds and verifies without publishing.

## Documentation

The [experimental plugin sync API](docs/plugin-sync-api.md) supports conditional
transports and immutable causal history, with explicit setup, previews, and
guarded local application. Test only with disposable vault copies. The Google
Drive provider remains disabled in distributed beta builds until authenticated
multi-client and durability gates pass; this is not a production sync service.

Sync previews show pending changes. After an immutable-history sync, the summary
shows remaining work—not completed transfer totals—and reports “Up to date” only
when the controller confirms it. First-sync approval instructions appear only
while approval is still required.

The full reverse-engineered specification of the target feature set lives in
[`docs/spec/`](docs/spec/00-overview.md) — core app behavior, all 30 core
plugins, the plugin API surface, and on-disk file formats. It doubles as the
project roadmap. The generated
[`docs/spec/parity-ledger.json`](docs/spec/parity-ledger.json) tracks individual
public Obsidian requirements and their verification status; it is a coverage
baseline, not a claim of complete compatibility.

## Legal

Geode is a clean-room implementation based solely on publicly available
documentation. It contains no Obsidian code or assets. "Obsidian" is a
trademark of Dynalist Inc.; this project is not affiliated with or endorsed by
them. Licensed under the [MIT License](LICENSE).
