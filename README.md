# Geode

**An open-source, local-first Markdown knowledge base** — a clean-room clone of
Obsidian built from its public documentation. Your notes are plain `.md` files
in a folder on your disk. Links between notes are first-class. No account, no
cloud, no lock-in.

> ⚠️ Early alpha (v0.8). The core loop works — vaults, editing, wikilinks,
> backlinks, search, tags, reading view, community plugins/themes, a Web
> Viewer — but many features are still on the
> [roadmap](docs/spec/00-overview.md).

## Features (v0.8)

- **Vaults** — open any folder; external edits are picked up live; manage recent
  vaults and open multiple vaults in isolated top-level windows
- **Editor** — CodeMirror 6, markdown highlighting, `[[wikilink]]` autocomplete,
  Cmd/Ctrl+click to follow, autosave, rename-updates-links
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
  plugin-contributed actions, and status-bar word count; tab bar and view header
  DOM/CSS match real Obsidian so community themes and CSS snippets apply correctly
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
