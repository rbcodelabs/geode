# PM Config

> This file is the single source of truth for how PM agents and skills operate in this product. Every agent reads it at the start of a session. Keep it current -- stale config produces stale agent behavior. Run `pm-setup` to regenerate it, or edit directly. Any agent that updates focus (active objective, KR, opportunity) should update this file as part of its output.

---

## Product

- **Product:** Geode
- **Description:** Open-source, local-first Markdown knowledge base -- a clean-room clone of Obsidian (Electron + TypeScript + CodeMirror 6), built to eventually host the Claude Threads plugin independent of Obsidian's proprietary plugin ecosystem.
- **Team:** Solo (Rick Bowman)

---

## Notes System

- **Tool:** Obsidian (raw capture / historical only -- see Legacy Sources below)
- **Vault path:** /Users/rickbowman/Documents/Personal
- **Product folder:** Not scaffolded -- Compass is the discovery/roadmap layer for this product; no Obsidian PM scaffolding is used.

---

## Discovery Tool

- **Tool:** Compass
- **Compass org slug:** rbcodelabs
- **Compass workspace slug:** geode
- **Compass API key:** Not applicable -- this repo does not call Compass programmatically. Claude Code sessions read/write Compass via the connected Compass MCP server.
- **Compass URL:** https://compass.rbcodelabs.com/rbcodelabs/geode/discovery

_(Discovery Paths section omitted -- opportunities, solutions, and experiments live natively in Compass, not in markdown files.)_

---

## Issue Tracker

- **Tool:** None configured yet
- **Project / Team:** N/A
- **Workflow states:** N/A

---

## Active OKR Cycle

- **Cycle:** None yet -- no OKR cycle created in Compass for this workspace
- **File:** N/A
- **Period:** N/A
- **Status:** N/A

---

## Active Focus

- **Active Objective:** None yet
- **Active KR:** None yet
- **Current Desired Outcome:** Ship a functional, MIT-licensed Obsidian alternative with a plugin API layer sufficient for the Claude Threads plugin to run on it independent of Obsidian.
- **Focus Opportunity:** "Claude Threads needs an OSS-host independent of Obsidian's proprietary plugin ecosystem" (ID `eaf7efe5-519f-4136-9454-b4f5368e905a`)
- **Focus Solution:** "Geode -- clean-room Obsidian clone (Electron + CM6) with an open plugin API layer" (ID `2cd646b1-dede-4cfb-bf8e-22a932d88170`)

---

## Roadmap Paths

_(Omitted -- roadmap items live in Compass under NOW/NEXT/LATER/SHIPPED horizons, not in markdown files.)_

---

## OKR Path

_(Omitted -- no OKR cycle active yet. Create one in Compass via `create_okr_cycle` when ready.)_

---

## Desired Outcome

Ship a functional, MIT-licensed Obsidian alternative with a plugin API layer sufficient for the Claude Threads plugin to run on it independent of Obsidian's proprietary ecosystem.

---

## Agent Behavior Overrides

**Compass is the authoritative source of truth for roadmap, opportunities, solutions, assumptions, and OKRs for this project.** The following are legacy/historical sources only -- do not treat them as current planning state, and do not edit them to reflect roadmap changes:

- `docs/spec/00-overview.md` § "Implementation status (v0.1)" -- the numbered roadmap items (0-10) there are a point-in-time snapshot from when Geode was created and are **not** kept in sync with Compass. For current priority and horizon (NOW/NEXT/LATER/SHIPPED), check the Compass roadmap (`list_roadmap_items`, workspace `2014ad67-8d4f-4db9-8eb5-5f3958c3ebbb`), not this file.
- Obsidian vault note `Claude/2026-07-21-geode-obsidian-clone-status-review.md` -- a one-time status review; its contents were imported into Compass on 2026-07-21 and it should be treated as historical record only.

The `docs/spec/*.md` files (00-04) remain valid as **technical specification** references -- they describe Obsidian's documented behavior that Geode is cloning -- they are just no longer the source of truth for *prioritization or roadmap sequencing*. When in doubt about what to build next, defer to Compass's NOW horizon.
