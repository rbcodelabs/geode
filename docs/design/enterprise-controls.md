# Enterprise controls

Status: **Partly shipped, partly proposed.** Only the plugin allowlist/blocklist
([ADR 0002](../adr/0002-enterprise-plugin-policy.md)) exists in code. Everything
marked *Proposed* below is a design for review, not behavior you can deploy today.

This page is the admin-facing map: what an IT team can control, how, and where
the limits are. It extends ADR 0002's managed-policy file rather than inventing a
second mechanism.

## Principles (inherited from ADR 0002)

- **One machine-level JSON file**, root/admin-owned, deployed by MDM (Jamf, Intune)
  or imaging. No console, no phone-home, no per-org fork, no license gating.
- **Fail open.** A missing, unreadable, or malformed file means no restrictions.
  Most installs have no policy file; that must never change their behavior.
- **Namespaced and versioned.** `policyVersion` plus one optional top-level key per
  control area. Adding an area is not a breaking change.
- **Policy is a runtime gate, not a mutation.** It never rewrites vault or user
  config, so relaxing a policy restores the prior user intent with no action.
- **OS file permissions are the tamper resistance.** No signing.

### Policy file location

| OS | Path |
|---|---|
| macOS | `/Library/Application Support/Geode/managed-policy.json` |
| Windows | `%ProgramData%\Geode\managed-policy.json` |
| Linux | `/etc/geode/managed-policy.json` |

`GEODE_POLICY_PATH` overrides the path (tests and dev only; do not rely on it for
enforcement, since a user can set an environment variable).

## Control areas

| Area | Policy key | Status |
|---|---|---|
| Plugin execution (allow/block by id) | `plugins` | **Shipped** |
| Plugin installation | `pluginInstall` | *Proposed* |
| Sync (in-app providers and CLI) | `sync` | *Proposed* |
| Thread execution targets (this machine / local daemon / remote daemon) | `threadExecution` | *Proposed* |
| CLI background processes (scheduled sync, hub server) | `daemons` | *Proposed* |

### 1. Plugin execution — shipped

```json
{
  "policyVersion": 1,
  "plugins": { "mode": "blocklist", "ids": ["some-untrusted-plugin"] }
}
```

`mode` is `allowlist` (only listed ids run; an empty list blocks all plugins) or
`blocklist` (listed ids are blocked). Matching is by manifest `id`, exact, no
wildcards. Enforcement is in `PluginManager.enable()`; a blocked plugin never
executes. A previously enabled plugin that becomes blocked produces a startup
notice, and `.geode/plugins.json` is left untouched.

Limits: applied when a vault opens, not live; blocked-by-admin is shown as a badge
only for community-tracked plugins (hand-dropped plugins get the startup notice
only). See ADR 0002 for the full failure-mode table.

### 2. Plugin installation — proposed

Today the policy blocks a plugin from *running* but not from being *installed*.
Install still writes files to `<vault>/.geode/plugins/<id>/`. Admins who want to
stop code from being fetched at all need a separate control.

Install entry points that would be gated (all in `src/main/main.ts`):

| Entry point | IPC channel |
|---|---|
| Community install from GitHub | `community-install` (and `community-resolve`) |
| Supported-plugin catalog install | `supported-plugin-install` (and `supported-plugin-catalog`) |
| Import from an Obsidian `.obsidian/` folder | `community-import-obsidian` |
| Replace plugin files | `plugin-files-replace` |

Proposed schema:

```json
{
  "policyVersion": 1,
  "pluginInstall": {
    "mode": "disabled" | "catalog-only" | "allowed",
    "sources": ["github.com/your-org/*"]
  }
}
```

- `disabled`: all four entry points above refuse in the main process, and the
  settings UI hides or disables the install controls with a "managed by your
  administrator" note.
- `catalog-only`: only `supported-plugin-install` works. Free-form GitHub installs
  and Obsidian import are refused.
- `sources` (optional, with `allowed`): restrict community installs to listed
  GitHub owners/repos. This is the one place a glob is justified, and it is
  deliberately limited to the repo path, not plugin ids.
- Install policy composes with `plugins`: install can be allowed while execution
  is still gated by the allowlist, and vice versa.

Enforcement must live in the **main process IPC handlers**, not only in the
renderer. The renderer runs with `nodeIntegration: true` and plugins are
renderer-side code, so renderer-only checks are advisory.

Open question: pre-installed plugin folders (copied in by a user or synced from
another machine) are not "installs". `plugins` allowlist mode is the control for
those; this doc should not promise more.

### 3. Sync — proposed

There are two sync surfaces and they need separate switches.

| Surface | What it does | Code |
|---|---|---|
| In-app providers | HTTPS hub (WebSocket), iCloud container, sync-private storage; owner claim gates one writer per vault root | `src/main/hub-sync-ipc.ts`, `icloud-container-ipc.ts`, `sync-private-storage.ts`, `sync-apply.ts`, `sync-owner-*` channels in `main.ts` |
| Headless CLI | `geode-wiki sync run / serve / schedule` driving the append-only history engine | `src/cli/sync.ts`, `src/sync-node/` |

Proposed schema:

```json
{
  "policyVersion": 1,
  "sync": {
    "enabled": false,
    "providers": ["hub", "icloud"],
    "hubAllowlist": ["https://hub.corp.example"]
  }
}
```

- `enabled: false` is the kill switch: the main process rejects `hub-sync`,
  `sync-owner-claim`, `sync-private-storage`, `sync-local-apply`, and the iCloud
  container channels, and the Sync settings pane shows as managed/off.
- `providers` narrows to a set. Omitted means all providers.
- `hubAllowlist` pins which hub URLs the app may connect to. This matters more than
  the on/off switch for most orgs: it lets them allow a self-hosted hub and block
  everything else. Today `validateHubTarget` (`src/sync-node/app-hub.ts`) is the
  single place a hub target is checked, so the allowlist belongs there.
- Turning sync off must be **non-destructive**: no deletion of local history or
  vault content, no rewrite of stored bindings. Re-enabling resumes.

Honest limit for the CLI: `geode-wiki` is an in-repo build artifact that a user
can run from their own checkout. Managed policy can make the shipped binary
refuse (`sync` subcommands exit with a dedicated code and a message naming the
policy), but it is a guardrail on the supported binaries, **not a security
boundary against a user who can build or run arbitrary Node code**. Orgs needing a
hard boundary should rely on endpoint controls (application allowlisting, network
egress rules) in addition to this policy.

### 4. Thread execution targets and daemons — proposed

Two different things are called "daemon" here. The first is the one admins usually
mean.

#### 4a. Claude Threads "Run on" targets

The Claude Threads plugin (separate repo, `agent-threads`) lets each thread run in
one of three places. Each needs its own on/off switch:

| Target | What it is | Risk profile |
|---|---|---|
| **This machine** | Agent harness runs directly on the host (Geode's Node renderer), with the user's filesystem, keychain and network | Highest ambient access |
| **Local daemon** | `agent-threads` daemon in an Apple `container` VM on the same Mac, bound to `127.0.0.1`; vault mounted read-write (`.geode`/`.obsidian` read-only), plus opted-in shared folders, secrets, AWS profiles, GitHub connection | Isolated, but credentials and folders are pushed in, and `host_exec` can reach back to the Mac |
| **Remote daemon** | `agent-threads` daemon on another machine (homelab, VM) reached over `ws://`/`wss://` (e.g. via Tailscale) | Data, secrets and MCP servers leave the machine |

Proposed schema, a sibling key in the same managed policy file:

```json
{
  "policyVersion": 1,
  "threadExecution": {
    "harnesses": ["claude", "codex"],
    "machine":      { "enabled": false },
    "localDaemon":  { "enabled": true, "harnesses": ["claude"] },
    "remoteDaemon": { "enabled": true, "harnesses": ["claude", "codex"],
                      "hosts": ["wss://threads.corp.example:8443"] },
    "hostExec":     { "enabled": false },
    "mobileRemoteAccess": false
  }
}
```

**Targets and harnesses.** Each of `machine`, `localDaemon` and `remoteDaemon` is
controlled independently, and each can be limited to specific harnesses. Harness ids
are `claude`, `codex` and `opencode` (the three Claude Threads can start today).

- `enabled: false` makes the target unavailable. A bare boolean (`"machine": false`)
  is accepted as shorthand for `{ "enabled": false }`. Omitted means allowed.
- `harnesses` on a target is an allowlist for that target; omitted means every
  harness. The top-level `harnesses` is a global allowlist across all targets.
- A thread may start only if **all** of these hold: the target is enabled, the
  harness is in the global list, and the harness is in the target's list. Policy can
  only narrow, never widen: a target list cannot re-allow a harness the global list
  removed. This avoids the allow/block precedence problem ADR 0002 deliberately
  avoided, because every list is an allowlist and the result is an intersection.
- Example above: nothing runs directly on the host; Claude only in the local
  container; Claude and Codex on the company's remote daemon; OpenCode nowhere.
- Harness ids not recognized by the installed plugin are ignored (a newer policy file
  with an older plugin stays safe), but an empty effective set must be reported to
  the user rather than failing at send time.
- All targets disabled is legal and leaves Claude Threads installed but inert.

**Remote hosts.** `remoteDaemon.hosts` (optional) pins which endpoints may be
registered and used. Matching is exact scheme+host+port, no wildcards. Better than a
plain on/off for organisations that run their own daemon.

**`host_exec`.** This is the daemon running one command on the Mac, and the main
path from the isolated daemon back to the host. It gets its own switch rather than
riding on `localDaemon`, because an org may want the container but not the path out
of it. `{ "enabled": false }` removes the tool from the daemon's tool surface and
refuses calls that arrive anyway. A possible second field, `allowAlways: false`,
would keep the per-call approval prompt but remove the "Always allow" option; that
field is a suggestion and not yet agreed. `hostExec` is independent of `machine`:
disabling the machine target does not disable `host_exec`, and the doc tests both
combinations.

**Mobile remote access.** `mobileRemoteAccess: false` disables the WebSocket-relay
feature (Settings → Agent Threads → Remote Access) that mirrors desktop sessions to
a phone and lets the phone send prompts and resolve tool approvals. Because the
relay is an egress and control path into the executor, it is governed here even
though it is not one of the three targets. When disabled: the toggle is shown as
managed and off, no relay connection is opened, and any paired devices are not
deleted (non-destructive), they just cannot connect. Pairing state resumes if policy
is relaxed.

**Behavior common to all of these.**

- **Enforce at launch, not only in the picker.** Starting a thread, resuming one, and
  a scheduled item that targets a disallowed place or harness must refuse with a
  message naming the policy. Running threads are not killed mid-run; they are
  refused on next resume.
- Disabling `localDaemon` also stops the container being created or started from
  Settings. An existing container is left in place, not started or attached.
- Disabling `remoteDaemon` also blocks registering a daemon, pushing secrets
  (`Settings → Remote → Edit`), and running MCP servers on a daemon.
- Changing the harness picker: harnesses the policy removes disappear from "New
  thread" with a managed note, and the right-click harness switch refuses them.
- `machine: false` with `localDaemon: true` (sandboxed execution only) is likely the
  most common enterprise setup, so it needs an explicit test.

**Where enforcement lives.** The target decision is made in the plugin, not in
Geode. Geode can only supply the policy, so this needs two pieces:

1. Geode exposes the already-validated policy to plugins through the plugin host API
   (today only `PluginManager` consumes `getPluginPolicy`). `threadExecution` is
   validated in `src/renderer/policy.ts` like every other area, then handed over
   read-only. A plugin cannot write it.
2. The `agent-threads` plugin reads it and enforces at its launch path. A plugin that
   ignores the policy is exactly as trustworthy as the plugin set, so pair this with
   the `plugins` allowlist (pin the plugin id) and, ideally, plugin version pinning.

Honest limits: because plugins run with full Node access, a user who can install
arbitrary plugin code can bypass a plugin-level check. This control is meaningful
together with `plugins` allowlist mode, not on its own. The local-daemon container
and any remote daemon are separate processes with their own listeners, so the
daemon side should also be able to refuse (see 4b) when started by a different
user or on a different host than policy allows.

Open questions for review:

- Should `hostExec.allowAlways` exist, or is `enabled` enough for v1?
- Per-harness limits apply to targets today; should they also apply to MCP servers
  or skills? Not proposed.

#### 4b. CLI background processes

Geode itself ships no resident daemon. The long-running pieces are things a user
opts into through the CLI:

| Process | How it starts | What it does |
|---|---|---|
| Scheduled sync | `geode-wiki sync schedule install [--activate]` writes a launchd plist or systemd user service + timer | Runs `sync run` on an interval; activation is explicit |
| Hub server | `geode-wiki sync serve --http` (often under a systemd user unit) | Listens on a local port, token-authenticated, optionally fronted by Tailscale |

(`sync schedule` and `sync serve` are documented in
[headless-wiki-sync.md](headless-wiki-sync.md) and ADR 0025.)

Proposed schema:

```json
{
  "policyVersion": 1,
  "daemons": {
    "allowSchedule": false,
    "allowServe": false,
    "allowedListenAddresses": ["127.0.0.1"]
  }
}
```

- `allowSchedule: false`: `sync schedule install` and `--activate` refuse. `status`
  and `uninstall` always keep working, so a user can remove a previously installed
  job. Existing launchd/systemd units are **not** removed by Geode; the scheduled
  command itself should check policy at start and exit without syncing, which is
  the part that actually bites for already-installed schedules.
- `allowServe: false`: `sync serve` refuses to bind.
- `allowedListenAddresses`: if serving is allowed, restrict binds. Loopback-only is
  the safe default for orgs that allow it; this prevents exposing a hub on a LAN
  interface.
- The desktop app's own utility processes (metadata indexer, sync workers) are
  implementation detail, not user-installed daemons, and are out of scope for this
  policy.

The same guardrail caveat as sync applies: this governs the shipped CLI, not a
determined local user.

## Cross-cutting behavior

| Topic | Decision |
|---|---|
| Read timing | Read fresh on each IPC call, no cache, no watcher (ADR 0002). New areas follow suit. |
| Live changes | Applied on next vault open or next call; already-loaded plugins are not unloaded mid-session. A sync kill switch is checked per call, so it takes effect immediately for new sync operations. |
| Visibility | A control that is policy-disabled should say so in the UI ("managed by your administrator"), never silently vanish. |
| Logging | Main process logs which policy area refused an action. No telemetry leaves the machine. |
| Unknown keys | Ignored, so an older Geode reading a newer policy file stays safe. |
| Invalid area | Only that area is ignored (fail open); other areas still apply, matching how `plugins` is handled today. |
| Validation | Extend `src/renderer/policy.ts` (pure, shared by main and renderer) so validation cannot drift between processes. |

## Deploying

1. Write `managed-policy.json` to the OS path above, owned by root/admin, not
   writable by standard users.
2. Push via Jamf, Intune, or your configuration tool. Keep the file in source
   control on your side; Geode does not sign or version-check beyond `policyVersion`.
3. Verify on a pilot machine. Today only `plugins` can be verified in the app;
   check `Settings` and the startup notice, or run with `GEODE_POLICY_PATH` pointed
   at a test file first.
4. Remember the baseline: no file means no restrictions.

## Not covered

- Windows registry/GPO (ADMX) delivery.
- Live reload of policy mid-session.
- Cryptographic signing of the policy file.
- Auto-update pinning and forced settings (reserved keys in ADR 0002; no design yet).
- Network egress of the Claude Threads plugin beyond execution targets (model API
  calls, MCP servers); use endpoint controls.

## Next steps

1. Review this proposal and decide which areas to build first. Suggested order:
   plugin installation, then `sync.enabled` and `hubAllowlist`, then `threadExecution` (needs a plugin-host API to hand policy to plugins), then `daemons`.
2. Each built area gets its own ADR (next free number) and unit tests in the style of
   `tests/unit/policy.test.ts`, plus an e2e spec using `GEODE_POLICY_PATH`.
3. Record the roadmap item in Compass (`rbcodelabs/geode`); this repo is not the
   planning source of truth.
