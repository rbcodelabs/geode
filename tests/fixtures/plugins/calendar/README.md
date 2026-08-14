# Vendored fixture: obsidian-calendar-plugin

Real, unmodified build artifacts from a pinned release of
[liamcain/obsidian-calendar-plugin](https://github.com/liamcain/obsidian-calendar-plugin),
used by `tests/e2e/calendar-plugin.spec.ts` to verify Geode's daily-notes
compat surface (`app.internalPlugins`, `Vault.recurseChildren`,
`vault.getAbstractFileByPath` for the root folder, `workspace.getUnpinnedLeaf`/
`splitActiveLeaf`, and the `"layout-ready"` workspace event) against a real
community plugin instead of a hand-written synthetic one.

- **Pinned version:** `1.5.10`
- **Source:** https://github.com/liamcain/obsidian-calendar-plugin
- **Release:** https://github.com/liamcain/obsidian-calendar-plugin/releases/tag/1.5.10
- **License:** MIT (see `LICENSE` in this directory) — Copyright (c) 2021 Liam Cain

## Files

- `manifest.json` — downloaded as-is from the release assets.
- `main.js` — downloaded as-is from the release assets (bundled/minified;
  includes the plugin's own copy of `obsidian-daily-notes-interface`).
- `LICENSE` — fetched from the `1.5.10` tag of the source repo.

This release has no separate `styles.css` asset — the plugin's Svelte
components inject their own `<style>` tags into `document.head` at mount
time, so there's nothing to vendor there. Geode's plugin loader treats a
missing `styles.css` as optional or normal (see
`PluginManager.injectStyles` in `src/renderer/plugin-manager.ts`).

## Refreshing this fixture

1. Pick a release tag from https://github.com/liamcain/obsidian-calendar-plugin/tags
   (check `GET /repos/liamcain/obsidian-calendar-plugin/releases/tags/<tag>`
   for its asset list — some releases ship a `.zip` instead of loose files).
2. Download `manifest.json` and `main.js` (and `styles.css`, if present) from
   `https://github.com/liamcain/obsidian-calendar-plugin/releases/download/<tag>/<file>`.
3. Update `LICENSE` from `https://raw.githubusercontent.com/liamcain/obsidian-calendar-plugin/<tag>/LICENSE`.
4. Update the pinned version/links above.
5. Re-run `tests/e2e/calendar-plugin.spec.ts` — if the bundled
   `obsidian-daily-notes-interface`/Svelte internals changed their exact
   property names or CSS class names (grepped for `internalPlugins`,
   `getPluginById`, `daily-notes`, `has-note` when this fixture was first
   vendored), the test's selectors may need updating too.
