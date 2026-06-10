# Geode

**An open-source, local-first Markdown knowledge base** — a clean-room clone of
Obsidian built from its public documentation. Your notes are plain `.md` files
in a folder on your disk. Links between notes are first-class. No account, no
cloud, no lock-in.

> ⚠️ Early alpha (v0.1). The core loop works — vaults, editing, wikilinks,
> backlinks, search, tags, reading view — but many features are still on the
> [roadmap](docs/spec/00-overview.md).

## Features (v0.1)

- **Vaults** — open any folder; external edits are picked up live
- **Editor** — CodeMirror 6, markdown highlighting, `[[wikilink]]` autocomplete,
  Cmd/Ctrl+click to follow, autosave, rename-updates-links
- **Reading view** — callouts (13 types, foldable), embeds (notes/images/audio/
  video), highlights, tags, tables, task lists, YAML properties
- **Knowledge graph plumbing** — backlinks pane, outline, tag pane, unresolved
  link styling, link resolution by shortest path and alias
- **Search** — `tag:` `path:` `file:` operators, quoted phrases, negation, regex
- **Workspace** — tabs, split panes, pinned tabs, collapsible sidebars,
  status-bar word count
- **Command palette** (Cmd+P), **quick switcher** (Cmd+O), daily notes (Cmd+D),
  dark/light themes via CSS variables

## Develop

```bash
npm install
npm run build      # bundle main/preload/renderer with esbuild
npm start          # launch Electron
npm run dev        # esbuild watch mode
npm run typecheck  # strict tsc
```

A demo vault lives in `test-vault/`.

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
