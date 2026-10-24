# Enterprise controls

Status: **Partly shipped, partly proposed.** The plugin allowlist/blocklist
([ADR 0002](../adr/0002-enterprise-plugin-policy.md)) and the policy core
([ADR 0051](../adr/0051-policy-layering.md): schema and validators for every area,
machine + vault layering, the vault policy file, its write protection) exist in code.
The per-area *enforcement* for install, sync, thread execution, GitHub and daemons is
not built: those files are parsed and merged but nothing acts on them yet. Everything
marked *Proposed* below is a design for review, not behavior you can deploy today.

This page is the admin-facing map: what an IT team can control, how, and where
the limits are. It extends ADR 0002's managed-policy file rather than inventing a
second mechanism.

## Principles (inherited from ADR 0002)

- **A machine-level JSON file** (and, proposed, a narrowing-only vault file, section 6), root/admin-owned, deployed by MDM (Jamf, Intune)
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
| Plugin installation | `pluginInstall` | **Shipped** (ADR 0052: six main-process handlers, Settings notes) |
| Sync (in-app providers and CLI) | `sync` | *Proposed* (schema and layering shipped; enforcement not) |
| Thread execution targets (this machine / local daemon / remote daemon) | `threadExecution` | *Proposed* (schema and layering shipped; enforcement not) |
| CLI background processes (scheduled sync, hub server) | `daemons` | *Proposed* (schema and layering shipped; enforcement not) |
| GitHub connection settings and sign-in | `github` | *Proposed* (schema and layering shipped; enforcement not) |
| Vault-level policy file (narrowing only) | `<vault>/.geode/policy.json` | **Shipped** (ADR 0051) |

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
  deliberately limited to the repo path, not plugin ids. A non-empty list with no valid
  entry fails closed (matches nothing), a deviation from "only github lists fail closed"
  (ADR 0052).
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

### 5. GitHub connection — proposed

Geode's GitHub connection (Settings → GitHub) signs a user in with the Geode GitHub
App via the device flow and hands threads short-lived, repository-scoped tokens. The
sign-in state and tokens are in the OS keychain. The settings surface today
(`src/main/github-auth/config.ts`, `src/renderer/settings/github-tab.ts`):

| Setting | Where it can be set today |
|---|---|
| App `clientId`, `appSlug` | env (`GEODE_GITHUB_CLIENT_ID`, `GEODE_GITHUB_APP_SLUG`), then the open vault's `.geode/app.json`, then `geode.json` `github`, then the built-in default |
| Allowed owners / repos (what agents may reach) | env (replaces the `geode.json` list), `geode.json`, and the vault's `.geode/app.json`; the lists are ANDed, so a vault can narrow but not widen |
| Connect, reconnect, disconnect | Settings form; IPC `github-auth-start`, `github-auth-disconnect` |
| Save or reset the settings form | IPC `github-auth-set-settings` (writes `geode.json`) |

Everything above is user-writable, so none of it binds an administrator's intent.
Two gaps matter for an enterprise:

1. **A user can point Geode at a different GitHub App** (own `clientId`/`appSlug`) by
   env var, `geode.json` or a vault file, and can **widen or clear the global
   allowlist** by editing `geode.json`. A vault can also set `clientId`/`appSlug`,
   and the vault layer outranks `geode.json`. Review whether an untrusted vault
   should be able to redirect the sign-in app; managed policy closes this for
   managed machines either way.
2. Nothing stops a user connecting a personal GitHub account on a managed machine.

Proposed schema:

```json
{
  "policyVersion": 1,
  "github": {
    "settingsLocked": true,
    "clientId": "Iv1.corpapp",
    "appSlug": "corp-geode",
    "allowedOwners": ["your-org"],
    "allowedRepos": [],
    "connect": true,
    "disconnect": false,
    "allowedLogins": ["*@your-org-emu"],
    "deliverToRemoteDaemon": false
  }
}
```

- `settingsLocked: true` makes the GitHub settings form read-only ("managed by your
  administrator") and makes the main process refuse `github-auth-set-settings`.
  This is the "limit the ability to change the connection settings" switch. It locks
  everything the form edits: client id, app slug, and the allowlists.
- `clientId` and `appSlug`, when present, are **pinned**: they beat env vars, the
  vault's `.geode/app.json` and `geode.json`. Whether or not `settingsLocked` is set,
  a pinned value cannot be overridden by any user-writable layer.
- `allowedOwners` and `allowedRepos` become one more allow policy in the existing
  intersection. Since `resolveGithubAppSettings` already requires every policy to
  pass, managed policy slots in as another entry that no other layer can remove.
  An all-invalid list fails closed, matching how the existing parser treats a bad
  allowlist. (Note the contrast with the rest of managed policy, which fails open on
  bad input. This is deliberate: a broken allowlist restricts, never opens up.)
- `connect: false` disables sign-in entirely: `github-auth-start` is refused and the
  Connect button is shown as managed. Use when GitHub access is provided another way.
- `disconnect: false` prevents the user removing an admin-provisioned connection.
  This is the least certain field: the connection is a per-user OAuth token, not an
  admin-provisioned one, so there may be little to protect. Included for review.
- `allowedLogins` (optional) restricts which GitHub accounts may be connected, checked
  against the login returned after sign-in (`fetchViewerLogin`). Mismatch means the
  connection is rejected and the token discarded. Intended for orgs using Enterprise
  Managed Users, whose logins carry a known suffix. Matching is exact or a single
  leading `*`; this is the one pattern in policy besides install sources.
- `deliverToRemoteDaemon: false` stops the plugin passing GitHub tokens to remote
  daemons even when the user ticks "Use Geode GitHub connection". It ties into
  `threadExecution`: a token is credentials leaving the machine. A parallel field for
  the local container could follow; proposed only for remote in v1.

Existing connections: when policy newly forbids the connected account or app, Geode
does not silently delete anything. It marks the connection as blocked by policy,
stops issuing tokens, and shows a reconnect-or-contact-admin message. Relaxing
policy restores it.

Limits, as elsewhere: policy governs Geode's own code paths. A user with a personal
`gh` login or token in their environment can still reach GitHub from a shell or from
a thread running on "This machine". Use the `threadExecution` controls and endpoint
egress rules for that; `github` policy only governs the connection Geode brokers.

### 6. Vault-level policy — shipped

Shipped in [ADR 0051](../adr/0051-policy-layering.md): the loader, the merge, the
`get-effective-policy` IPC, the open-time notice, `vaultPolicy: "ignore"`, and write
protection for the file. Notes from building it, where the text below was wrong or
incomplete:

- List rows marked "intersection" below are intersections only for exact-match lists.
  `github.allowedOwners/Repos/Logins` and `pluginInstall.sources` are kept per layer and
  every layer must pass (owners/repos are an OR within a layer, and globs cannot be
  intersected). This is the existing GitHub behavior and still cannot widen.
- `github.disconnect` is also machine-only, for the same reason as `settingsLocked`.
- `.geode/policy.json` **is** on the protected-path list: `vault-write`, `vault-write-binary`,
  `vault-mkdir`, `vault-delete`, `vault-rename`, `vault-rmdir`, `config-write` and
  `plugin-files-replace` refuse it, including case, `..`, symlink, hard-link and
  trailing-dot aliases. The investigation found `config-write` was the sharp edge
  (`writeConfig("policy", ...)` wrote the file directly). It does **not** stop code that
  already has Node access: the renderer runs with `nodeIntegration: true`, so a plugin
  can `require("fs")` and rewrite the file, and a thread running on "This machine" can
  too. Treat the vault file as a convention plus protection from Geode's own IPC, not a
  boundary against arbitrary plugin code; pair it with the machine `plugins` allowlist.
- The notice reads "This vault restricts: plugins, sync." followed by the file's `note`.

So far every control comes from the machine-level file. This adds a second source: a
policy file inside the vault, read alongside the machine file. It suits teams that
share a vault (a repo, a synced folder, a distributed template) and want the vault
itself to carry its rules, including on machines with no MDM.

This reverses one rejected alternative in ADR 0002, which dismissed a vault-embedded
policy because it sits in the same trust boundary as the user. That objection still
holds for *enforcement against the user*, so the design below keeps vault policy
weaker than machine policy on purpose.

**Location.** `<vault>/.geode/policy.json`, next to the existing per-vault files
(`plugins.json`, `app.json`, `community.json`). Same schema and `policyVersion` as the
machine file, restricted to the areas below. Read when the vault opens, on the same
read-fresh, no-watcher model.

**The one rule: vault policy can only narrow.** The effective rule for any action is
the machine policy AND the vault policy. Neither can re-allow what the other denies.
This is the model the GitHub allowlist already uses (a vault's list is ANDed on top
of the global one), applied to every area:

| Area | How layers combine |
|---|---|
| `plugins` | Each layer is evaluated on its own; a plugin is blocked if **any** layer blocks it. So a machine blocklist plus a vault allowlist yields "in the vault's list and not in the machine's blocklist". |
| `pluginInstall`, `sync.enabled`, `threadExecution` flags, `hostExec`, `mobileRemoteAccess`, `github.connect` | Boolean AND: `false` in either layer wins. |
| `pluginInstall.mode` | The stricter of the two (`disabled` > `catalog-only` > `allowed`). |
| Lists: `harnesses`, `sync.providers`, `hubAllowlist`, `remoteDaemonHosts`, `pluginInstall.sources`, `github.allowedOwners/Repos/Logins` | Intersection; an absent list means no restriction from that layer. |
| Pinned values (`github.clientId`, `github.appSlug`) and `settingsLocked` | **Machine file only.** A vault file cannot pin or lock these; a vault could otherwise lock a user out of settings in someone else's vault. These keys in a vault file are ignored with a logged warning. |
| `daemons` | CLI behavior is per-root, so a vault file may narrow it for that root. |

Anything a vault file tries that would widen (a longer list, `true` where the machine
says `false`) is simply ineffective, because the machine layer is still in the AND.

**Why this is safe to read from an untrusted vault.** Opening a vault someone else
authored can then only remove capabilities, never add them, so there is no
privilege-escalation path through the file. The cost is a nuisance one: a hostile or
careless vault can disable features inside itself. Mitigations:

- Geode shows a visible notice on open when a vault policy is active ("This vault
  restricts: plugins, sync"), with the reason string if the file supplies one
  (`"note": "..."`, display only).
- Nothing outside that vault is affected, and removing or editing the file lifts it.
- The user can always open the file, since it is plain JSON in the vault.

**What it is not.** Without a machine file, vault policy is a team convention, not
enforcement: the user who owns the vault can edit or delete it. It enforces against
*other people's* vaults and against plugins and agents running inside the vault, which
matters because **agents and plugins can write to `.geode/` too**. A narrowing file
that a plugin cannot loosen is worth having only if plugins cannot rewrite it, so
decide whether `.geode/policy.json` is on the protected-path list that plugin file
APIs and agent tools refuse to write. Proposed: yes, same as other config Geode
treats as host-owned. This needs checking against the existing write guards
(`vault-write` and `config-write`) before committing to it.

**Admin control over this layer.** The machine file can govern whether vault policy is
read:

```json
{ "policyVersion": 1, "vaultPolicy": "narrow" | "ignore" }
```

Default is `narrow`. `ignore` is for admins who want exactly their own policy and no
vault-supplied behavior. There is deliberately no `widen` option.

**Other vault-side files.** Only `.geode/policy.json` is read. Geode does not read
policy from `.obsidian/`, from plugin folders, or from `app.json`; and `.geode/app.json`
keeps its existing role for GitHub App settings, now subject to the machine pin.

Open questions:

- Does `.geode/` replicate through Geode's own sync or iCloud? If so a vault policy
  change would propagate to every device of every member, which is useful for teams but
  needs to be a stated behavior. Partly checked: Geode's guarded sync apply
  (`src/sync-node/sync-apply.ts`) cannot write `.geode/policy.json` (it rejects dot
  segments other than portable `.geode`, and portable writes map to fixed config names),
  so a synced vault does not replicate it through that path. Plugin-provided sync
  providers and the iCloud container were not checked.
- Should a vault be able to *require* things (for example `requirePluginsAllowlist`)?
  Not proposed: requirement is not narrowing, and it would let a vault block opening
  on a machine that lacks something.
- Show the effective, merged policy and where each rule came from in Settings. Strongly
  recommended for supportability, mirroring the existing GitHub "overridden by" notes.
  The data exists (`get-effective-policy` returns a provenance map); no UI renders it yet.

## Cross-cutting behavior

| Topic | Decision |
|---|---|
| Read timing | Read fresh on each IPC call, no cache, no watcher (ADR 0002). New areas follow suit. |
| Live changes | Applied on next vault open or next call; already-loaded plugins are not unloaded mid-session. A sync kill switch is checked per call, so it takes effect immediately for new sync operations. |
| Visibility | A control that is policy-disabled should say so in the UI ("managed by your administrator"), never silently vanish. |
| Logging | Main process logs which policy area refused an action. No telemetry leaves the machine. |
| Unknown keys | Ignored, so an older Geode reading a newer policy file stays safe. |
| Invalid area | Only that area is ignored (fail open); other areas still apply, matching how `plugins` is handled today. Exception: an invalid allowlist (`github.allowedOwners/Repos`) fails closed, as the existing GitHub config parser already does. |
| Validation | Extend `src/renderer/policy.ts` (pure, shared by main and renderer) so validation cannot drift between processes. |

## Deploying

1. Write `managed-policy.json` to the OS path above, owned by root/admin, not
   writable by standard users.
2. Push via Jamf, Intune, or your configuration tool. Keep the file in source
   control on your side; Geode does not sign or version-check beyond `policyVersion`.
3. Verify on a pilot machine. Today only `plugins` is enforced; check the startup
   notice, or run with `GEODE_POLICY_PATH` pointed at a test file first. Other areas
   validate and merge (inspect them with `window.geode.getEffectivePolicy()`) but do
   not change app behavior yet.
4. Remember the baseline: no file means no restrictions.

## Not covered

- Windows registry/GPO (ADMX) delivery.
- Live reload of policy mid-session.
- Cryptographic signing of the policy file.
- Auto-update pinning and forced settings (reserved keys in ADR 0002; no design yet).
- Network egress of the Claude Threads plugin beyond execution targets (model API
  calls, MCP servers); use endpoint controls.

## Next steps

1. The core (schema, layering, vault file, write guards) is done. Decide which areas to
   enforce first. Suggested order:
   plugin installation, then `sync.enabled` and `hubAllowlist`, then `threadExecution` (needs a plugin-host API to hand policy to plugins), then `github` (small, self-contained: the layering already exists), then `daemons`.
2. Each built area gets its own ADR (next free number) and unit tests in the style of
   `tests/unit/policy.test.ts`, plus an e2e spec using `GEODE_POLICY_PATH`.
3. Record the roadmap item in Compass (`rbcodelabs/geode`); this repo is not the
   planning source of truth.
