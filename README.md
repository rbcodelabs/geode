# Geode

**An open-source, local-first Markdown knowledge base** — a clean-room clone of
Obsidian built from its public documentation. Your notes are plain `.md` files
in a folder on your disk. Links between notes are first-class. No account, no
cloud, no lock-in.

> ⚠️ Early alpha (v0.18.0). The core loop works — vaults, editing, wikilinks,
> backlinks, search, tags, reading view, community plugins/themes, a Web
> Viewer — but many features are still on the
> [roadmap](docs/spec/00-overview.md).

## New in v0.18.0: shared wiki foundations and bounded cache loading

Desktop link navigation and the internal Node wiki snapshot now use the same
candidate-selection machinery, with separate policies preserving desktop
compatibility and strict ambiguity reporting. This is a
[desktop link-resolution milestone](docs/design/shared-engine-desktop-resolution.md),
**not a full desktop backend migration**. The
[read-only Node API](docs/design/local-wiki-usage.md) supports folder snapshots,
metadata, literal search, links and backlinks without Electron; it is internal
tooling, not a published SDK, cloud service or replacement desktop application.
The [headless extraction report](docs/design/headless-phase0.md) describes the
portable foundation and its plain-Node proofs.

Persisted desktop metadata now loads through session-bound snapshot pages of at
most 50 examined rows and 256 KiB per response. Newer edits and deletions take
precedence; omitted entries are recovered with yielded file reads. Startup
database initialization is ordered before the utility indexer starts. These
bounds reduce the size of individual cache transfers, not all indexing or
rendering work. See [bounded cache hydration](docs/large-vault-benchmark.md#bounded-desktop-cache-hydration).

New synthetic-vault tooling generates linked and dense workloads and compares
baseline/candidate runs with same-revision controls. The
[benchmark safeguards](docs/large-vault-benchmark.md#methodology-v2-safeguards)
separate terminal indexing readiness from correctness validation, monitor owned
process RSS independently, and retain failed samples. The default memory limit
is half physical RAM; failures are not replaced with successful retries.

**Large-vault limits remain.** In the three-pair synthetic comparison, 10,000-note
warm startup was slower by paired medians of approximately 2.6 seconds for the
linked profile and 11.9 seconds for the dense profile. At 50,000 notes, every
linked-profile sample failed on both revisions. All three dense-profile
candidate samples passed, while all three baseline samples failed. The failures
involved renderer-watchdog recovery; bounded hydration does not eliminate every
stall. These measurements are not a blanket speedup, a production guarantee, or
a claim that 50,000-note vaults are now reliably supported. See the
[benchmark methodology and limitations](docs/large-vault-benchmark.md).

## New in v0.17.3: Canvas media cards render again

**A Canvas card pointing at an image, audio or video file could come up blank
and stay blank.** Every path that opens a Canvas renders the whole board
*before* the view is attached to the document. A card's file read that happened
to finish inside that window was discarded as belonging to a stale render — and
because nothing re-rendered after the view was attached, the card never
recovered. It was a race, so it struck under load and looked intermittent:
reopening the same board could show the media or not.

Liveness is now decided by whether the node still belongs to the view being
rendered, rather than by whether it had already been inserted into the document,
so a card rendered ahead of attachment is filled in correctly. The read-failure
path is also no longer discarded alongside it: a file that genuinely cannot be
read now always shows the visible "Could not load file" fallback instead of
leaving an empty card and no explanation.

## New in v0.17.2: comment on headings, list items and table cells

**Comments are no longer limited to ordinary paragraphs.** You can now anchor a
thread to prose inside a heading, a list item (bullet, ordered, task, nested) or
a table cell. Previously any text that was not a plain paragraph was refused:
the rule protected *every* node that was not a paragraph, so the words in a
heading were treated as untouchable along with the `#` that made it one.

Only the structural syntax itself is off-limits now — a heading's `#`, a list
bullet or `[ ]` checkbox, a table's `|` separators and its delimiter row. Code,
links, images, math, raw HTML, blockquotes and Obsidian comments are still
protected in full. And a selection that merely *straddles* structural syntax —
a triple-click that sweeps up a heading's `#`, or a drag starting on a bullet —
is now trimmed automatically to the prose it covers rather than rejected
outright. When a selection genuinely has nothing commentable left in it, the
rejection names the specific reason instead of failing generically.

Widening this surfaced two defects that had been latent all along:

- **Live Preview decorations could silently disappear.** Comment markers begin
  with `<!--`, which is CommonMark's HTML-block start condition, so a marker at
  a line's first content position made the parser treat the whole line as an
  HTML block — dropping that line's list and heading decorations. This already
  affected plain paragraphs; it simply had never been hit, because nothing else
  reads the unstripped document.
- **A commented heading broke its own links.** Heading text is extracted from a
  copy in which markers are masked to spaces to keep offsets stable — correct
  for positions, wrong for text. A commented heading yielded heading text with
  a run of spaces buried in it, which broke `[[Note#Heading]]` resolution,
  heading bookmarks and transclusion.

One known limit: a comment anchored inside a **table cell** shows no inline
highlight in Live Preview, because tables are rendered there as a widget rather
than as decorated source, leaving no source text to highlight — the same reason
Reading view never highlights anchors. The thread itself is unaffected; it
persists in the note, appears in the Comments pane, and replies and resolves
normally.

## New in v0.17.1: plugins can use `fetch()`, and links into Project folders open in-app

**Plugins that call `fetch()` directly now work.** Geode's renderer runs under a
deliberately strict `default-src 'self'` policy, and plugin code executes in that
same renderer — so a plugin calling the ambient `fetch()` was blocked from
reaching any remote origin. `requestUrl` already avoided this by doing the real
request in the privileged main process, but plugins cannot always use it: its
body type is `string | ArrayBuffer`, which cannot carry a `FormData` multipart
upload. Anything uploading a file — audio to a transcription endpoint, an image
to an API — had no working path at all, and failed with a bare network error.

Plugin bundles now get their own privileged `fetch`, mirroring `requestUrl`'s
transport: the body (including a `FormData` boundary) is serialized in the
renderer, sent to the main process, and issued there, with a spec-compliant
`Response` handed back. **The content security policy is unchanged and
`window.fetch` is untouched** — the identifier is shadowed only inside a
plugin's own compiled bundle, so nothing else in the app gains network reach.

**Links into attached Project folders open in Geode, not the OS.** Clicking a
file link pointing into an attached read-only Project folder opened it in the
system default app, and attaching the folder appeared to change nothing — while
the *same* file reached through the Projects tree opened correctly in the
in-app viewer. `open-local-file` only tested containment against the vault root,
so an explicit user grant had no effect on link handling. It now classifies the
path against the roots the window exposes and routes to the read-only viewer.
Containment is decided on **canonical real paths**, so a symlink cannot widen a
grant, and only roots bound in the current vault session are eligible.

See the [plugin API reference](docs/spec/03-plugin-api.md).

## New in v0.17.0: secrets in the OS keychain, and six plugin-API fixes

**Plugin secrets now live in the OS keychain.** `app.secretStorage` previously
persisted secrets as plaintext in `localStorage` — so an API key a plugin stored
sat in the clear on disk, even where the plugin's own UI told the user it was
keychain-protected. Secrets are now encrypted through Electron's `safeStorage`
and written as ciphertext, and `isEncryptionAvailable()` reports the real
answer instead of a hardcoded `false`. **Existing `geode:secret:*` entries
migrate automatically on first access and are removed from `localStorage`.**
Where no keychain backend exists (some Linux setups), Geode falls back to the
previous behaviour and says so honestly rather than pretending.

**Five other divergences from Obsidian's API, all found by auditing a real
plugin against the shim.** Each was the same failure mode: an API that returned
successfully and quietly did the wrong thing, leaving the plugin no way to
detect it and the user nothing to see.

- `SecretComponent` now takes Obsidian's `(app, containerEl)` and renders a
  picker **button**, not a password input — the previous signature threw inside
  the caller's click handler, so the button did nothing at all.
- `obsidian://` deep links now reach Geode, so a plugin's
  `registerObsidianProtocolHandler` callbacks fire. Registration is deliberately
  **non-hijacking**: Geode claims the scheme only when nothing else answers it,
  advertises itself as a `Viewer` rather than an owner, and leaves an existing
  Obsidian install untouched. `GEODE_CLAIM_OBSIDIAN_PROTOCOL=1` forces it.
- `Vault.adapter.rmdir()` exists, so plugins can clean up their own
  directories. It removes directly rather than trashing, and refuses anything
  resolving outside the vault, the vault root itself, or a symlink pointing out
  of the vault.
- `sanitizeHTMLToDom` strips `on*` handlers, `javascript:`/`vbscript:` URLs and
  `iframe`/`object`/`embed`/`link`/`meta`/`base`, not just `<script>`. Policy
  tracks DOMPurify's stock configuration, so `<style>`, `<form>` and
  `data:image/…` still render.
- `WorkspaceLeaf.openFile` honours `eState.subpath`, so heading and block
  anchors scroll to their target — including when a plugin opens one *before*
  the metadata cache has finished indexing, which previously returned no match
  and silently landed at the top of the file.

See the [plugin API reference](docs/spec/03-plugin-api.md).

## New in v0.16.0: a supported plugin catalog, and two new plugin events

**Install certified plugins without hunting for a repository.** Settings →
Community plugins & themes now lists a supported catalog. Installing a *tested*
release verifies the manifest and the SHA-256 of every runtime artifact before
replacing any file, then pins that version. Choosing *latest* instead requires
an explicit unverified acknowledgement and leaves the install unpinned. The
catalog is fetched with an 8-second timeout and a 256 KiB cap, and an atomic
last-known-good cache keeps it usable when a refresh fails. The manual GitHub
installer is still there.

**Plugins can now populate Geode's context menus.** The `file-menu` and
`editor-menu` workspace events fire, so a plugin can add its own items to a
file's context menu in the explorer or to the editor's menu.

**Plugins can react to a web app running in the Web Viewer.** A cooperating
"connector" page can call `window.__geode.postEvent(type, payload)`, and Geode
re-emits it on the workspace bus as `web-viewer:event`. Geode's main process
checks the posting frame's origin against an allowlist and validates the event
type, serializability and payload size before anything reaches a plugin — the
guest is never trusted about which page it is. Canvas link previews run in
their own session precisely so that merely *viewing* a canvas can never stand
up such a bridge. See the [plugin API reference](docs/spec/03-plugin-api.md).

## New in v0.15.2: a unified file explorer

External Projects now share one scrolling panel with vault files. Matching
headers, standard folder and file rows, and quieter refresh and detach actions
keep the explorer consistent across narrow and wide sidebars and light/dark themes.

## New in v0.15.1: preserved Web Viewer history

Opening another URL in the same Web Viewer tab now keeps its live browser and
Back/Forward history. Rapid navigation and redirects preserve the newest
requested URL, and a later navigation can restore the viewer after its browser
process exits.

## New in v0.15.0: interactive Bases views for plugins

A community plugin can now provide a Bases view that **writes to the vault**, not
just renders one. `kanban-bases-view` runs unmodified in Geode: drag a card
between columns and the note's frontmatter is rewritten on disk; the per-column
**+** creates a note in the view's configured folder with that column's value
already set; middle-click opens a card's note behind the board and a plain click
opens it in place; card cover images resolve and load.

The plugin API surface behind that grew accordingly —
`BasesView.createFileForView`, `Vault.getResourcePath(file)`,
`Workspace.getMostRecentLeaf()`, `Workspace.setActiveLeaf(leaf, { focus })` and
`Workspace.getLeaf(PaneType | boolean)` — and `GEODE_API_VERSION` advertises
**1.10.2** (from 1.8.0), so plugins gating on the host's API version see the
Bases surface they require.

Where Geode cannot honour a request exactly it refuses loudly rather than
guessing: `createFileForView()` with no file name, a folder that does not exist,
or a path escaping the vault all reject instead of writing a note somewhere the
user did not configure; `getLeaf('window')` throws rather than substituting a
tab. See the [plugin API reference](docs/spec/03-plugin-api.md).

## Features (v0.17.0)

- **Keychain-backed plugin secrets** — `app.secretStorage` encrypts through the
  OS keychain via Electron `safeStorage`, migrating any previously stored
  plaintext entries and reporting honestly when no backend is available.

- **Supported plugin catalog** — install certified plugins from Settings →
  Community plugins & themes. Tested releases verify the manifest and the
  SHA-256 of every runtime artifact before replacing files, then pin the
  installed version; choosing latest requires an explicit acknowledgement.

- **Image tabs** — open vault images from File Explorer, Markdown links, or
  plugins in a read-only image view. Images fit within the pane, use normal tab
  navigation, and restore when the workspace reopens.

- **[Markdown comments](docs/design/markdown-comments-v1.md)** — passage-anchored
  threads with replies, resolve/reopen, human/agent attribution, and detached-anchor
  recovery. Select text and press <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> (or
  run *Comments: Add comment to selection*); headings, list items and table cells
  can be annotated as well as ordinary prose. Comments travel inside the note;
  Live Preview and Reading view hide their markers, while Source mode exposes them.

- **Vaults** — open any folder; external edits are picked up live; manage recent
  vaults and open multiple vaults in isolated top-level windows
- **Editor** — CodeMirror 6, markdown highlighting, `[[wikilink]]` autocomplete,
  Cmd/Ctrl+click to follow, autosave, rename-updates-links, and immediate inline
  naming for new notes with collision-safe validation
- **Live Preview** — safe same-vault standard Markdown images render in place
  away from the cursor, alongside existing wiki image embeds; remote images,
  PDFs, block embeds, and interactive image resizing remain out of scope.
  Tables stay editable: cells render
  their inline markdown (bold, italic, code, links) and wrap onto multiple
  lines instead of forcing the row to overflow, while clicking into a cell
  still reveals the raw source to edit
- **Reading view** — callouts (13 types, foldable), embeds (notes/images/audio/
  video), highlights, tags, tables, task lists, YAML properties
- **Page previews** — safely inspect resolved internal Markdown links without
  navigating away: hover in Reading View, or hold Cmd/Ctrl while hovering a
  rendered link in Live Preview. Previews are read-only, honor heading targets,
  and do not appear for external, unresolved, or active-line raw source links
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
- **Workspace** — movable built-in and plugin views, tabs, named/color-coded
  split-local tab collections with persistent collapse state, split panes with
  pointer- and keyboard-resizable persisted proportions, pinned tabs, vertically
  stacked and independently resizable sidebar groups, recursive layout persistence,
  independent session-only back/forward document history in each tab,
  [durable companion splits](docs/design/companion-panes.md) for plugins that
  feature-detect Geode's workspace extension,
  a hideable left ribbon with persistent Settings and
  plugin-contributed actions, shared document actions (including reveal-in-Finder/
  system-file-manager) across tab, view, command, and File Explorer menus,
  pinned-safe bulk tab closing, and status-bar word
  count; tab bar and view header DOM/CSS match real Obsidian so community themes
  and CSS snippets apply correctly
- **Command palette** (Cmd+P), **quick switcher** (Cmd+O), and Daily Notes (Cmd+D) with per-vault enable, folder, date-format, and template-path settings,
  dark/light themes via CSS variables
- **Settings** — tabbed Settings window with searchable **Hotkeys**, Appearance,
  Community plugins & themes, and an **Advanced** per-vault metadata body-scan
  cap (300 KB by default). Oversized note bodies skip heading, tag, link, and
  list-item indexing to bound memory use; frontmatter remains indexed. Installed
  plugins can add their own tabs with `Plugin.addSettingTab`
- **Community plugins & themes** — install from GitHub or safely import from
  an existing Obsidian vault without overwriting installed items or changing
  their enabled state; browse a fail-closed supported-plugin catalog whose
  default installs are pinned to tested release bytes (with an explicit
  unverified opt-in for the latest upstream release); enable/disable,
  auto-update; broad plugin-API compatibility (`EditorSuggest`, `Scope`,
  `BaseComponent`, `ValueComponent`, `AbstractTextComponent`, `SearchComponent`,
  metadata cache with list items/sections + frontmatter tag helpers) so real
  plugins like **obsidian-tasks** load and render their query blocks. Editor
  command callbacks work, but currently receive CM6's `EditorView` rather than
  Obsidian's full `Editor` adapter. `FileManager.processFrontMatter` safely
  serializes same-file calls within one renderer runtime; it does not lock out
  direct vault/external writes, and forwarded timestamp options are not yet
  applied by the host. **Minimal Theme Settings 9.0.0** is certified on desktop,
  including its settings controls and theme/font preferences. This exact-version
  exception preserves the global Obsidian API baseline at 1.8.0; newer Minimal
  Settings versions and other plugins requiring 1.13 remain unverified.
  Desktop plugins can make HTTP(S) requests through `requestUrl()`, including
  text, JSON, and binary responses; requests use the main process while raw
  renderer `fetch()` remains subject to the existing Content Security Policy
- **Plugin crash recovery** — attributes and quarantines failures at plugin
  boundaries, journals diagnostic context, and recovers a crashed renderer
  once with community plugins suppressed and reversible restart controls.
  Heartbeat monitoring pauses during system sleep and gives the renderer a
  fresh grace period on wake, preventing false recovery caused by suspension
- **Web Viewer** — an enabled-by-default, per-vault core plugin for opening web
  pages and local `.html`/`.htm` vault files in an in-app tab (`webview`-backed,
  its own session). Updating the URL in the same viewer preserves its live
  browser and Back/Forward history. Disabling it preserves open viewer tabs for later restore.
  Web links requesting a new window open as tabs in the source tab group;
  background openings preserve your current tab selection. Popup destinations
  must use HTTP or HTTPS.
  It also includes a one-time "Import
  cookies from Chrome" option so viewer tabs open already logged in. App
  hotkeys (command palette, quick switcher, tab switching) keep working while
  focus is inside a viewer tab instead of being swallowed by the page

## Customize keyboard shortcuts

Open **Settings → Hotkeys** to search every registered core and plugin
command. Select **+**, then press the shortcut on a physical keyboard. A
command can have more than one shortcut; use **×** beside a shortcut to remove
it, or **Reset** to restore the command's defaults. **Assigned only** filters
the list to commands that currently have shortcuts.

If a shortcut already belongs to another command, Geode names every conflicting
command and asks you to **Cancel** or explicitly **Reassign** it. Conflicted
shortcuts never run an arbitrary command. Changes take effect immediately in
the workspace and Web Viewer and are saved per vault in
`.geode/hotkeys.json`. Touch-only devices can inspect, remove, and reset
shortcuts; recording a new shortcut requires a hardware keyboard. Operating
system-reserved shortcuts can be saved, but Geode warns that the host may
intercept them.

## Install

Prebuilt macOS installers (dmg + zip, Apple Silicon + Intel) are published on
the [Releases page](https://github.com/rbcodelabs/geode/releases) whenever a
`v*` tag is pushed. Windows and Linux builds aren't set up yet — see the
[roadmap](docs/spec/00-overview.md) item for packaging.

### Install/update via script (recommended)

`scripts/geode-update.mts` installs the latest release, or updates an
existing install, in one command. It talks to the public GitHub API directly
(no `gh` CLI, no account, no auth needed — this repo is public) and
**automatically fixes the Gatekeeper "damaged app" warning** described below,
so the manual `xattr`/right-click steps become a fallback rather than a
required step. Requires macOS and Node.js 23.6+ (no install needed — Node
runs `.mts` files directly). Run it straight from GitHub, no clone required:

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

1. Download `Geode-<version>-arm64.dmg` (Apple Silicon) or
   `Geode-<version>.dmg` (Intel) from the latest release.
2. Open the dmg and drag **Geode.app** to **Applications**.
3. **These builds are ad-hoc signed but not notarized** (no Apple Developer
   ID yet). The ad-hoc signature lets the app launch on any Mac — including
   Apple Silicon, which refuses to run fully-unsigned apps — but Gatekeeper
   still shows an "unidentified developer" warning, or reports the app as
   "damaged," on the first launch of a downloaded copy. To open it (only
   needed if you installed manually — the script above handles this for
   you):
   - Right-click (or Control-click) **Geode.app** → **Open** → **Open** again
     in the confirmation dialog (also available under System Settings →
     Privacy & Security → **Open Anyway**), **or**
   - Run `xattr -dr com.apple.quarantine /Applications/Geode.app` in Terminal
     once, then launch normally. If Gatekeeper instead says the app is
     "damaged," that's not a quarantine issue and `xattr` won't fix it — the
     dmg's ad-hoc signature is missing its resource manifest. Re-sign it
     locally instead: `codesign --force --deep --sign - /Applications/Geode.app`.

   Full Developer ID signing + notarization (no warning at all) is a
   follow-up that needs a paid Apple Developer account.

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
