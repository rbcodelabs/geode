# 00 — Geode: Scope Overview & Implementation Roadmap

Geode is a clean-room, open-source (MIT) clone of Obsidian: a local-first
Markdown knowledge base. The full target scope was reverse-engineered from
Obsidian's **official documentation only** (help.obsidian.md, docs.obsidian.md,
jsoncanvas.org, the public changelog) — no proprietary code, assets, or
branding were used. The name, icon, and styling are original.

## Spec library

| Doc | Contents |
|---|---|
| [01-core-app.md](01-core-app.md) | Vaults, files/folders, editor modes, Obsidian Flavored Markdown, properties, linking, search syntax, workspace, hotkeys, settings, appearance |
| [02-core-plugins.md](02-core-plugins.md) | All 30 core plugins, incl. deep dives on Bases (.base), Canvas (JSON Canvas 1.0), Graph view, Templates, Daily notes, Sync/Publish service capabilities |
| [03-plugin-api.md](03-plugin-api.md) | Plugin anatomy (manifest, lifecycle), the full API class hierarchy (App, Vault, Workspace, MetadataCache, Editor…), events, CM6 editor extensions, themes/CSS variables, community distribution, obsidian:// URIs |
| [04-formats-and-platform.md](04-formats-and-platform.md) | `.obsidian` config files, JSON Canvas spec, Bases YAML format, URI scheme, Sync/Publish internals (E2EE), platform matrix, changelog evolution v1.5→v1.13 |

## Implementation status (v0.1)

### Done — working and verified

- **Shell**: Electron + TypeScript + CodeMirror 6 (same stack as the original, which keeps a future API-compatible plugin layer feasible); esbuild build; strict tsc
- **Vaults**: open any folder as a vault, recent-vault persistence, vault picker; filesystem watcher (chokidar) reflects external edits/creates/deletes live
- **Vault model**: file tree, create/rename/trash (to OS trash) for files and folders, "Untitled n" allocation, content cache
- **Metadata cache**: YAML frontmatter (incl. aliases/tags), wikilinks + embeds with positions, inline #tags (code-block aware), headings, resolved/unresolved links, backlink index, link resolution (exact path → relative → shortest basename → alias)
- **Editor**: CM6 with markdown syntax highlighting, `[[` wikilink autocomplete, Cmd/Ctrl+click to follow links, Cmd+B/I formatting, debounced autosave, inline title rename (updates links vault-wide)
- **Reading view**: OFM rendering — wikilinks (incl. unresolved styling), embeds (images w/ sizing, audio, video, note transclusion w/ `#heading` sections), all 13 callout types with fold, ==highlights==, #tags, tables, task lists, footnote syntax via GFM, properties table, %%comments%% stripped
- **Workspace**: tab groups with split-right, pinned tabs, sidebars (collapsible icon docks), status bar (word/char count, backlink count), empty-state tab
- **Core views**: file explorer (tree, context menus, active highlight), search (operators: `tag:` `path:` `file:` `content:`, `"phrases"`, `-negation`, `/regex/`), backlinks pane, outline pane (click-to-jump), tag pane (click-to-search)
- **Command system**: command palette (Cmd+P), quick switcher (Cmd+O, create-on-no-match), hotkey registry, daily note (Cmd+D), random note
- **Settings & theming**: dark/light via CSS variable theme (`.theme-dark`/`.theme-light` body classes, Obsidian-convention variable names), readable line length, per-vault settings persisted in `.geode/`
- **Live Preview mode** (default): CM6 decorations hide markdown syntax away from the cursor — headings, emphasis, inline code, quotes, highlights; wikilinks/links render as clickable text; task markers become toggling checkboxes; HRs render as lines. Gotcha learned the hard way: block widgets must carry no external margins or CM's height map drifts and cursor motion breaks
- **Properties editor**: frontmatter renders as an integrated, editable typed table (block widget) that serializes back to YAML

### Next (rough priority order)

0. **Test harness** — no automated tests exist yet; everything so far was
   verified manually via CDP probes. Set up: (a) vitest unit tests for the
   pure data layer — `parseMetadata`, link resolution
   (`getFirstLinkpathDest`), search query parsing/matching, fuzzy matcher,
   rename link-rewriting; (b) a Playwright `_electron.launch()` smoke test
   that boots the app against `test-vault/`, opens a note, asserts Live
   Preview rendering and no console errors. Wire both into `npm test` and
   require green before push.
1. **Live Preview embeds** — render `![[image]]`/`![[note]]` transclusions inline while editing (currently raw syntax in LP, rendered in reading view)
2. **Graph view** — canvas force-directed renderer over `resolvedLinks`; local graph
3. **Unlinked mentions** in backlinks pane; backlink context snippets
4. **Canvas** — `.canvas` JSON Canvas 1.0 editor (spec in 02/04)
5. **Plugin API layer** — `geode` module mirroring the documented `obsidian` API surface (spec 03); CSS snippets + community themes
6. **Templates, bookmarks, note composer, page preview (hover), slash commands, workspaces** (specs in 02)
7. **Search upgrades** — `line:`/`block:`/`section:`/`task:` operators, property `[key:value]` queries, embedded query blocks
8. **Bases** — `.base` table/card views with formula language (spec in 02/04)
9. **Mobile** (Capacitor) and packaging/auto-update (electron-builder), pop-out windows, vertical splits/stacked tabs
10. **Sync alternative** — document Git/Syncthing workflows; optional E2EE sync server is out of scope for core

## Architecture map

```
src/main/main.ts          Electron main: window, vault-scoped fs IPC, chokidar watcher
src/main/preload.ts       contextBridge "geode" API (typed)
src/indexer/              Background metadata reads/parsing/cache persistence
src/renderer/app.ts       App: wiring, commands, modals, settings, notices, menus
src/renderer/vault.ts     Vault: file tree model + CRUD + events
src/renderer/metadata-cache.ts  Frontmatter/link/tag/heading parsing, backlinks
src/renderer/workspace.ts Workspace/TabGroup/WorkspaceLeaf/Sidebar
src/renderer/views/       markdown-view (CM6), file-explorer, search, backlinks/outline/tags
src/renderer/modals/      Modal, SuggestModal (fuzzy), quick switcher, palette
src/renderer/markdown/    Reading-view renderer (marked + OFM extensions)
styles/app.css            CSS-variable theme system (dark/light)
```

## Legal posture

Functional clean-room clone: implemented from publicly documented behavior.
No Obsidian source, binaries, icons, fonts, or CSS were copied. "Obsidian" is
a trademark of Dynalist Inc.; Geode is unaffiliated and uses its own name and
identity. The JSON Canvas spec is MIT-licensed by its authors.
