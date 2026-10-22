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
| Local daemons and background processes | `daemons` | *Proposed* |

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

### 4. Local daemons and background processes — proposed

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
- Anything about the Claude Threads plugin's own network access; that is a plugin
  concern, controlled today via the `plugins` allowlist.

## Next steps

1. Review this proposal and decide which areas to build first. Suggested order:
   plugin installation, then `sync.enabled` and `hubAllowlist`, then `daemons`.
2. Each built area gets its own ADR (next free number) and unit tests in the style of
   `tests/unit/policy.test.ts`, plus an e2e spec using `GEODE_POLICY_PATH`.
3. Record the roadmap item in Compass (`rbcodelabs/geode`); this repo is not the
   planning source of truth.
