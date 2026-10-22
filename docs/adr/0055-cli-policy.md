# ADR 0055 — Managed policy in the headless `geode-wiki` CLI

Status: Accepted
Date: 2026-10-22
Builds on [ADR 0002](0002-enterprise-plugin-policy.md) (fail open, read fresh), [ADR 0051](0051-policy-layering.md)
(machine plus narrowing-only vault layering), [ADR 0024](0024-wiki-cli-over-mcp-server.md) and
[ADR 0025](0025-geode-wiki-sync-cli.md) (the CLI import rule, the fixed scheduled command line).
Design: [enterprise-controls.md](../design/enterprise-controls.md), sections 3 and 4b.

## Context

`geode-wiki sync` can touch a vault root, serve a hub and install an unattended launchd/systemd job. The
`sync` and `daemons` policy areas already validate and layer (stage 1) but nothing in the CLI read them.

## Decision

1. **The CLI evaluates policy itself, fresh, on every invocation.** No cache, no watcher. A missing,
   unreadable, oversized or invalid machine or vault file imposes nothing (fail open, ADR 0002).
2. **One loader, no Electron.** The machine-path and file-reading logic moved from `src/main/policy-loader.ts`
   (which re-exports it, so the main process is unchanged) to `src/policy-node/policy-files.ts`. It adds
   optional `env`/`platform` parameters so `GEODE_POLICY_PATH` is honoured from the CLI's context env.
   Layering is the app's own `resolveEffectivePolicy`, so `vaultPolicy: "ignore"` is honoured, and the vault
   file read is `<--root>/.geode/policy.json`.
3. **Import audit: one narrow, documented exception (rule 6).** Only `src/cli/policy.ts` may import
   `src/policy-node/index.ts`; `policy.ts` may import nothing else outside `src/cli/`; `src/policy-node/` may
   reach only itself and the two pure modules `src/renderer/policy.ts` and `policy-layering.ts`, which in
   turn may import only each other. Every other renderer, main and preload module stays forbidden, and
   `tests/unit/cli-import-audit.test.ts` carries negatives for each edge. The decisions themselves
   (`src/cli/policy-decisions.ts`) import nothing from `src/`.
4. **A dedicated exit code, 6**, status `blocked-by-policy`, name `policy`, in the usual `--json` envelope
   (`result` has `policy` = `sync` or `daemons`, `setting`, `message`, and `layers` when known). Messages read
   "blocked by administrator policy: sync (sync.enabled) - ...". Nothing is changed when it is returned.
   Exit 6 is a normal outcome for scheduled runs: `NORMAL_EXIT_CODES` includes it, `schedule status` labels
   it, and newly written systemd units carry `SuccessExitStatus=4 5 6`.

## Enforcement points

| Setting | Refused (exit 6) | Still allowed |
|---|---|---|
| `sync.enabled=false` | `sync init`, `preview`, `run`, `resolve`, `gc`, `serve` (stdio and `--http`), `schedule install` | `status`, `conflicts`, `schedule print`, `schedule status`, `schedule uninstall` |
| `daemons.allowSchedule=false` | `schedule install` (with or without `--activate`); a `sync run` started by an installed unit | `schedule print|status|uninstall`; a `sync run` typed in a terminal |
| `daemons.allowServe=false` | `sync serve` (stdio and `--http`), before the store is opened or a port is bound | everything else |
| `daemons.allowedListenAddresses` | `sync serve --http --listen <host>:<port>` when `<host>` is not admitted, before binding | |

Listen rule: the host is matched textually after normalisation (brackets stripped, lower-cased, IPv6
canonicalised). DNS names are never resolved; a name passes only if it is itself listed. `127.0.0.1`, `::1` and
`localhost` form one loopback class (listing one admits all). `0.0.0.0`, `::` and the empty host pass only if
that exact wildcard is listed. An empty list allows nothing; an absent list means no restriction.

Already-installed schedules: the scheduled command line stays exactly `sync run --root <root> --json` (ADR 0025;
no new flags, and units written earlier cannot change). The run therefore recognises itself from the service
manager's environment: `INVOCATION_ID` (systemd) or `XPC_SERVICE_NAME` starting `com.geode.wiki-sync.` (launchd).
Under `allowSchedule=false` such a run exits 6 before any sync. `sync.enabled=false` needs no detection: every
`sync run` refuses.

## Non-destructive

Refusals happen before the vault, the state directory or the store are opened. Policy never deletes history,
vault content, bindings, or the installed unit files; `schedule uninstall` keeps working so a user can remove
them. Removing the policy re-enables everything on the next invocation.

## Failure modes

- Policy file missing or invalid: no restriction, an error line on stderr for unreadable or unparseable files.
- Policy evaluation throws: logged, treated as no restriction.
- Units installed before this change list `SuccessExitStatus=4 5`: a policy refusal makes that oneshot show as
  failed in `systemctl`. It is not restarted. Reinstalling (`schedule install`, if the policy allows) rewrites
  the unit with `4 5 6`.
- launchd has no notion of a normal exit status; `schedule status` reads the run's envelope from the log.

## Limits (read these)

`geode-wiki` is a user-runnable build artifact. This is a **guardrail on the shipped binary, not a security
boundary.** A user who can build the CLI from source, edit the bundle, run the engine library directly, unset
`INVOCATION_ID`/`XPC_SERVICE_NAME`, or write the machine policy path is not stopped. The scheduled-run
detection is a heuristic (spoofable; a hand-run `systemd-run` of `sync run` looks scheduled). The vault file is
inside the user's trust boundary and can only narrow. Orgs needing a hard boundary need endpoint controls
(application allowlisting, network egress rules, removing the `launchd`/`systemd` user-unit directories from
what a user may write).

## Alternatives rejected

- Importing `src/main/policy-loader.ts` into the CLI: it is Electron-adjacent and under a forbidden prefix.
- Adding a `--scheduled` flag to the unit command: changes the fixed command line (ADR 0025) and cannot reach
  units already installed, which is the important case.
- Blocking every `sync run` under `allowSchedule=false`: that is the `sync` switch's job, not the daemon switch's.
- Resolving DNS names for `--listen`: introduces a time-of-check gap and trusts a resolver; textual matching
  is simpler and fails closed.
