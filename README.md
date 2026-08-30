# Geode

**An open-source, local-first Markdown knowledge base** — a clean-room clone of
Obsidian built from its public documentation. Your notes are plain `.md` files
in a folder on your disk. Links between notes are first-class. No account, no
cloud, no lock-in.

> ⚠️ Early alpha (v0.10.0). The core loop works — vaults, editing, wikilinks,
> backlinks, search, tags, reading view, community plugins/themes, a Web
> Viewer — but many features are still on the
> [roadmap](docs/spec/00-overview.md).

## Features (v0.10.0)

- **Vaults** — open any folder; external edits are picked up live; manage recent
  vaults and open multiple vaults in isolated top-level windows
- **Editor** — CodeMirror 6, markdown highlighting, `[[wikilink]]` autocomplete,
  Cmd/Ctrl+click to follow, autosave, rename-updates-links, and immediate inline
  naming for new notes with collision-safe validation
- **Live Preview** — tables render in place and stay editable: cells render
  their inline markdown (bold, italic, code, links) and wrap onto multiple
  lines instead of forcing the row to overflow, while clicking into a cell
  still reveals the raw source to edit
- **Reading view** — callouts (13 types, foldable), embeds (notes/images/audio/
  video), highlights, tags, tables, task lists, YAML properties
- **Mermaid diagrams** — ` ```mermaid ` blocks render as diagrams in both Live
  Preview and Reading view, follow the active light/dark theme, support
  `internal-link` nodes that navigate to notes, and show an inline error
  instead of breaking the note when a diagram is malformed. The library is
  loaded lazily on first use, so it costs nothing until a diagram is on screen
- **Knowledge graph plumbing** — backlinks pane, outline, tag pane, unresolved
  link styling, link resolution by shortest path and alias, graph view;
  metadata is cached across launches so unchanged notes do not need re-indexing.
  File reads, Markdown parsing, and debounced atomic cache writes run in a
  background utility process, with automatic in-renderer fallback
- **Search** — `tag:` `path:` `file:` operators, quoted phrases, negation, regex
- **Canvas** — author interoperable JSON Canvas 1.0 (`.canvas`) boards with
  text, note, media, web, and group cards; create, label, reconnect, color, and
  delete edges; drag vault files, folders, and browser URLs onto the board;
  marquee/multi-select, duplicate, align, group, resize, pan/zoom, search, and
  undo/redo. Canvas note cards contribute backlinks, Canvas files embed in
  Markdown, web cards can show live previews, and malformed files open in a
  non-destructive recovery view. Inline note editing, PDF previews, and some
  broader context/action workflows are not implemented yet
- **Workspace** — movable built-in and plugin views, tabs, split panes, pinned
  tabs, vertically stacked and independently resizable sidebar groups, recursive
  layout persistence, a hideable left ribbon with persistent Settings and
  plugin-contributed actions, shared document actions across tab, view, command,
  and File Explorer menus, pinned-safe bulk tab closing, and status-bar word
  count; tab bar and view header DOM/CSS match real Obsidian so community themes
  and CSS snippets apply correctly
- **Command palette** (Cmd+P), **quick switcher** (Cmd+O), daily notes (Cmd+D),
  dark/light themes via CSS variables
- **Settings** — tabbed Settings window (Appearance, Community plugins &
  themes, plus one tab per installed plugin that calls `Plugin.addSettingTab`)
- **Community plugins & themes** — install from GitHub, enable/disable,
  auto-update; broad plugin-API compatibility (`EditorSuggest`, `Scope`,
  metadata cache with list items/sections + frontmatter tag helpers) so real
  plugins like **obsidian-tasks** load and render their query blocks
- **Plugin crash recovery** — attributes and quarantines failures at plugin
  boundaries, journals diagnostic context, and recovers a crashed renderer
  once with community plugins suppressed and reversible restart controls
- **Web Viewer** — open web pages and local `.html`/`.htm` vault files in an
  in-app tab (`webview`-backed, its own session), plus a one-time "Import
  cookies from Chrome" option so viewer tabs open already logged in. App
  hotkeys (command palette, quick switcher, tab switching) keep working while
  focus is inside a viewer tab instead of being swallowed by the page

## Install

Prebuilt macOS installers (dmg + zip, Apple Silicon + Intel) are published on
the [Releases page](https://github.com/rbcodelabs/geode/releases) whenever a
`v*` tag is pushed. Windows and Linux builds aren't set up yet — see the
[roadmap](docs/spec/00-overview.md) item for packaging.

1. Download `Geode-<version>-arm64.dmg` (Apple Silicon) or
   `Geode-<version>.dmg` (Intel) from the latest release.
2. Open the dmg and drag **Geode.app** to **Applications**.
3. **These builds are ad-hoc signed but not notarized** (no Apple Developer
   ID yet). The ad-hoc signature lets the app launch on any Mac — including
   Apple Silicon, which refuses to run fully-unsigned apps — but Gatekeeper
   still shows an "unidentified developer" warning on the first launch of a
   downloaded copy. To open it:
   - Right-click (or Control-click) **Geode.app** → **Open** → **Open** again
     in the confirmation dialog (also available under System Settings →
     Privacy & Security → **Open Anyway**), **or**
   - Run `xattr -dr com.apple.quarantine /Applications/Geode.app` in Terminal
     once, then launch normally.

   Full Developer ID signing + notarization (no warning at all) is a
   follow-up that needs a paid Apple Developer account.

## Develop

```bash
npm install
npm run build      # bundle main/preload/renderer with esbuild
npm start          # launch Electron
npm run dev        # esbuild watch mode
npm run typecheck  # strict tsc
npm run parity:check # verify the checked-in Obsidian compatibility ledger is current
npm run dist        # package a local ad-hoc-signed macOS build (dmg + zip) into release/
npm run release     # same, plus publish to GitHub Releases (requires GH_TOKEN)
```

A demo vault lives in `test-vault/`.

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
read as binary (with a 32 MiB bridge limit), and deleted items move into the
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
the `.github/workflows/release.yml` GitHub Action builds ad-hoc-signed macOS
installers and publishes them to a GitHub Release automatically. You can also
trigger it manually from the Actions tab (`workflow_dispatch`) without cutting
a tag, useful for testing the pipeline.

## Documentation

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
