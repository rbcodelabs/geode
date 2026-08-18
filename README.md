# Geode

**An open-source, local-first Markdown knowledge base** — a clean-room clone of
Obsidian built from its public documentation. Your notes are plain `.md` files
in a folder on your disk. Links between notes are first-class. No account, no
cloud, no lock-in.

> ⚠️ Early alpha (v0.5). The core loop works — vaults, editing, wikilinks,
> backlinks, search, tags, reading view, community plugins/themes, a Web
> Viewer — but many features are still on the
> [roadmap](docs/spec/00-overview.md).

## Features (v0.5)

- **Vaults** — open any folder; external edits are picked up live
- **Editor** — CodeMirror 6, markdown highlighting, `[[wikilink]]` autocomplete,
  Cmd/Ctrl+click to follow, autosave, rename-updates-links
- **Reading view** — callouts (13 types, foldable), embeds (notes/images/audio/
  video), highlights, tags, tables, task lists, YAML properties
- **Knowledge graph plumbing** — backlinks pane, outline, tag pane, unresolved
  link styling, link resolution by shortest path and alias, graph view;
  metadata is cached across launches so unchanged notes do not need re-indexing.
  File reads, Markdown parsing, and debounced atomic cache writes run in a
  background utility process, with automatic in-renderer fallback
- **Search** — `tag:` `path:` `file:` operators, quoted phrases, negation, regex
- **Canvas** — open and edit interoperable JSON Canvas 1.0 (`.canvas`) boards
  with text, file, link, and group cards; labeled edges; pan/zoom; and
  persistent drag/resize geometry
- **Workspace** — tabs, split panes, pinned tabs, collapsible sidebars, a
  hideable left ribbon with persistent Settings and plugin-contributed actions,
  and status-bar word count; tab bar and view header DOM/CSS match real
  Obsidian so community themes and CSS snippets apply correctly
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
- **Web Viewer** — open web pages in an in-app tab (`webview`-backed, its own
  session), plus a one-time "Import cookies from Chrome" option so viewer
  tabs open already logged in

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
project roadmap.

## Legal

Geode is a clean-room implementation based solely on publicly available
documentation. It contains no Obsidian code or assets. "Obsidian" is a
trademark of Dynalist Inc.; this project is not affiliated with or endorsed by
them. Licensed under the [MIT License](LICENSE).
