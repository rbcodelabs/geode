# `geode-wiki sync` — reference

The reasoning (why rails, why these four, why not `--force`) is in
[ADR 0025](../adr/0025-geode-wiki-sync-cli.md). This is what the commands do.
It builds on [headless-wiki-cli.md](headless-wiki-cli.md) (envelope, exit codes
0–3, import rule) and drives the engine in `src/sync-core/` through the Node host
in `src/sync-node/`.

```bash
npm run build:cli                       # -> dist/cli/geode-wiki.mjs
geode-wiki sync --help
```

## Quick start

```bash
# On the hub machine nothing is installed except geode-wiki on PATH (ssh runs `geode-wiki sync serve`).
geode-wiki sync init    --root ~/Notes --ssh hub --store /srv/notes-hub --create   # first device
geode-wiki sync preview --root ~/Notes                                              # read it
geode-wiki sync preview --root ~/Notes --approve                                    # sign off on THAT plan
geode-wiki sync run     --root ~/Notes                                              # first run
geode-wiki sync run     --root ~/Notes                                              # from cron, thereafter

geode-wiki sync init    --root ~/Notes2 --ssh hub --store /srv/notes-hub            # another device: no --create
```

## Commands

| Command | Does | Takes the lock | Touches the store |
|---|---|---|---|
| `init --store <p> [--ssh <host>] [--create] [--name n] [--exclude f]...` | Bind this folder to a hub; write `cli-config.json` to the state dir | no | yes (discover / create) |
| `preview [--approve] [overrides]` | Plan without applying; `--approve` records the plan's signature | yes | yes |
| `run [overrides]` | Preview, check rails, then apply. Resumes an interrupted batch | yes | yes |
| `status` | Binding, approval, known files, conflicts, blocked, running pid | no | no |
| `conflicts` | Unresolved conflicts with each version's device/size/hash | no | no |
| `resolve <path> (--keep local\|remote \| --version <recordId>) [overrides]` | Settle one conflict | yes | yes |
| `serve --store <dir>` | Serve a store over stdio (binary frames only on stdout; no `--root`) | n/a | is the store |
| `gc [--trash-days n]` | Reclaim sync-private storage; with `--trash-days`, purge trash older than n days | yes | no |

Common options: `--root <dir>` (required except `serve`), `--state-dir <dir>`,
`--settle-ms <n>` (defer files modified within n ms; default 5000), `--json`.

State directory default: `~/.geode/sync/root-<sha256(realpath root)[:16]>`
(`GEODE_SYNC_HOME` moves the base). It must be outside the vault; init refuses
otherwise (`state-dir-invalid`).

## Exit codes and statuses

| Code | Name | Statuses |
|---|---|---|
| 0 | ok | `ok` |
| 1 | refused | `approval-required`, `approval-stale`, `delete-limit-exceeded`, `scan-shrunk`, `not-initialised`, `already-initialised`, `store-empty`, `no-such-conflict`, `invalid-version`, `ambiguous-remote`, `invalid-exclude`, `state-dir-invalid`, `scan-incomplete`, `pending-batch`, `config-invalid`, `sync-failed` |
| 2 | usage | `usage` (nothing ran) |
| 3 | unavailable | `vault-unavailable`, `store-unavailable`, `store-failed` |
| 4 | conflicts | `conflicts` — from `preview`, `run`, `status`, `conflicts`, `resolve` when conflicts remain |
| 5 | locked | `locked` — another run holds the lock; nothing was done |

`sync-failed` is the catch-all for an error the workflow does not recognise; its
`message` is in the payload. Statuses ride the usual envelope
(`command` is `"sync run"` etc.); refusal detail is in `result`, including
`override` — the flag that would lift a rail.

## Safety rails

| Rail | Refusal | Rule | Override |
|---|---|---|---|
| (a) first run | `approval-required` / `approval-stale` | The controller is not yet approved: a recorded approval must exist and match the plan a run would execute now | none — run `preview --approve` again |
| (b) deletions | `delete-limit-exceeded` | planned deletions (both directions, folders included) `> max(20, floor(1% of files found))` | `--override-delete-limit <n>` |
| (c) shrunk scan | `scan-shrunk` | files found `< 50%` of content files this device tracks; blocked and excluded paths count as found | `--override-shrunk-scan` |
| (d) iCloud | — | placeholders/evicted files are blocked: never downloaded, never deleted | `--hydrate-icloud` (download only) |

Order inside a run: lock → open store → scan (rail c) → plan → rail b → rail a →
apply. Everything before apply is read-only. Overrides print `WARNING:` on stderr
and are listed in `result.rails.overridesActive`. `--override-delete-limit n`
replaces the limit with `n`; the plan still has to fit under it.

Known gaps (also in the ADR): a resumed interrupted batch skips rail (b); a change
landing between the rail check and apply is bounded by the lock but not closed.

## Conflicts

A conflict is two or more heads for one entity. `run` leaves both sides intact and
exits 4. `conflicts` lists them; `resolve <path> --keep local` publishes this
device's version, `--keep remote` takes the other device's (refused as
`ambiguous-remote` if several exist — then use `--version <recordId>`). Resolution
is not subject to rails (b) and (a): it is an explicit, single-path action; the
scan rail still applies.

## Import rule

`src/cli/sync.ts` is the only CLI module that may import the sync engine
(`src/sync-node/index.ts`), and may import nothing else outside `src/cli/`. See
`scripts/cli-import-audit.mjs` for the full rule set.

## Proofs

| Command | What it proves |
|---|---|
| `npx vitest run tests/unit/sync-cli.test.ts` | Every status/exit, each rail and override, convergence, conflicts, lock, gc (in-process, real directories and hub) |
| `npx vitest run tests/unit/cli-import-audit.test.ts` | The real bundle passes the audit, and each rule fails, naming the edge, on a broken graph |
| `npm run proof:wiki-sync` | The built binary in real subprocesses: two vaults, a hub over a stand-in `ssh` running the real remote command line; all six exit codes; conflicts; deletes; each refusal; the lock held by one process and refused (exit 5) in another |
| `npm run proof:wiki-cli` | Unchanged claims, plus the exact input set now including the sync files |
