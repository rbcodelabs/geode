# ADR 0001 — Native "Install from GitHub" for community plugins & themes, with auto-update

**Status:** Accepted (MVP scope). Phasing in progress.
**Date:** 2026-08-12
**Compass:** Opportunity `9f6ab58e-5674-466c-a8e8-f7fa168970c1` → Solution `57796823-9b7e-45ab-843d-68b3066338fa` (roadmap NEXT).

> This is the first ADR in the repo; it establishes `docs/adr/` as the home for
> architecture decision records. `docs/spec/` remains the reverse-engineered
> Obsidian specification (reference), not a decision log.

---

## Context

Geode already *loads* community **plugins** (`<vault>/.geode/plugins/<id>/`) and
**themes** (`<vault>/.geode/themes/<name>/theme.css`), but there is no way to
*install* them from inside the app and no fallback to Obsidian's `.obsidian/`
folder. Pointing Geode at an existing vault on a second machine surfaces zero
plugins/themes; the only workaround is hand-copying files into `.geode/` and
enabling them. This blocks real multi-machine use.

The proven model for "install a plugin/theme from a GitHub repo and keep it
updated" is the Obsidian community plugin **BRAT** (Beta Reviewer's Auto-update
Tool). We evaluated shipping BRAT itself and rejected it (see below).

## Decision

Build BRAT's **mechanic natively** into Geode: add a plugin/theme by GitHub
`owner/repo`, resolve the correct release/assets, install into `.geode/`, track
the item, and keep it updated — implemented in Geode's own code against its own
`PluginManager`/`ThemeManager`, not by running BRAT.

### Why not ship BRAT itself

BRAT depends on Obsidian internals Geode's API shim (`src/renderer/api/obsidian.ts`)
does not provide, and the gaps are exactly in the parts we care about:

1. **Config-dir mismatch (fatal).** BRAT writes to `` `${app.vault.configDir}/plugins/<id>/` `` (`.obsidian`). Geode has no `configDir` shim and reads only `.geode/plugins/`.
2. **Themes don't work.** BRAT installs themes via `app.customCss.setTheme()` into flat `.obsidian/themes/<name>.css`. Geode has no `customCss` and uses `.geode/themes/<name>/theme.css` folders managed by `ThemeManager`.
3. **Update detection needs `app.plugins.manifests`**, which Geode stubs as `{}` — so BRAT can't diff installed vs. latest versions.

Adapting BRAT to bridge these would be more work than reimplementing, and would
saddle us with a permanent fork. We clone the *behavior*, not the bytes. (BRAT
is MIT-licensed; algorithm details may be lifted with attribution in a code
comment.)

## Scope

**In scope (MVP):**
- Add a plugin or theme by GitHub `owner/repo`.
- Resolve the correct release/assets and download into the vault.
- Track installed community items and their update policy in `.geode/community.json`.
- Auto-update on launch (opt-in per item) + a manual "Check for updates" command.
- Version pin/freeze and per-item auto-update toggle.
- A trust prompt before running remote plugin code.

**Non-goals (deferred):**
- **Browsable catalog / marketplace** — separate Compass solution (`efa15e5f`), a much larger hosting/curation effort. You must know the `owner/repo`. (BRAT itself is add-by-repo only.)
- Hosting BRAT-the-plugin. (Consequently we do **not** add `app.vault.configDir` / `app.customCss` shims.)
- Sandboxing plugin code — plugins keep full Node access (existing trust model).
- Non-GitHub sources (GitLab, direct URLs, local zips).
- Inter-plugin dependency resolution.

## Decisions locked with the product owner (2026-08-12)

| # | Question | Decision |
|---|----------|----------|
| 1 | Default trust/auto-update posture | **Install is available by default; auto-update is OFF per item (opt-in per repo).** Remote code never silently changes under the user. No global restricted-mode gate on first run. |
| 2 | Prerelease default for plugins | **`includePrerelease: true`** — the BRAT use case is beta plugins that publish only prereleases. The install modal shows the resolved version before install. |
| 3 | Token in MVP | **Ship token-less.** The raw-CDN fast path keeps us within the 60/hr unauthenticated REST budget for a handful of repos. Optional `safeStorage` token deferred to Phase 4. |
| 4 | `configDir` / `customCss` shims | **Not added.** We are not committing to running real BRAT. |
| 5 | "Stop updating" vs "Uninstall" | **Two distinct actions.** "Stop updating" untracks in `community.json` (leaves files + enabled state); "Uninstall" deletes files + disables. |

## Design

### Plugin vs. theme distribution (they differ)

- **Plugins** ship built assets (`main.js`, `manifest.json`, optional `styles.css`) attached to a **GitHub Release**. Prefer release assets; fall back to raw default-branch files only if the repo has zero releases (`source: "raw"`, with a warning).
- **Themes** ship `theme.css` + `manifest.json` on the **default branch** (raw files); most theme repos have no releases. Read raw `HEAD`; honor a release only if the user pins a tag.

`manifest.json`'s `version` field is authoritative, not the git tag.

### Type disambiguation

1. Explicit user choice in the add modal (`auto | plugin | theme`), default `auto`.
2. Asset/file presence: `main.js` ⇒ plugin; `theme.css` and no `main.js` ⇒ theme.
3. Ambiguous (both/neither) ⇒ require the user to choose.

### Rate limiting

Unauthenticated GitHub REST = 60 req/hr/IP. Mitigations, in order:
1. **Version checks via `raw.githubusercontent.com`** (CDN, not REST-budgeted). A check = one raw `GET manifest.json`. Fast path; keeps us off the API for the common case. (For plugins, raw HEAD manifest can be *ahead* of the latest release; treat raw version as a "candidate" and only hit the API to enumerate the actual release when downloading.)
2. **Conditional requests** — store the API `ETag` in `community.json`; send `If-None-Match`; `304` responses don't count against the limit.
3. **Cadence** — skip auto-checks younger than a threshold (default 6h) unless the user forces via the manual command.
4. **Optional token (Phase 4)** — stored via Electron `safeStorage` in the **main process**, never returned to the renderer (any hosted plugin can read the `localStorage`-backed `secretStorage` shim, so it must not hold the token).

### On-disk layout & `community.json`

```
<vault>/.geode/
  plugins.json        # EXISTING — enabled plugin ids (unchanged)
  app.json            # EXISTING — app settings incl. active theme (cssTheme)
  community.json      # NEW — provenance + update policy only
  plugins/<id>/       # EXISTING — manifest.json, main.js, styles.css?
  themes/<name>/      # EXISTING — theme.css, manifest.json
```

```ts
interface CommunityConfig { version: 1; items: CommunityItem[]; }

interface CommunityItem {
  repo: string;                 // "owner/repo" — the add key (unique)
  type: "plugin" | "theme";
  id: string;                   // plugin id OR theme folder name (== on-disk dir)
  installedVersion: string;     // manifest.version last written to disk
  source: "release" | "raw";
  ref?: string;                 // release tag, or "HEAD" for raw
  pinnedVersion?: string;       // when set → never auto-update
  autoUpdate: boolean;          // DEFAULT false (opt-in, per decision #1)
  lastChecked?: number;         // epoch ms (drives cadence)
  etag?: string;                // conditional-request cache
  assets?: Record<string, string>; // filename → sha256 (tamper-evidence / no-op detection)
}
```

**No duplicate sources of truth:** enabled-state stays in `plugins.json`; active
theme stays in `app.json` `cssTheme`; `community.json` holds only provenance +
update policy. A plugin can be enabled but untracked (hand-dropped → no
auto-update); tracked but disabled (still kept current on disk); untracking
never disables/deletes.

### `PluginManager` changes (minimal)

Today `enable(id)` throws `Unknown plugin` unless the manifest is already in the
in-memory map, which only `initialize()` populates. Add two methods; leave the
rest untouched:

- `rescan()` — re-read installed ids + manifests from disk into `manifests` **without** enabling. Adds new ids, refreshes existing (picks up a bumped version), drops ids gone from disk that aren't loaded. Never touches loaded plugins. `initialize()` refactors to `rescan()` + the existing auto-enable loop.
- `reload(id)` — hot-reload after an on-disk update: if enabled, `disable()` → `rescan()` → `enable()`; if disabled, just `rescan()`. Relies on existing `disable()`→`onunload()`+`removeStyles()` then `enable()`→new `main.js`+`injectStyles()`.

**Caveat (documented):** re-executing `main.js` in the same renderer realm means
module-level side effects a plugin didn't reverse in `onunload()` persist until
restart. If `reload()` throws, fall back to a Notice: "Updated on disk — restart
Geode to finish."

**Themes need no structural change.** `ThemeManager.list()`/`apply()` re-read disk
each call; hot-apply = re-`apply()` if the updated theme is active, else nothing.

### Update-check flow

- **On launch:** after `initialize()` + layout restore, on an idle/debounced timer. Only items with `autoUpdate: true`, no `pinnedVersion`, and `lastChecked` older than the cadence.
- **Manual command** `"Community: Check for updates"` — forces all tracked items regardless of `autoUpdate`/cadence.
- **Compare** remote `manifest.version` vs `installedVersion` via `compareVersions`.
- **`minAppVersion` pre-flight guard:** never auto-apply an update whose `minAppVersion` exceeds `GEODE_API_VERSION`; keep the working version and report "requires newer Geode."
- **Apply:** main downloads to a temp dir, validates (`parseManifest`, id/folder match), then **atomically renames** into place. Renderer updates `community.json`; plugin → `reload(id)`; theme → re-apply if active.

### Where the code lives

**All networking + downloading + file installation happens in the MAIN process;
the renderer owns orchestration, state, and UI.** Rationale: release-asset
downloads redirect to signed object storage that does not send permissive CORS
from a `file://` origin; main (Node) has no CORS and can write files atomically;
a future token must live in main and never reach the renderer; and a fixed
main-side seam (overridable base URLs) makes e2e deterministic.

```
src/main/
  github-resolve.ts   # PURE (no electron import): parseRepoSpec, selectRelease,
                      # classifyItem, readManifestMeta, resolveItem(spec, {get}, opts)
  community.ts        # IPC + real http + safeStorage token (P4) + temp-dir download
                      #   + atomic install into session.root/.geode/…   [Phase 1+]
src/renderer/
  community/
    store.ts               # PURE: community.json read/modify + update-policy logic
    community-manager.ts   # orchestration; calls pluginManager.reload / themeManager.apply  [P1+]
    install-modal.ts       # "Add from GitHub" modal + trust prompt                          [P1+]
```

Base URLs overridable via `GEODE_GITHUB_API_BASE` / `GEODE_GITHUB_RAW_BASE`
(production seam + e2e fake-GitHub target).

New IPC (Phase 1+): `community-resolve`, `community-install`, `community-latest`
(+ token handlers in Phase 4). The install handler resolves the target dir from
`sessions.get(win.id).root` and only writes a **whitelisted** set of filenames
(`manifest.json`, `main.js`, `styles.css`, `theme.css`) — remote asset names are
never used to build paths.

The chokidar watcher already ignores dotfile paths, so writing under `.geode/`
generates no file-explorer churn (verified).

### Security & trust

Plugins run with full Node access (existing model). Installing remote code is a
materially larger risk, so:

1. **Trust-on-install prompt (required)** naming repo + author: "runs with full access to your files and system."
2. **No auto-enable on install** — enabling is a separate explicit step.
3. **Input hardening:** validate `owner/repo` (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, also accept `https://github.com/owner/repo(.git)?`), HTTPS only, whitelist written filenames, enforce `parseManifest(raw, expectedId)`.
4. **sha256 per file** in `community.json.assets` — not a security boundary (TLS to GitHub is), but gives tamper-evidence + no-op-update detection.
5. **No sandboxing** (out of scope).

## Failure modes

Repo 404 → clear error, nothing written. No releases (plugin) → raw fallback +
warning. Missing required asset → abort, name it. Offline → auto-check silently
skips; manual shows one Notice. Rate-limited → raw fallback, else "add a token /
retry." Partial download → temp+rename means the live dir is never half-updated.
Downgrade → never auto-applied. `minAppVersion` too high → refused, keep working
version. Two repos → same id → block on install. Reload throws → "restart to
finish." Corrupt `community.json` → treated as empty, never crashes.

## Test plan

- **Unit (vitest):** all resolution/decision logic is pure and dependency-injected.
  - `tests/unit/community-resolve.test.ts` — `parseRepoSpec`, `selectRelease`, `classifyItem`, `resolveItem` with a fake `HttpGet`.
  - `tests/unit/community-store.test.ts` — `upsertItem`/`removeItem`/`itemsToCheck`/`shouldUpdate` incl. `minAppVersion` guard, pin, downgrade.
- **E2E (Playwright):** a local fake-GitHub HTTP server serving canned releases/assets/raw files; main resolution pointed at it via `GEODE_GITHUB_*_BASE`; cold-launch install → enable → bump version → check-for-updates → reload. (Phase 1+.)

Gate: `npm run typecheck` + `npm test`.

## Phasing

- **Phase 0 — pure core (no UI).** `github-resolve.ts` + `community/store.ts` + base-URL seam + full unit tests. Ships nothing user-visible; de-risks everything. ← *this ADR + Phase 0*
- **Phase 1 — install a plugin from a repo (manual).** Main IPC, atomic install, `PluginManager.rescan()`, add-modal + trust prompt, write `community.json`. No auto-update.
- **Phase 2 — themes.** Raw default-branch resolution, theme install, hot re-apply.
- **Phase 3 — auto-update engine.** `PluginManager.reload()`, on-launch debounced check, "Check for updates" command, `minAppVersion` guard, Notices.
- **Phase 4 — polish.** Pin/freeze + per-item toggles, Settings management list (update-now/stop/uninstall), ETags, optional `safeStorage` token, sha256 tracking.

## Consequences

- Existing Obsidian users still can't point Geode at a `.obsidian/` vault and see their plugins — an `.obsidian/` **importer** is a natural sibling (shares this feature's file-writing plumbing) and should be considered next on the same opportunity.
- We take on responsibility for running arbitrary remote code; the trust prompt + opt-in auto-update are the proportionate MVP guardrails.
