# ADR 0004 — Import community plugins & themes from an existing `.obsidian/` vault

**Status:** Accepted (MVP scope).
**Date:** 2026-08-21
**Compass:** Opportunity `9f6ab58e-5674-466c-a8e8-f7fa168970c1` → Solution `e75ff608-a98d-49c0-8fab-281998b8d9f0` (roadmap NOW, item `87c6f0de`).

> Companion to [ADR 0001](0001-community-install-from-github.md), which
> established native install-from-GitHub. That ADR named "no fallback to
> Obsidian's `.obsidian/` folder" as an explicit gap; this ADR closes it.

---

## Context

Geode loads community **plugins** from `<vault>/.geode/plugins/<id>/` and
**themes** from `<vault>/.geode/themes/<name>/theme.css`. An existing Obsidian
user who points Geode at their vault sees *nothing*, because their plugins and
themes live under `.obsidian/` — a folder Geode never reads. The only
workaround is hand-copying files into `.geode/` and re-creating the enabled
list by hand. This blocks real multi-machine use and adoption by existing
Obsidian users (discovered 2026-08-12 installing v0.2.12 on a second machine
against an existing vault).

## Decision

Add a one-shot importer that copies community plugins & themes from the current
vault's `.obsidian/` folder into `.geode/`, preserving which plugins were
enabled and which theme was active. It is a **pure local copy** — no network,
distinct from the GitHub installer.

### Layering (mirrors ADR 0001's pure/IO split)

- **`src/main/obsidian-import.ts`**
  - `planObsidianImport(input)` — **pure** planner. Given discovered
    `.obsidian` plugin/theme entries, Obsidian's `community-plugins.json`
    (enabled ids) and `appearance.json` (`cssTheme`), and the ids/names already
    in `.geode/` + already enabled in `.geode/plugins.json`, it computes what to
    copy, the merged enabled-plugin list, the theme to apply, and skip reasons.
    No fs / electron / DOM → fully unit-tested.
  - `importFromObsidianVault(root)` — I/O executor. Walks `.obsidian/`, calls
    the planner, and atomically copies whitelisted files (staging dir on the
    vault volume + rename), then returns the plan result. **Copies files only.**
- **IPC** `community-import-obsidian` (main) → **preload** `importFromObsidian()`.
- **`CommunityManager.importFromObsidian()`** (renderer) rescans, enables the
  plugins Obsidian had enabled, and applies the active theme. Surfaced as a
  command ("Community: Import plugins & themes from an Obsidian vault") and a
  Settings button next to "Install from GitHub".

### Key decisions

- **Sources of truth unchanged.** The executor never writes `.geode/plugins.json`
  or `.geode/app.json` — the renderer owns those (`PluginManager` persists the
  enabled set; `App.settings.cssTheme` holds the active theme), matching the
  split in `community/store.ts`. Main returns the merged enabled list + theme;
  the renderer applies them.
- **Never overwrite.** An item already present in `.geode/` is left as-is
  (reported as skipped), so a re-import can't clobber a locally-tweaked copy —
  but an already-present plugin still counts toward the enabled set.
- **Enabled-list merge is order-stable.** Geode's existing enabled order is
  kept, then Obsidian's newly-enabled ids are appended in Obsidian's order;
  deduped and filtered to plugins that will actually exist on disk.
- **Active theme only-if-present.** Obsidian's active theme is applied only when
  it will exist in `.geode/`; an empty Obsidian selection never clobbers Geode's
  current theme.
- **Security.** Whitelisted filenames only (plugins: `manifest.json` / `main.js`
  / `styles.css` / `data.json`; themes: `theme.css` / `manifest.json`) — paths
  are never built from arbitrary on-disk names; item ids/names are guarded
  (`isSafeName`) against `/`, `\`, `..`, and leading dots; nothing is
  auto-enabled that Obsidian didn't already have enabled; the copy is atomic so
  a failure never leaves a half-written item. `data.json` is carried over so
  imported plugins keep their settings.
- **Legacy themes.** Both the modern `.obsidian/themes/<name>/theme.css` folder
  layout and the legacy bare `.obsidian/themes/<name>.css` file are handled,
  normalized to Geode's `<name>/theme.css` layout on copy.

## Non-goals

Install-from-GitHub (ADR 0001 / Solution `57796823`), a browsable
catalog/marketplace (Solution `efa15e5f`), and update hardening
(Solution `f309d22a`) are out of scope. This is a local migration, not a
networked installer.

## Consequences

Existing Obsidian users get their plugins/themes into Geode in one click,
directly resolving the original second-machine report. The pure planner is unit
-tested; the end-to-end flow is covered by `tests/e2e/obsidian-import.spec.ts`
(cold-boots the app against a seeded `.obsidian/` vault and asserts the plugin
and theme land in `.geode/`, the plugin is enabled, and the theme is applied).
