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
| `serve --store <dir> --http --token-file <file> [--listen host:port]` | Serve the store over WebSocket for the app and the iOS app (no `--root`; see HTTPS hub) | n/a | is the store |
| `gc [--trash-days n]` | Reclaim sync-private storage; with `--trash-days`, purge trash older than n days | yes | no |
| `schedule print\|install\|uninstall\|status [--interval s] [--platform launchd\|systemd] [--target-dir d] [--activate]` | Unit files for an unattended `sync run` (see Scheduling) | no | no |

Common options: `--root <dir>` (required except `serve`), `--state-dir <dir>`,
`--settle-ms <n>` (defer files modified within n ms; default 5000), `--json`.

**Per-path settle (`--settle-rule <folder-or-*.ext>=<ms>`, repeatable).** History is append-only and every version is a whole blob, so a file that is
appended to continuously (a Claude session log, `Claude/logs/<id>.jsonl`, up to ~100 MB) would be re-published in full on every sync: 8 GB of hub
blobs for one 30 MB log in a day was measured. Files matching a rule are deferred (`blocked: unsettled`, never read, hashed, published, deleted or
overwritten) until they have been quiet for the rule's window, then sync normally. Defaults: `Claude/logs=600000` and `*.jsonl=600000` (10 min); the
most specific rule wins (folder over extension, longer folder over shorter); `=0` opts a path out; a rule with the same path replaces the default.
`--settle-ms` is unchanged and still applies to every file. The desktop app (`SyncService`) and the CLI share the rule through
`buildHistoryPorts` (`src/sync-core/ports.ts`, `src/sync-core/settle.ts`). Trade-off: a log reaches other devices up to window + one sync interval
after its last write. This reduces the *rate* of growth; it does not make a single version smaller (see the chunked-storage design).

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

## HTTPS hub: `geode-wiki sync serve --http`

The ssh transport needs an ssh client, which a phone does not have. `serve --http` serves the same store protocol
over a WebSocket so the desktop app and the iOS app can use the hub with just a URL and a token. Why, and what
was rejected: [ADR 0029](../adr/0029-https-websocket-hub-transport.md); how the app side works:
[app-hub-sync-provider.md](app-hub-sync-provider.md#https-hub-desktop-and-ios).

```bash
geode-wiki sync serve --store /srv/notes-hub --http --token-file ~/.config/geode-wiki/hub.token --listen 127.0.0.1:8787
```

| Option | Meaning |
|---|---|
| `--http` | Serve over WebSocket instead of stdio. Without it, `--listen` and `--token-file` are a usage error (exit 2) |
| `--token-file <file>` | Required with `--http`. The shared secret, read from a file and never from argv (which `ps` shows). Trimmed; at least 24 characters or exit 2. A warning is logged if the file is readable by group/other |
| `--listen <host:port>` | Default `127.0.0.1:8787`. Also `:port` or `port`; IPv6 as `[::1]:8787`. A non-loopback host logs a warning that TLS is not terminated here |

It runs until SIGINT/SIGTERM (closing every connection with 1001 and finishing open sessions), logs to stderr, and
accepts at most 8 simultaneous connections. Each connection is one store session, so the engine's guarantees are
the same as over ssh. `--json` has no effect on a running server. `sync init` (the CLI device) still reaches a hub
only through a folder or `--ssh`; the HTTPS URL is entered in the app's Settings > Sync.

**TLS is not terminated by the server.** It speaks `ws://`, so bind it to loopback and put a TLS terminator in front.
`tailscale serve` does this and keeps the hub reachable only on your tailnet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
# the app's hub URL is then https://<machine>.<tailnet>.ts.net
```

(`tailscale serve` proxies to the local port; it is not Tailscale Funnel, which would publish the hub to the internet.)

### Token

Generate a token of at least 24 characters, with only URL-safe characters, and keep it private:

```bash
mkdir -p ~/.config/geode-wiki
head -c 36 /dev/urandom | base64 | tr -d '=+/\n' > ~/.config/geode-wiki/hub.token
chmod 600 ~/.config/geode-wiki/hub.token
```

Paste the same value into the app (Settings > Sync, HTTPS hub). The app keeps it in the OS secure storage
(Electron safeStorage, iOS Keychain), never in the vault. There is one token per hub; to revoke it, replace the file
and restart the server, then enter the new token on each device.

### Running it under systemd

`~/.config/systemd/user/geode-wiki-hub.service`:

```ini
[Unit]
Description=Geode wiki sync hub (WebSocket)
After=network-online.target

[Service]
ExecStart=/usr/bin/env node %h/geode/dist/cli/geode-wiki.mjs sync serve --store %h/notes-hub --http --token-file %h/.config/geode-wiki/hub.token --listen 127.0.0.1:8787
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now geode-wiki-hub.service
loginctl enable-linger "$USER"   # keep it running when you are logged out
journalctl --user -u geode-wiki-hub.service -f
```

Adjust the `geode-wiki.mjs` path (`npm run build:cli` produces `dist/cli/geode-wiki.mjs`) and the store path. A
bare `geode-wiki` on the unit's PATH works too. Authentication is checked before the WebSocket upgrade: a wrong token
is a body-less `401`.

Limits: the server does not check the `Origin` header (the token is the control),
and it has no per-device tokens.

## What is synced

Every ordinary file and folder, **by name only**: the scanner never judges a name
by its shape. `Meeting 2.md` beside `Meeting.md` (or an empty `Untitled 2.md`
beside an empty `Untitled.md`) is two notes and both sync. There is no iCloud
"conflict copy" heuristic; a genuine divergence is a *history* conflict (exit 4),
not a filename pattern. Evicted and `.name.icloud` placeholder files are still
blocked, never read as absent (rail d).

Dot paths are not walked, with two exceptions: the configuration roots
`.geode/` and `.obsidian/`. Inside them the scan descends only into
`themes/`, `snippets/` and `plugins/` and emits only files that
`src/sync-core/scope.ts` (`portableConfigCategory`) classifies as portable, the
same allowlist for both roots:

| File | Scope flag |
|---|---|
| `app.json` | mainSettings |
| `appearance.json` | appearance |
| `hotkeys.json` | hotkeys |
| `core-plugins.json`, `daily-notes.json` | corePlugins |
| `community-plugins.json` | communityPlugins |
| `themes/**`, `snippets/**` | themesAndSnippets |
| `plugins/**` (including `data.json`, `main.js`, `manifest.json`) | communityPluginData |

The headless scope turns all of those on (`rawConfig: true`) and carries the files
byte for byte. Never synced, whatever the scope: `workspace*.json`, `graph.json`
and any other unlisted file in a config root, any `cache`/`caches`/`node_modules`
folder or dot name below a config root, `.geode/metadata-cache/` (the rebuildable
SQLite index and `cache.json`, hundreds of MB per device) and any atomic-write
leftover (`*.tmp`, `*.tmp-<pid>-<uuid>`) in a config root (`isLocalOnlyConfigPath`:
no scope flag turns them on, in any scan implementation), `.geode/sync` (reserved), `.git`, `.trash`,
`.geode-trash`, `.geode-sync-tmp`, `.worktrees`, `.DS_Store`, and every other dot path
(`.claude`, `.gitignore`, `.gitkeep`, `.linear.json`). Symlinks anywhere, including
inside a config root, are reported as blocked and never followed; a symlinked
`.geode` or `.obsidian` is not entered. `--exclude .obsidian` (or
`--exclude .obsidian/plugins`) keeps a root or part of one out. The device-state
directory stays outside the vault.

On the wire a config file is a `portable-config` resource named
`raw.geode/<path>` or `raw.obsidian/<path>` (history names may not be `.geode` or
`.obsidian`); `.geode/themes` and `.geode/snippets/*.css` keep their existing
asset names so they stay interchangeable with the desktop app. The desktop app
ignores `raw.*` resources (its scope does not set `rawConfig`), and a raw-file
host does not exchange the app's projected documents (`editor.json` ...).

Out-of-scope entries that are already on the hub (uploaded by an older build, say) are
inert: the planner skips a remote entity whose path is not in this device's scope, so
it is never downloaded, never deleted locally, never tombstoned remotely, never
reported as a conflict or a pending/corrupt blob, and it cannot trip rail (b) or (c)
(neither counts anything outside the planned actions and local content files). They
simply stay on the hub until it is cleaned by hand.

Config files are not content files for the rails: they do not enter rail (c)'s
"known" or "found" counts, and deleting one counts as a deletion under rail (b)
like any other. A device that synced before this existed has a recorded scope key
that no longer matches. If it runs unattended (`run`, no preview first) the config
files are plain uploads and nothing is deleted; once someone runs `preview`, the
new key is recorded and the next `run` asks for one `preview --approve`.

Staged bytes: a run freezes every file it will upload or apply in the state directory's `ops/` before the first
mutation (so an interrupted batch can be resumed), and drops each file's frozen bytes as soon as that operation is
committed (`release-bytes`), keeping its journal until the batch is recorded. The state directory therefore holds at
most one extra copy of the batch while it runs, shrinking as it goes, instead of all of it until the end.

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

## Scheduling

`geode-wiki sync schedule print|install|uninstall|status --root <dir>` wraps one fixed
command, `<node> <geode-wiki.mjs> sync run --root <dir> [--state-dir <dir>] --json`
(absolute paths; override with `--node-path` / `--cli-path`), in a launchd agent or a systemd
user service+timer.

| Option | Meaning |
|---|---|
| `--interval <s>` | Seconds between runs; default 300, minimum 60 |
| `--platform launchd\|systemd` | Default launchd on macOS, systemd elsewhere |
| `--target-dir <dir>` | Where unit files go; default `~/Library/LaunchAgents` or `${XDG_CONFIG_HOME:-~/.config}/systemd/user` |
| `--activate` | `install`: also `launchctl bootstrap gui/<uid> <plist>` / `systemctl --user daemon-reload` + `enable --now <timer>`. `uninstall`: also `launchctl bootout` / `systemctl --user disable --now`. Without it only files change and the command to run is printed |

- **print** is pure and deterministic and writes nothing. launchd: label
  `com.geode.wiki-sync.<first 8 hex of sha256(root)>`, `StartInterval`, `RunAtLoad false`,
  `ThrottleInterval 60`, `ProcessType Background`, an explicit `PATH`/`HOME`, logs under
  `~/Library/Logs/geode-wiki-sync/<label>.{out,err}.log`. systemd: `geode-wiki-sync-<hash>.service`
  (`Type=oneshot`, `SuccessExitStatus=4 5`) and `.timer`, logs under
  `${XDG_STATE_HOME:-~/.local/state}/geode-wiki-sync/`.
- **install** refuses (`not-initialised`, or `schedule-not-approved`) unless the root is bound and its first
  run has been approved, so a schedule never bypasses the first-run rail. The scheduled command is built in
  one place and never contains `--override-*` or `--hydrate-icloud`; `schedule` does not accept those flags.
  Installing again overwrites the units (idempotent). A failed activation exits 1 as
  `schedule-activation-failed` and leaves the files.
- **uninstall** removes the files; it only deactivates with `--activate` (otherwise it prints the command).
- **status** reports files present, whether the job is loaded/enabled (a read-only `launchctl print` /
  `systemctl --user is-enabled`), the launchd "last exit code" when it prints one, and the last run read
  back from the last JSON envelope in the stdout log (status, exit code, and whether it was a normal outcome).
- **Exit 4 (conflicts) and 5 (locked) are normal outcomes** of a scheduled run. systemd is told via
  `SuccessExitStatus`. launchd has no equivalent: an interval job with no `KeepAlive` is never restarted and
  a non-zero status is only recorded, so nothing is "failed" in a way that matters; what is not feasible is
  hiding the number from `launchctl print`. Each run appends one envelope line to the stdout log, so
  `status` (and `tail`) show `locked` / `conflicts` by name. Exit 1-3 are the ones to look at.
- The log is append-only and one short line per run; rotate it with newsyslog/logrotate if it matters.
- A launchd agent runs without your shell environment: it needs `ssh` to work non-interactively (key in an
  agent reachable without the login session, or an unencrypted key; `BatchMode` is already on) and on
  macOS the first scheduled run may be gated by Full Disk Access / Files and Folders prompts for the vault.

## Conflicts

A conflict is two or more heads for one entity. `run` leaves both sides intact and
exits 4. `conflicts` lists them; `resolve <path> --keep local` publishes this
device's version, `--keep remote` takes the other device's (refused as
`ambiguous-remote` if several exist — then use `--version <recordId>`). Resolution
is not subject to rails (b) and (a): it is an explicit, single-path action; the
scan rail still applies.

## Import rule

`src/cli/sync.ts` is the only CLI module that may import the sync engine
(`src/sync-node/index.ts`), and may import nothing else outside `src/cli/`. `src/cli/sync-schedule.ts` imports nothing from `src/` outside `src/cli/`. See
`scripts/cli-import-audit.mjs` for the full rule set.

## Proofs

| Command | What it proves |
|---|---|
| `npx vitest run tests/unit/sync-cli.test.ts` | Every status/exit, each rail and override, convergence, conflicts, lock, gc (in-process, real directories and hub) |
| `npx vitest run tests/unit/cli-import-audit.test.ts` | The real bundle passes the audit, and each rule fails, naming the edge, on a broken graph |
| `npm run proof:wiki-sync` | The built binary in real subprocesses (including config files and `Name 2.md` round-tripping between two vaults): two vaults, a hub over a stand-in `ssh` running the real remote command line; `sync schedule` print/install/uninstall with a recording `launchctl`, including executing the scheduled command; all six exit codes; conflicts; deletes; each refusal; the lock held by one process and refused (exit 5) in another |
| `npx vitest run tests/unit/sync-schedule.test.ts` | Rendering of both platforms, interval and flag rules, the approval refusal, install/status/uninstall against a stub service manager and temp `--target-dir`s |
| `npm run proof:wiki-cli` | Unchanged claims, plus the exact input set now including the sync files |

## Live gate (2026-10-09)

Hub on a homelab VM over real ssh; two local folders as two devices, seeded from `test-vault/`. Observed: both devices initialised and approved, the second pulled all 11 files, a concurrent edit exited 4 and listed the conflict, `resolve --keep local` settled it, a delete propagated, and the final `diff -r` was empty. The remote command is a bare `geode-wiki` on the non-login PATH, so the hub host needs `geode-wiki` on that PATH (a wrapper script is enough). Not covered: a genuinely separate second machine, real iCloud placeholders, `launchd` firing.
