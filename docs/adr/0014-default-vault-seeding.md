# ADR-0014: Default vault seeding for deployer-customized builds

**Date:** 2026-09-02
**Status:** Accepted

## Context

Geode has no first-run/bootstrap mechanism for a brand-new vault: opening an
empty folder produces an empty `.geode/` — no theme, no plugins — and stays
that way until the user manually installs both via Settings → Community
plugins/themes. A deployer building and distributing their own copy of
Geode (an IT team imaging fleet machines, a company shipping Geode internally
with house-standard tooling) has no way to have that first vault open with a
sensible starting point already in place, short of asking every user to do
manual setup after install.

Geode already has a working "install a plugin/theme from a GitHub repo"
pipeline (`installCommunity`, `src/main/community.ts`, ADR 0001) driven today
only by the manual "install from GitHub" UI flow. That pipeline is reusable
as-is for automated seeding — no new plugin-distribution mechanism is needed,
just a trigger and a source list.

## Decision

1. **A general-purpose seeding mechanism, shipped with no default content.**
   `src/main/default-vault-bootstrap.ts` exports `bootstrapFreshVault(root)`,
   called from the `open-vault` IPC handler in `main.ts` immediately after
   resolving `root`, before anything else touches the vault (`listVaultFiles`,
   the metadata indexer, the file watcher). This repository's own build ships
   neither a default theme nor a default plugin list — `resources/` contains
   no `default-theme/` directory and no `default-plugins.json`. **Every
   upstream user gets a pure no-op**: both seeding steps below check for their
   input file/directory first and skip silently (no log, nothing "alarming")
   when it's absent, which is the expected outcome for every regular install
   of this repo.

2. **Two independent steps, each individually try/caught.** A deploying
   organization customizes their own build by dropping files into `resources/`
   *before* running `npm run build` / `electron-builder` — no code change
   required:
   - **Theme:** `resources/default-theme/<ThemeName>/{theme.css,manifest.json}`
     is copied into `<root>/.geode/themes/<ThemeName>/`. `<ThemeName>` is
     read from the directory itself, not hardcoded — this mechanism seeds
     exactly one theme, so if more than one folder is present the
     alphabetically first is used.
   - **Plugins:** `resources/default-plugins.json` (shape:
     `{ "plugins": string[] }`, each entry an `"owner/repo"` GitHub
     reference) is read, and each entry is installed via the existing
     `installCommunity(root, repo, { type: "plugin" })` — the same call the
     manual GitHub-install UI flow makes. Per-plugin failures (offline,
     rate-limited, repo renamed/moved) are logged and skipped, not thrown: a
     flaky network at vault-open time must never block opening the vault.
     Successfully-installed plugin ids are written to `.geode/plugins.json`
     (enabled by default, matching how a manually-installed plugin is
     enabled).

   A failure in either step (malformed JSON, a missing file inside an
   otherwise-present theme folder, a permission error) never blocks the
   other step, and neither ever blocks vault opening itself.

3. **`.geode/` existing is the only gate, checked once, up front.** If
   `<root>/.geode/` already exists, `bootstrapFreshVault` returns immediately
   without touching anything — this is what makes the mechanism safe to ship
   unconditionally in every build, including this repo's own upstream build
   where the two resource inputs never exist. It protects every vault that's
   ever been opened by Geode before, including vaults created before this
   mechanism existed; there is no version marker or migration to reason
   about.

4. **`app.json` seeding follows from a successfully-located theme, not from
   plugin success/failure.** If (and only if) a theme folder was found,
   `.geode/app.json` is seeded with `{ "theme": "light", "cssTheme":
   "<ThemeName>" }`. `theme: "light"` is required, not decorative:
   `AppSettings`'s own in-memory default is `theme: "dark"` with
   `cssTheme: ""` (`src/renderer/app.ts`), and a community theme's
   `theme.css` conventionally targets `body.theme-light` overrides (the
   shared CSS-variable contract in `styles/app.css` scopes color tokens by
   the active `theme-light`/`theme-dark` body class). Without the explicit
   `theme: "light"`, a seeded theme would sit unused under `.geode/themes/`
   while the vault kept rendering in dark mode with no override applied.
   This was verified against the current `AppSettings` initializer rather
   than carried over unchanged from an earlier version of this idea — the
   default has not changed, so the override is still both necessary and
   correct.

## Relationship to ADR 0002 (enterprise-managed plugin policy)

These two features are related but solve different problems and must not be
conflated:

| | ADR 0002 (plugin policy) | ADR 0014 (this one) |
|---|---|---|
| Question answered | Which *already-present* plugins are allowed to run? | What ships *present* in a vault the first time it's opened? |
| Delivery | Machine-level JSON file, read at runtime, no build-time step | Files dropped into `resources/` at build time, baked into that build |
| Scope | Restricts | Seeds |
| Can coexist? | Yes — a build can seed a plugin via ADR 0014 that ADR 0002's policy later blocks; policy enforcement in `PluginManager.enable()` doesn't know or care how a plugin got installed |

A deployer wanting both "ship with these plugins pre-installed" and "prevent
this other plugin from ever running on managed machines" uses both
mechanisms together — they were designed independently and don't need to be
aware of each other.

## Options considered

| Option | Why rejected |
|---|---|
| Ship an actual default plugin list / theme in this repo | This is the public upstream repo (`rbcodelabs/geode`); any hardcoded plugin list or theme would be silently auto-installed for every person who downloads a public release, regardless of whether they want that deployer's tools. Rejected outright, not just deferred. |
| A new plugin-distribution/manifest format for default content | `installCommunity` already exists, is already trusted (it's the same code path a user's manual GitHub install goes through), and already has file-safety guarantees (`assertSafeId`, allowed-file allowlist, atomic staging+rename). Building a second mechanism to distribute the same kind of content would be pure duplication. |
| Gate seeding on an explicit "first launch" flag/version marker instead of `.geode/` existence | `.geode/` not existing is already the exact, unambiguous signal for "this folder has never been opened by Geode" — no flag can be more precise, and a flag adds a place for the seeding logic to be skipped or re-triggered incorrectly (e.g. if the flag file is deleted but `.geode/` is not). |
| Seed synchronously before `open-vault` returns, using a fire-and-forget/background task instead | The renderer's `PluginManager.initialize()` and `ThemeManager.apply()` both run after `open-vault` resolves and read whatever is on disk at that point. Seeding must complete (or fail-safe) before the handler returns, or the very first render would race the seed. |

## Consequences

- **What becomes easier:** any organization can distribute a customized
  build of Geode — with their own house theme and a curated plugin
  set pre-installed — using only their own build/package step. No fork of
  application code is required to do this; `resources/default-theme/<name>/`
  and `resources/default-plugins.json` are the entire interface.
- **What stays exactly the same:** every existing upstream user. This PR
  ships no default plugin list and no default theme, so `bootstrapFreshVault`
  is a no-op for every vault opened against an unmodified build of this repo
  — the no-op path is covered directly by `tests/unit/default-vault-bootstrap.test.ts`.
- **What we're betting on:** that "drop files into `resources/` before
  building" is a low-enough bar for a deployer who is already running their
  own `electron-builder` packaging step, without needing a config flag,
  environment variable, or separate manifest to opt in.
- **What would make us revise this:** a deployer needing more than one theme
  seeded (not supported — one theme, chosen deterministically), or needing
  seeding to re-run against a vault that's already been opened (explicitly
  out of scope — this mechanism only ever touches a vault once, on its very
  first open).

## Test plan

- **`tests/unit/default-vault-bootstrap.test.ts`** — the no-op path when
  neither resource exists (most important: this is what every existing
  upstream user experiences); the already-has-`.geode/` guard, proven with an
  `installCommunity` stub that throws if called at all; successful seeding of
  both theme and plugins via a fake `installCommunity`; a partial-failure
  case where one plugin install rejects and the rest still seed and
  `bootstrapFreshVault` still resolves; and the two mixed cases (theme
  present without a plugin list, and vice versa) confirming the two steps are
  genuinely independent.
- **`GEODE_RESOURCES_DIR`** env var override (mirroring the existing
  `GEODE_POLICY_PATH` / `GEODE_GITHUB_API_BASE` test/dev-override precedent)
  lets the unit tests point at a temp directory instead of the repo's real
  `resources/` folder — never set in production, so the real default-content
  lookup path (`__dirname`-relative, matching `main.ts`'s existing
  `resources/icon.png` convention) is exercised unmodified by every no-op
  test that doesn't set it.
- Not re-tested here: `installCommunity` itself (file-safety, atomic
  install) — already covered by `tests/unit/community-resolve.test.ts` and
  `tests/e2e/community-install.spec.ts`; this feature only adds a caller.
