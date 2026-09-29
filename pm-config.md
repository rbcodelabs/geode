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
| prototype_artifacts | compass_artifacts |
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
- **Prototype artifacts:** compass_artifacts -- Compass workspace `geode` Artifacts,
  as resolved by the selected `compass-native-review` profile. Versioned build
  plans remain Compass Docs; they are not prototype artifacts.
- **Product analytics:** manual_input -- no automated analytics provider is connected;
  metrics are recorded manually when needed. No credential required.

<!-- NO "Active Context" SECTION -- this is deliberate, do not re-add one.

Geode is provider-backed (Compass). Which cycle, objective and KR are active is resolved
at read time and is authoritative there:
  - active cycle       -> get_workspace_summary (returns activeOkrCycle)
  - all cycles/status  -> list_okr_cycles
  - objectives and KRs -> get_okr_cycle
  - opportunities      -> list_opportunities (status ACTIVE) / roadmap NOW horizon

A copy here is read by nothing -- no skill in agent-pm-playbook reads this section -- and
goes stale. It already did: this section once claimed "OKR cycle: None yet" while three
cycles existed and one was ACTIVE. See integration-routing/assets/pm-config-template.md.

Known gap: Compass has no first-class "focus" flag, so which single KR or opportunity is
being worked right now is not expressible in the provider. Tracked as Compass feedback
ff8ef8f9-dd6e-4365-a84d-3e0a8e461975 -- not worked around with a cache here. -->

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

## Approved Build Policy (opt-in)

```yaml
approved_build_policy:
  enabled: true
  activation_authority:
    type: synchronous_user_instruction
    date: 2026-09-20
    thread_id: 53f7e5e6-b062-4193-8003-78a5ee73fb6e
    instruction: "fix 3"
    context: >-
      Authorizes migration of the reported build-authorization contract mismatch
      to the installed Approved Build contract, including the existing operations
      prompt. This repairs configuration; it approves no additional product scope.
  workspace_id: 2014ad67-8d4f-4db9-8eb5-5f3958c3ebbb
  repository: github.com/rbcodelabs/geode
  decision_provider: compass_decisions
  completion_boundary: tested_pr
  excluded_actions: [merge, production_deploy, production_data_changes, external_messages, destructive_actions, additional_paid_resources]
```

The installed `build-authorization` skill is the execution contract. This explicitly
authorized migration replaces the legacy `build_authorization_policy`, first enabled
on 2026-09-15. It removes the obsolete evaluator, package digest, receipt-store and
exclusive-executor prerequisites. Do not enable both policies.

Authority requires a current exact synchronous instruction or a verified immutable
human build Decision and its approved scope/plan version. Verify author, outcome,
repository/workspace, scope, exclusions, expiry, supersession and revocation.
A generic concept approval, Solution Plan approval alone, roadmap horizon or lifecycle
status never grants build authority. Compass Decisions remain tracking-only with
`NO_ACTION`; their application receipts are bookkeeping, not proof of implementation.

Existing exact build approvals retain their original scope, exclusions, expiry and
any explicit admission or executor conditions. Retired package IDs remain correlation
identifiers. Preserve historical packages and receipts under
`Products/Geode/Operations/build-packages/` and
`Products/Geode/Operations/build-receipts/`; never use them as current authority,
create new legacy receipts, or require a retired evaluator.

**Specifically not grandfathered:** decision
`c2344f49-24dd-49b5-8a35-8404121d57a0` (2026-09-11) approved only bounded
Headless Phase 0 with no paid infrastructure. Phase 0 shipped in v0.18.0
(PRs #190/#195/#196). Sync and Compass document-store integration were explicitly
deferred and require new exact human build approval; this migration grants neither.

**Dispatch and ownership.** Geode Product Operations remains the one existing
scheduled discovery backstop. It may dispatch at most one dedicated worker per run
and then continue every independent checklist area. Do not create another resolver
or decision-router schedule. Direct authorized threads may use the same worker
procedure; the scheduler is not an exclusive executor or atomic lock.

Before code, create or reuse one Compass delivery Task with authority/plan references,
stable item ID, repository, intended branch, worker thread/run and timestamp. Inspect
the existing owner/runtime, open and closed linked PRs, exact branches and unlinked
PRs with overlapping behavior. Record IN_PROGRESS and re-read Tasks/PRs for collisions.
Repeat before code and publishing. These are best-effort collision checks, not
exactly-once guarantees. Never take over running or uncertain ownership. Resume the
recorded idle owner when supported; reconcile missing owners before documented takeover.
Checkpoint worktree, commits, tests and PR links on the same Task.

Roadmap titles describe work; never encode claims or blocked state in them.
Opportunity ACTIVE and Solution IN_DELIVERY describe lifecycle, never ownership.
Capacity controls roadmap admission; unknown capacity leaves horizons unchanged but
does not independently block an exact approved build, unless its human approval
explicitly conditions building on admission. Existing portfolio limits still govern
every admission/displacement operation.

Use isolated worktrees, delegated engineering where supported, repository checks and
reciprocal Task/authority/branch/PR links. An exact approved implementation plan
satisfies design-before-code; routine tests and review fixes remain covered.
Material scope changes require delta approval. Stop at a tested PR in IN_REVIEW.
Merge, release, production changes and external messages need separate authority.

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
