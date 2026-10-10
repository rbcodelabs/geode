# ADR 0025 — `geode-wiki sync`: unattended sync behind safety rails

Status: Accepted
Date: 2026-10-09
Extends [ADR 0024](0024-wiki-cli-over-mcp-server.md) (the CLI surface and its
import rule) and [ADR 0016](0016-causal-append-only-vault-history.md) (the
append-only history engine this drives).

> Numbering note: `0025-node-dsql-private-blob-adapter.md` already holds this
> number. The directory already carries several duplicated numbers (0003, 0004,
> 0007, 0015, 0016, 0022); this ADR was requested as 0025 and keeps that number.
> Reference it by file name.

## Context

The append-only history engine was extracted into `src/sync-core/` (platform
neutral) and `src/sync-node/` (Node host, hub stores, ssh transport). What did
not exist was a way to *run* it without Electron: a cron job or an agent keeping
a directory in step with a hub over ssh.

The desktop app puts a human in front of every consequential step: a preview
dialog before the first sync, a conflict dialog, a visibly-unmounted volume.
Unattended, none of that is there, and the engine's own model of the world is
exactly as trusting as it is on the desktop. Two facts make that dangerous:

- **Absence is evidence.** The engine infers "the user deleted it" from a file's
  absence in a complete scan. A volume that failed to mount, a wrong `--root`, an
  iCloud eviction wave, or a crashed `rsync` all produce a complete-looking scan
  that is mostly empty, and the correct response to that scan *is* to publish
  thousands of deletions.
- **Append-only is not undoable.** Deletions are recoverable from history and
  from the device trash, but they propagate to every other device, which then
  deletes locally. "Recoverable" is not "harmless" at 3 a.m.

So the CLI needs rails that stop a run *before* it changes anything, and those
rails cannot live in the engine's planner (which is shared with the desktop and
has a human to ask) or in the argument parser (which must stay thin).

## Decision

### Surface

`geode-wiki sync <init|preview|run|status|conflicts|resolve|serve|gc>`, every
command with `--json` in the existing envelope. Two exit codes are added to the
existing 0–3: **4 = unresolved conflicts**, **5 = another sync holds the lock**.
Both are reserved for `sync`; nothing in the vault/catalog vocabulary can
produce them (`conflicts` and `locked` are distinct from the engine's `conflict`).

`sync serve --store <dir>` is what `ssh <host>` runs on the hub
(`geode-wiki sync serve --store '<path>'`); it replaces the draft name
`sync-serve`, which was never released.

### The workflow lives in `src/sync-node/wiki-sync.ts`

The CLI file (`src/cli/sync.ts`) parses and formats. The rails, the per-vault
config and the error-to-status mapping are in one Node module exported through
`src/sync-node/index.ts`, so they are testable in-process and the CLI's import
audit stays small. `HistoryController` is not modified.

### Four rails, all evaluated before any file changes

1. **First run needs an approved preview.** `sync preview --approve` records the
   exact preview signature in device state. `sync run` on a vault whose
   controller is not yet approved re-plans and compares: no record is
   `approval-required`; a record for a different plan is `approval-stale`
   (the vault or the store moved since a human looked). A plain `preview` is not
   an approval. Each device approves its own first run. The record is cleared
   after a successful run.
2. **Deletion limit.** Refuse when a run would delete more than
   `max(20, floor(1% of the files found))` items — in either direction,
   including deletions a *remote* device published that this device is asked to
   apply. Status `delete-limit-exceeded`. Counts include folders (the planner
   does not split them); that errs toward refusing.
3. **Shrunk scan.** Refuse when the scan found fewer than 50% of the content
   files this device already tracks (`scan-shrunk`). Blocked and excluded paths
   count as found — they exist on disk — so a vault of unsettled placeholders is
   not mistaken for an unmounted one. Evaluated inside the snapshot port, so it
   fires in `preview` and `resolve` as well and before any hashing result is used
   to plan.
4. **iCloud.** Placeholders and evicted files are *blocked*: reported, never
   downloaded, never read as absent, never deleted locally or remotely (the
   controller treats a blocked path and its descendants as untouchable; this is
   asserted end to end, with the remote having deleted the file). Downloading
   (`brctl download`) requires `--hydrate-icloud`.

### Overrides are explicit, specific and loud

- `--override-delete-limit <n>` allows up to `n` deletions. It *replaces* the
  limit; it does not disable it, so `n` smaller than the plan still refuses.
- `--override-shrunk-scan`, `--hydrate-icloud`.

There is no single `--force`. Each override prints a `WARNING:` line to stderr
(even under `--json`) and appears in the payload (`rails.overridesActive`). The
refusal payload names the flag that would lift it. Overrides are independent:
lifting the shrunk-scan rail on an empty mount point still meets the deletion
limit, which the proof demonstrates.

### Per-vault binding

`sync init` writes `cli-config.json` (store target, vault descriptor, device id,
excluded folders) into the device state directory, which is outside the vault and
keyed by the realpath of the vault root (`~/.geode/sync/root-<hash>`, overridable
with `GEODE_SYNC_HOME` or `--state-dir`). `--ssh <host> --store <path>` selects
the ssh transport; `--store <path>` alone is a local directory hub. An empty store
needs `--create`, so a typo cannot silently start a second history.

### Concurrency

The cross-process lock already in `NodeHost.run` is the only mutual exclusion.
A held lock is exit 5 and happens *before* the store is contacted. `status` and
`conflicts` read device state without taking the lock, so they answer while a run
is in progress (and `status` reports the holder's pid).

### Scheduling (`sync schedule`)

Unattended use is the reason for the rails, so scheduling is part of the same decision rather than a
recipe left to the reader. `sync schedule print|install|uninstall|status` renders a launchd plist or
systemd user service+timer around one fixed command, `sync run --root <dir> --json`, with absolute node
and CLI paths. Decisions:

- **A schedule cannot lift a rail.** The command line is constructed in one function and contains no
  `--override-*` or `--hydrate-icloud`; `schedule` does not parse them. Lifting a rail stays a person
  at a terminal.
- **The first-run rail is not bypassed.** `install` refuses unless the root is bound and its first run
  has been approved (`not-initialised` / `schedule-not-approved`). A schedule whose every run would be
  `approval-required` is worse than no schedule.
- **Nothing activates implicitly.** Files are written to `--target-dir`; `launchctl bootstrap` /
  `systemctl --user enable --now` run only with `--activate`, as do their inverses on `uninstall`.
  `status` only reads.
- **4 and 5 are outcomes, not failures.** systemd units list them in `SuccessExitStatus`. launchd cannot
  express this, but an interval job without `KeepAlive` is only annotated with its last exit code; the
  JSON envelope each run appends to the stdout log names the outcome, and `status` reads it back.
- **No new engine surface.** The schedule module imports nothing from `src/`; `sync.ts` hands it the one
  engine fact (is this root approved, and where is its state directory) from `syncStatus`. The audit gained
  a rule pinning that.
- Alternatives rejected: a long-running `sync watch` daemon (a second lifecycle to supervise, and launchd
  already supervises); a wrapper command that maps 4 and 5 to 0 (hides the numbers from the supervisor and
  adds a second entry point for `run`).
- Not verified: a real `launchctl bootstrap` / `systemctl --user` activation, and a real scheduled firing
  (the proof and tests use recording stubs and execute the scheduled command once by hand).

### Import rule

ADR 0024's rule allowed `src/cli/` two entry points. It now allows three, with
tighter edges, as a shared function (`scripts/cli-import-audit.mjs`) used by both
proofs and by a unit test that feeds it broken graphs:

- `src/cli/*` may reach only `src/wiki/index.ts`, `src/catalog/index.ts`,
  `src/sync-node/index.ts` and siblings;
- only `src/cli/sync.ts` may import the sync entry point, and it may import
  nothing else outside `src/cli/`;
- `src/cli/sync-schedule.ts` imports nothing from `src/` outside `src/cli/`;
- inside the bundle, `src/sync-node` reaches only `sync-node`/`sync-core`/`shared`
  and `src/sync-core` only `sync-core`/`shared`;
- nothing from `indexer`, `main`, `preload`, or `renderer` beyond the two helpers
  the SDK already inherits; and no engine module imports `src/cli/`.

## Options considered

- **Put the rails in the planner.** Rejected: the planner is shared with the
  desktop, where a person is the rail, and any threshold there would change
  desktop behaviour. The rails need a host that has opted into being unattended.
- **A single `--force`.** Rejected: it lifts rails nobody meant to lift. The
  incident that motivates the shrunk-scan rail (an empty mount point) is exactly
  the one where an operator reaching for `--force` to get past a *different*
  refusal would publish a mass deletion.
- **A separate `geode-wiki-sync` binary.** Rejected: ADR 0024's agents want one
  command with one envelope. The import audit gives the isolation instead.
- **Use the controller's own `previewSignature` as the approval.** Insufficient:
  it is overwritten by any later preview, so a human approval and a cron job's
  automatic preview are indistinguishable. A separately recorded approval is what
  a person actually signed off on.
- **Server-side (hub) garbage collection in `sync gc`.** Deferred: the hub is
  append-only and shared; reclaiming it needs a retention protocol among devices.
  `gc` is device-local (private storage and optionally trash).

## Consequences

- An unattended run can be wrong in only two ways the rails do not cover:
  a plan that is under the limits but wrong, and a change that lands between the
  rail check and the apply. The second window is the length of one plan and is
  bounded by the same lock; it is not closed, and a *resumed* interrupted batch
  skips the deletion pre-check (the scan rail still applies) because the engine
  offers no preview while a batch is pending.
- The deletion count includes folders; in a vault with deep trees the effective
  limit in files is somewhat lower than stated.
- `--exclude` folders change the scope key, so adding one re-requires approval,
  and a folder newly excluded after files were tracked can trip the shrunk-scan
  rail (excluded paths are counted as found, which usually prevents this).
- The three-entry-point rule makes the CLI's exact input set larger (sync-core
  and sync-node files); `scripts/run-wiki-cli-proof.mjs` pins the new set.
- Not verified here: real ssh to a real remote host (a stand-in executes the
  real command line), real iCloud placeholders on a real iCloud volume (stubs and
  a recording `brctl`), and long-running scale.

## Verification

`tests/unit/sync-cli.test.ts`, `tests/unit/sync-schedule.test.ts`, `tests/unit/cli-import-audit.test.ts`, and
`npm run proof:wiki-sync` (real subprocesses, two vaults, ssh stand-in). See
[headless-wiki-sync.md](../design/headless-wiki-sync.md).
