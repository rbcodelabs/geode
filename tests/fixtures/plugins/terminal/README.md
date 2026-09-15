# Vendored fixture: obsidian-terminal

Real, unmodified build artifacts from a pinned release of
[polyipseity/obsidian-terminal](https://github.com/polyipseity/obsidian-terminal),
used by `tests/e2e/terminal-plugin-cert.spec.ts` to certify Geode's desktop
Node-integration compat surface (`require("node:child_process")`,
`require("node:fs/promises")`, `require("node:stream")`, `require("electron")`
falling through `requireShim` to the real ambient Node `require` — see
`instantiatePluginClass` in `src/renderer/plugin-manager.ts`) against a real,
complex community plugin that actually spawns a pty and streams process I/O,
instead of a hand-written synthetic one.

- **Pinned version:** `3.27.2`
- **Source:** https://github.com/polyipseity/obsidian-terminal
- **Release:** https://github.com/polyipseity/obsidian-terminal/releases/tag/3.27.2
- **License:** AGPL-3.0 (see `LICENSE` in this directory) — polyipseity

## Files

- `manifest.json` — downloaded as-is from the release assets.
- `main.js` — downloaded as-is from the release assets (bundled/minified via
  esbuild; includes the plugin's own bundled copies of `@xterm/xterm` and its
  addons, `tmp-promise`/`tmp`, and the rest of its `dependencies`).
- `styles.css` — downloaded as-is from the release assets.
- `LICENSE` — fetched from the `3.27.2` tag's `LICENSE.txt` in the source repo.

## Why this fixture exists

This is the deepest available check of Geode's desktop plugin Node-integration
story: obsidian-terminal spawns a real shell via `dynamicRequire(BUNDLE,
"node:child_process")` and streams its stdio via `"node:fs/promises"` /
`"node:stream"`, all obfuscated behind the plugin's own `dynamicRequire`
helper so esbuild won't try to bundle them. Vendoring it and actually opening
a terminal, typing into it, and reading back real shell output is a much
stronger guarantee than a synthetic plugin that just calls
`require("node:child_process")` directly.

**`tmp-promise` is not a risk here despite not being a Node builtin:** static
analysis of this release's `main.js` (`grep -o 'var _I=E1((CC1,o5)=>{...'`)
confirms the plugin's own esbuild build bundles `tmp-promise` (and its `tmp`
dependency) directly into `main.js` — it is *not* left external and does not
go through `requireShim`'s `nodeRequire` fallback at all. Only truly
environment-provided specifiers (`obsidian`, `electron`, `node:*` builtins)
are marked external in the plugin's own build and reach `requireShim`'s real
delegation to Node. This was verified empirically too: launching the real app
with this fixture and typing a command into a real spawned terminal echoes
real shell output back with no `Cannot find module` errors of any kind.

## Certifying this required two real Geode compat fixes

Loading this plugin surfaced three genuine gaps in Geode's Obsidian API
compat layer (all now fixed, see `src/renderer/api/obsidian.ts` and
`src/renderer/api/obsidian-dom.ts`):

1. **`FuzzySuggestModal`/`SuggestModal` were not exported** from the public
   `obsidian` module shim at all, so `class X extends
   require("obsidian").FuzzySuggestModal` crashed the entire plugin at
   module-eval time (`class extends value undefined`) before `onload` ever
   ran. Added both, matching the shape documented in
   `docs/spec/03-plugin-api.md` § 3.1.
2. **`self.activeWindow`/`activeDocument` were not installed as globals.**
   Obsidian aliases the popout-aware "current" window/document this way;
   obsidian-terminal calls `self.activeWindow.setTimeout(...)` directly.
   Missing globals threw `Cannot read properties of undefined (reading
   'setTimeout')`. Both now alias the single app window (Geode has no
   popout-window support yet).
3. **`Node.prototype.onWindowMigrated` was missing.** Also part of Obsidian's
   popout-window DOM augmentation; a node's owning window never actually
   changes in Geode, so this is installed as a no-op registration that
   returns a no-op unsubscribe function.

Also fixed in the same pass: `Setting.setTooltip()` was missing (real
Obsidian's `Setting` has had a chainable `setTooltip()` for a while) — this
one threw a hard, uncaught `TypeError` (not gracefully handled) while building
the plugin's language-picker setting.

The plugin also logs several `console.warn("Private API changed", …)`
messages for a few genuinely *private*, undocumented Obsidian internals it
optionally pokes at (hotkey baking, a ribbon-button private helper, an
internal `requestUpdateLayout` call). These are caught and logged by the
plugin's own code, not crashes, and are out of scope for Geode's public API
compat surface — real Obsidian's own private internals change across versions
too, which is exactly why the plugin defends against them this way.

## Refreshing this fixture

1. Pick a release tag from https://github.com/polyipseity/obsidian-terminal/tags
   (check `GET /repos/polyipseity/obsidian-terminal/releases/tags/<tag>` for
   its asset list).
2. Download `manifest.json`, `main.js`, and `styles.css` from
   `https://github.com/polyipseity/obsidian-terminal/releases/download/<tag>/<file>`.
3. Update `LICENSE` from
   `https://raw.githubusercontent.com/polyipseity/obsidian-terminal/<tag>/LICENSE.txt`.
4. Update the pinned version/links above.
5. Re-run `tests/e2e/terminal-plugin-cert.spec.ts` — if the exact command IDs
   (`terminal:open-terminal.integrated.root` etc.) or DOM structure changed,
   the test's selectors may need updating too.
