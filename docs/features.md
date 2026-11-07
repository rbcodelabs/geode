# Geode feature reference

The complete, detailed feature list. For a quick overview see the [README](../README.md).

- **GitHub connection** — Settings → GitHub signs in through GitHub's device
  flow and lists repositories granted to the Geode GitHub App. Tokens are
  encrypted through the OS keychain and refreshed automatically when requested;
  sign-in is disabled when secure storage is unavailable. Disconnect deletes
  local tokens and links to GitHub to revoke access. Agent Threads credential
  handoff is not included yet. See [GitHub authentication](design/github-app-auth.md)
  for GitHub App setup, the on-demand token API, and optional
  `GEODE_GITHUB_CLIENT_ID` / `GEODE_GITHUB_APP_SLUG` overrides. A different
  (for example company-private) App can be chosen in Settings > GitHub.

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

- **[Markdown comments](design/markdown-comments-v1.md)** — passage-anchored
  threads with replies, resolve/reopen, human/agent attribution, and detached-anchor
  recovery. Select text and press <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> (or
  run *Comments: Add comment to selection*); headings, list items and table cells
  can be annotated as well as ordinary prose. Comments travel inside the note;
  Live Preview and Reading view hide their markers, while Source mode exposes them.

- **Vaults** — open any folder; external edits are picked up live; manage recent
  vaults and open multiple vaults in isolated top-level windows
- **Actionable refresh errors** — a compact banner offers Retry and an on-demand
  details dialog with recovery guidance and privacy-safe diagnostic copying.
  Ordinary refresh ignores hidden development trees; failed scans preserve the
  previous file list, and saving-paused warnings remain visible. See
  [vault refresh troubleshooting](vault-refresh-troubleshooting.md).
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
  independent session-only back/forward history in each tab, including
  restorable plugin views when a picked file replaces the current pane,
  [durable companion splits](design/companion-panes.md) for plugins that
  feature-detect Geode's workspace extension,
  a hideable left ribbon with persistent Settings and
  plugin-contributed actions, shared document actions (including reveal-in-Finder/
  system-file-manager) across tab, view, command, and File Explorer menus,
  pinned-safe bulk tab closing, and status-bar word
  count; tab bar and view header DOM/CSS follow the conventions community
  themes and CSS snippets expect, so they apply correctly
- **Unfinished Base drafts in desktop tabs** — programmatic activation without
  focus preserves a nested Base cell's input and draft through hide/reveal.
  Click the preserved input to continue, press Enter to save or Escape to cancel;
  reveal does not automatically focus it. Panes with unfinished Base edits
  refuse cross-container moves before extraction until those edits are finished
  or canceled. See the
  [bounded behavior and captures](screenshots/native-background-visibility/README.md).
- **Command palette** (Cmd+P), **quick switcher** (Cmd+O), and Daily Notes (Cmd+D) with per-vault enable, folder, date-format, and template-path settings,
  dark/light themes via CSS variables
- **Templates** — create a named note from a template or insert one at the current
  editor selection. Daily Notes applies its configured template when creating a
  note. Both expand title, date, and time variables. See [Using templates](templates.md).
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
  the full `Editor` adapter plugins expect. `FileManager.processFrontMatter` safely
  serializes same-file calls within one renderer runtime; it does not lock out
  direct vault/external writes, and forwarded timestamp options are not yet
  applied by the host. Plugin keymaps dispatch through the active `Scope` parent
  chain before app commands, and modal scopes are active only for the modal's
  open lifetime. **Minimal Theme Settings 9.0.0** is certified on desktop,
  including its settings controls and theme/font preferences. This exact-version
  exception preserves the global Obsidian API baseline at 1.8.0; newer Minimal
  Settings versions and other plugins requiring 1.13 remain unverified.
  Desktop plugins can make HTTP(S) requests through `requestUrl()`, including
  text, JSON, and binary responses; requests use the main process while raw
  renderer `fetch()` remains subject to the existing Content Security Policy.
  Desktop voice plugins can use the [packaged PCM AudioWorklet](design/packaged-audio-capture.md)
  to capture audio off the UI thread without enabling blob scripts; microphone
  permission and stream lifetime remain the plugin's responsibility.
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

