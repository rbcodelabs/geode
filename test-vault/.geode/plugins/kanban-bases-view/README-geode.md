# kanban-bases-view (vendored test fixture)

The unmodified shipped release artifacts of the community plugin
[`kanban-bases-view`](https://github.com/xiwcx/obsidian-bases-kanban) v0.10.4
by I. Welch Canavan, MIT licensed (see `LICENSE`).

They are checked in as a test fixture for `tests/e2e/bases-plugin-view.spec.ts`
(the read path: the board renders, columns come from the groupBy property) and
`tests/e2e/bases-kanban-interaction.spec.ts` (the write path: drag, quick-add,
open, cover images). Using the published artifact rather than a hand-written
stand-in is the whole point: a stub would only prove Geode is consistent with
itself.

Installed but **disabled by default**, like `status-probe` — the e2e specs
enable it in their own throwaway vault copies.

## Provenance

- **Pinned version:** `0.10.4`
- **Source:** https://github.com/xiwcx/obsidian-bases-kanban
- **Release:** https://github.com/xiwcx/obsidian-bases-kanban/releases/tag/0.10.4
- **License:** MIT (see `LICENSE`) — Copyright (c) 2026 I. Welch Canavan

| file | source | SHA-256 |
|---|---|---|
| `main.js` | https://github.com/xiwcx/obsidian-bases-kanban/releases/download/0.10.4/main.js | `6f782a6e906c21e30afef1fddbcf01d031992094c841148dbcf6b3929c04b3ae` |
| `manifest.json` | https://github.com/xiwcx/obsidian-bases-kanban/releases/download/0.10.4/manifest.json | `6d9b1f421a38f312958e930ee848a29c7c9f9eb2b39c3c634bdaf0d2a3b1022b` |
| `styles.css` | https://github.com/xiwcx/obsidian-bases-kanban/releases/download/0.10.4/styles.css | `fe444af65f188f5b8bbf6739364154be498a62fb393e394f0cb3eb23debe2299` |
| `LICENSE` | https://raw.githubusercontent.com/xiwcx/obsidian-bases-kanban/0.10.4/LICENSE | `d20696791d995bf1eea8ee4c9402705f257b4c55a835c5ae80fd07f78c792f1d` |

### Why the digests are recorded

This fixture previously carried a `main.js` built locally from the plugin's
source instead of the release asset — 157,861 bytes against the shipped
164,449 — while claiming in this file to be the shipped build. The two differ
in exactly the calls that matter: the release bundle creates columns, cards and
colour swatches through `ctx.doc.createDiv()` (a `Document` parent), the local
build did not. So the e2e suite passed against an artifact no user ever runs,
while every real install rendered a blank board. Pin the digests, and that
cannot happen quietly again.

## Refreshing this fixture

1. Pick a release tag from https://github.com/xiwcx/obsidian-bases-kanban/releases.
2. `gh release download <tag> --repo xiwcx/obsidian-bases-kanban --pattern 'main.js'
   --pattern 'manifest.json' --pattern 'styles.css'` — download the *release
   assets*, never a local `npm run build` output.
3. Update `LICENSE` from
   `https://raw.githubusercontent.com/xiwcx/obsidian-bases-kanban/<tag>/LICENSE`.
4. Update the pinned version, links and SHA-256 table above (`shasum -a 256 *`).
5. Re-run both e2e specs. They assert on the plugin's own class names
   (`.obk-board`, `.obk-column`, `.obk-card`), so a markup change upstream may
   need selector updates too.
