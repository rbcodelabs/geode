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
```

A demo vault lives in `test-vault/`.
