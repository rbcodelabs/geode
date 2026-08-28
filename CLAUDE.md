# Claude Code — geode

An open-source, local-first Markdown knowledge base -- a clean-room clone of Obsidian (Electron + TypeScript + CodeMirror 6). Long-term goal: a plugin API layer that can host the Claude Threads plugin independent of Obsidian's proprietary ecosystem.

## Product Planning — Compass is source of truth

Roadmap, opportunities, solutions, assumptions, and OKRs for Geode live in **Compass**, not in this repo or the Obsidian vault:

- Workspace: https://compass.rbcodelabs.com/rbcodelabs/geode
- Config/IDs for PM agents: see [`pm-config.md`](pm-config.md)

**Do not use as current planning state** (superseded, historical only):
- `docs/spec/00-overview.md` § "Implementation status (v0.1)" — the numbered roadmap list (0-10) is a point-in-time snapshot, not synced with Compass
- Obsidian vault note `Claude/2026-07-21-geode-obsidian-clone-status-review.md` — one-time status review, imported into Compass 2026-07-21

The `docs/spec/*.md` files remain valid as **technical specification** references (Obsidian's documented behavior Geode is cloning) — just not as a roadmap/priority source. Before starting any planning or "what's next" work here, check Compass's NOW horizon first.

## Spec library

See [`docs/spec/00-overview.md`](docs/spec/00-overview.md) for the full reverse-engineered specification of the target feature set (core app, 30 core plugins, plugin API surface, file formats). Reference only — not the roadmap.

## Develop

```bash
npm install
npm run build      # bundle main/preload/renderer with esbuild
npm start           # launch Electron
npm run dev         # esbuild watch mode
npm run typecheck   # strict tsc
npm run e2e:kill    # reap orphaned e2e Electron processes + temp dirs
```

A demo vault lives in `test-vault/`.

## E2E tests are not headless

`_electron.launch()` has no headless mode — Playwright's `headless` option
applies to browsers, not Electron. The suite instead launches the real app with
`GEODE_HEADLESS=1`, which makes `src/main/main.ts` create windows with
`show: false` and set the macOS activation policy to `accessory` (hidden from
Dock and menu bar, never steals focus). Anything that shows or focuses a window
must be guarded by `isHeadless` or it will defeat this.

Each spec holds a throwaway `--user-data-dir` under the OS temp dir. Interrupted
runs orphan those processes and leak those dirs, so `playwright.config.ts` reaps
before and after every run (`scripts/e2e-reap.mts`). If a run is hard-killed,
`npm run e2e:kill` does it by hand — use that rather than `pkill -f electron`,
which also kills unrelated Electron apps.
