# PM Config

> Routing manifest for PM agents. Product state lives in the resolved providers, not in this file. Follow the installed `integration-routing` skill.

## Product

- **Product:** Geode
- **Description:** Open-source, local-first Markdown knowledge base -- a clean-room clone of Obsidian (Electron + TypeScript + CodeMirror 6), built to eventually host the Claude Threads plugin independent of Obsidian's proprietary plugin ecosystem.
- **Team:** Solo (Rick Bowman)

## Integration Routing

- **Contract version:** 2
- **Integration profile:** compass-full

### Provider overrides

<!-- Omit capabilities that use profile defaults. One provider value per override. -->

```yaml
provider_overrides:
  reporting_archive: obsidian
```

`reporting_archive` overrides the compass-full default (`compass_docs`) because geode's
durable run reports already live at `Products/Geode/Runs/*.md` in the vault and there is
no reason to fork that into Compass Docs. `delivery` keeps the compass-full default
(`compass_tasks`) — geode engineering work will be tracked in Compass Tasks going
forward. This is a routing decision only: past work tracked via GitHub PRs/branches is
not backfilled into Compass, and PRs/branches remain the actual git mechanics; Compass
Tasks becomes the authoritative record of *what* delivery work exists and its status.

### Resolved providers

| Capability | Authoritative provider |
|---|---|
| vision | compass_docs |
| research_capture | compass_research |
| insights | compass_feedback |
| okrs | compass_okrs |
| ost | compass_discovery |
| experiments | compass_experiments |
| roadmap | compass_roadmap |
| delivery | compass_tasks |
| reporting_archive | obsidian |

## Workflow Routing

- **Workflow profile:** compass-native-review

### Workflow overrides

<!-- Omit workflow capabilities that use profile defaults. One provider value per override. -->

```yaml
workflow_overrides: {}
```

`compass-native-review` routes both review requests and immutable decision records to
`compass_decisions`. Its decisions are tracking-only: agents may request and read them,
only human admins decide, and no outcome automatically applies another action.

### Resolved workflow providers

| Workflow capability | Provider |
|---|---|
| automation_runtime | geode |
| review_requests | compass_decisions |
| decision_records | compass_decisions |
| notifications | geode |
| prototype_artifacts | compass_docs |
| product_analytics | manual_input |

## Provider Connections

### Compass

- **Org slug:** rbcodelabs
- **Workspace slug:** geode
- **Workspace ID:** `2014ad67-8d4f-4db9-8eb5-5f3958c3ebbb`
- **Compass URL:** https://compass.rbcodelabs.com/rbcodelabs/geode/discovery
- **Credential location:** Not applicable -- this repo does not call Compass
  programmatically. Claude Code sessions read/write Compass via the connected,
  session-authenticated Compass MCP server; no static credential is stored here or
  in the repo.

### Obsidian / Markdown

- **Vault:** current runtime-configured vault (resolve against the runtime-provided
  vault root -- never a machine-specific absolute path)
- **Product folder:** `Products/Geode/`
- **Role:** authoritative only for `reporting_archive` (`Products/Geode/Runs/geode-<YYYY-MM-DD>-<slug>.md`).
  Not authoritative for vision, research, insights, OKRs, OST, experiments, or roadmap --
  those are Compass. The vault note `Claude/2026-07-21-geode-obsidian-clone-status-review.md`
  is a **labeled `snapshot`**: a one-time status review imported into Compass on
  2026-07-21 and kept only as historical record, not a live secondary copy.

### Linear / Jira / JPD

- Not used. `delivery` is routed to `compass_tasks`.

### Workflow connections

<!-- Include only providers resolved by the workflow profile. Paths are examples, not defaults. -->

- **Automation runtime:** geode -- scheduled items run via this Claude Threads
  plugin environment (`CronCreate`/`ScheduleWakeup`); no external credential required.
- **Review requests:** compass_decisions -- Compass workspace `geode`; decisions are
  **tracking-only** (human admins decide; no outcome auto-applies another action). Primary,
  not a secondary copy.
- **Decision records:** compass_decisions -- same Compass workspace `geode`.
- **Notifications:** geode -- delivered in-thread / via scheduled digest inside this
  Claude Threads environment. No fallback channel is configured; per the
  integration-routing invariants, notification fallbacks must stay explicit, so none is
  assumed.
- **Prototype artifacts:** compass_docs -- Compass workspace `geode` Docs.
- **Product analytics:** manual_input -- no automated analytics provider is connected;
  metrics are recorded manually when needed. No credential required.

## Active Context

> **Pointers only.** This block records WHICH Compass records are in focus, never their
> values, progress, status or composition. Resolve current state with `get_okr_cycle` /
> `get_opportunity` at read time. Titles are included only as human labels for the IDs --
> the ID is the contract. Never record a KR's current/target here: a number in this file
> that disagrees with Compass is worse than no number, because it reads as authoritative.
>
> Update this block when FOCUS changes (a new cycle activates, a different KR becomes the
> one being worked), not when a value moves.

- **OKR cycle:** `ce9cd60f-ae04-4eb8-927b-76f1fd0872fa` -- "Q3 close-out -- parity blockers"
- **Active objective:** `c2e32aaa-e96a-4b6d-8b32-852df6248715` -- "A daily Obsidian user
  can switch to Geode without hitting a wall"
- **Active KRs:**
  - `d827f54c-7038-4b74-aeea-8957ae536ad9` -- day-one blocking gaps (image paste, math,
    footnotes)
  - `721651b6-4977-4cff-a861-9591f767a4d5` -- Obsidian help-page parity requirements
    assessed in the ledger
  - `70e1ef16-97e4-420d-a614-b19dded285f8` -- community plugins with committed E2E
    certification
- **Desired outcome:** Ship a functional, MIT-licensed Obsidian alternative with a plugin
  API layer sufficient for the Claude Threads plugin to run on it independent of
  Obsidian's proprietary plugin ecosystem.
- **Focus opportunity:** `7aa10909-1eb6-49b8-9471-e6f2759beeb1` -- "Core Obsidian features
  a daily user reaches for are missing, so Geode can't replace Obsidian for real work"
- **Strategic thesis (not the current focus):** `eaf7efe5-519f-4136-9454-b4f5368e905a` --
  "Claude Threads needs an OSS-host independent of Obsidian's proprietary plugin
  ecosystem". Sequenced behind parity, because parity gates it rather than competing
  with it.
- **Focus solution:** "Geode -- clean-room Obsidian clone (Electron + CM6) with an open
  plugin API layer" (ID `2cd646b1-dede-4cfb-bf8e-22a932d88170`)

## Portfolio Policy

<!-- These are workflow constraints, not a duplicate of roadmap state. Tune them to the team's real capacity. -->

```yaml
portfolio_policy:
  now_limit: 2
  next_limit: 3
  concurrent_validation_limit: 2
  require_validated_solution_for_next: true
  require_displacement_when_full: true
  require_owner_for_now: true
  require_capacity_data_for_now: true
```

If a required limit or capacity signal is unknown, scheduled stewards may prepare
validation work in `LATER` but must not infer permission to add work to `NEXT` or `NOW`.

## Build Authorization Policy (opt-in)

```yaml
build_authorization_policy:
  enabled: false
  version: build-authorization-v1
  project_id: unresolved
  workspace_id: unresolved
  repository: unresolved
  activated_at: unresolved
  activation_authority: unresolved # exact human instruction/decision reference
  receipt_store: unresolved # durable automation-runtime store, separate from decisions
  serialized_executor: unresolved # verified single executor or conditional lease
```

**Blocker:** no build-authorization runtime (receipt store, serialized executor) has been
set up for geode yet, and no human activation instruction has been recorded. Leave
disabled -- current build execution follows the existing separate legacy gate (isolated
worktree, delegated engineering, verified tests, human PR review) described in this
repo's `CLAUDE.md`, not standing build authorization.

Enable only under explicit human authorization after installed workflow, provider and
runtime checks in `build-authorization`. Missing fields block execution. This standing
policy permits a current approved build package through a tested PR, including its exact
roadmap admission. It grants no merge or production authority. Existing decisions are
not grandfathered. Package-specific limits and scope stay in the decision provider.

## Delivery Completion Policy

```yaml
delivery_completion_policy:
  production_verification: required
  stale_in_review_after_hours: 24
  launch_required_for: [major, minor]
  silent_release_can_ship_directly: true
  unsupported_solution_status: warn_and_receipt
  smoke_followup_provider: compass_feedback
  capacity_change_dispatch: roadmap_steward
```

Geode is a desktop Electron app with no live production URL, so `production_verification:
required` is satisfied specifically by **a tagged GitHub Release with built artifacts
published** -- a passing local build or `npm run e2e` on the release commit is necessary
but not sufficient on its own; preview/local success never substitutes for the published
release. `smoke_followup_provider` routes any non-blocking post-release feedback to the
resolved insights provider (`compass_feedback`).

This policy controls lifecycle reconciliation after a human merge. It never grants merge
authority and never permits preview success to substitute for production verification.

## Provider-owned paths

<!-- Include only paths actually owned by filesystem/Obsidian/Markdown capabilities. Obsidian
paths must be vault-relative and are resolved against the runtime-provided vault root; never
store host-specific absolute or home-relative vault locations here. Do not add placeholder
paths for Compass/JPD-owned state. -->

- reporting_archive: `Products/Geode/Runs/geode-<YYYY-MM-DD>-<slug>.md`

## Agent Behavior Overrides

**Compass is the authoritative source of truth for roadmap, opportunities, solutions,
assumptions, and OKRs for this project** (per `ost`, `roadmap`, `okrs` routing above).
The following are legacy/historical sources only -- do not treat them as current planning
state, and do not edit them to reflect roadmap changes:

- `docs/spec/00-overview.md` § "Implementation status (v0.1)" -- the numbered roadmap
  items (0-10) there are a point-in-time snapshot from when Geode was created and are
  **not** kept in sync with Compass. For current priority and horizon (NOW/NEXT/LATER/SHIPPED),
  check the Compass roadmap (`list_roadmap_items`, workspace `2014ad67-8d4f-4db9-8eb5-5f3958c3ebbb`),
  not this file.
- Obsidian vault note `Claude/2026-07-21-geode-obsidian-clone-status-review.md` -- a
  one-time status review, labeled `snapshot`; its contents were imported into Compass on
  2026-07-21 and it should be treated as historical record only.

The `docs/spec/*.md` files (00-04) remain valid as **technical specification**
references -- they describe Obsidian's documented behavior that Geode is cloning -- they
are just no longer the source of truth for *prioritization or roadmap sequencing*. When
in doubt about what to build next, defer to Compass's NOW horizon.

`delivery` now routes to `compass_tasks` (see Provider overrides above): when creating or
updating engineering work items for geode, record them in Compass Tasks as the
authoritative status source, in addition to whatever GitHub branch/PR actually carries
the code. Do not treat GitHub issues/PRs alone as the delivery system of record going
forward.
