# ADR 0051 — Policy layering: machine policy plus a narrowing-only vault policy

Status: Accepted
Date: 2026-10-22
Extends [ADR 0002](0002-enterprise-plugin-policy.md) (enterprise-managed plugin policy).
Design: [enterprise-controls.md](../design/enterprise-controls.md), sections 1-6.

## Context

ADR 0002 gave Geode one machine-level policy file with one control area (`plugins`). The enterprise-controls
design adds more areas (plugin install, sync, thread execution, GitHub, daemons) and a second source: a policy
file inside the vault, for teams that share a vault and for machines with no MDM. ADR 0002 rejected a
vault-embedded policy because it sits in the user's own trust boundary. That still holds for enforcement
*against the user*, so the vault file is allowed only to remove capabilities, never to add them.

This ADR covers the core: the schema, the layering function, the loader, the IPC, and the protection of the
vault file. Per-area enforcement (install gates, sync switches, thread targets, GitHub locks, daemons) is built
on top of it and recorded separately.

## Decision

1. **One pure module, many validators.** `src/renderer/policy.ts` holds the `ManagedPolicy` type and one
   validator per area (`plugins`, `pluginInstall`, `sync`, `threadExecution`, `github`, `daemons`,
   `vaultPolicy`, plus a display-only `note`). It stays free of IO, DOM and Electron imports so main and
   renderer share it. `validatePolicy`, `isPluginBlocked` and the `get-plugin-policy` IPC are unchanged.
2. **One pure merge.** `src/renderer/policy-layering.ts` exports `resolveEffectivePolicy(machine, vault)`,
   returning the effective policy and a provenance map (which layer produced each active restriction).
3. **Main process.** `src/main/policy-loader.ts` reads `<vault>/.geode/policy.json` fresh on each call (no
   cache, no watcher), and only when the machine policy's `vaultPolicy` is not `"ignore"`. The new IPC
   `get-effective-policy` resolves the calling window's vault root and returns
   `{ machine, vault, effective, provenance }`. `PluginManager` uses the effective plugin policy, and shows a
   one-time "This vault restricts: ..." notice (plus the file's `note`) through `App.notify`.
4. **The vault file is host-owned.** `src/main/policy-guard.ts` makes the main-process write handlers refuse
   to create, change, move or delete `.geode/policy.json` (see Protected path).

### Merge rules

The vault layer can only narrow: the result is the machine policy AND the vault policy.

| Kind | Rule |
|---|---|
| `plugins` | Kept per layer; a plugin is blocked if **any** layer blocks it. |
| Booleans (`sync.enabled`, target `enabled`, `hostExec.enabled/allowAlways`, `mobileRemoteAccess`, `github.connect`, `github.deliverToRemoteDaemon`, `daemons.allowSchedule/allowServe`) | AND: `false` in either layer wins. Absent means allowed. |
| `pluginInstall.mode` | The stricter: `disabled` > `catalog-only` > `allowed`. |
| Exact-match lists (`threadExecution.harnesses`, per-target `harnesses`, `remoteDaemon.hosts`, `sync.providers`, `sync.hubAllowlist`, `daemons.allowedListenAddresses`) | Intersection. An absent list is "no restriction from this layer"; an empty list is "allow none". |
| Pattern or union lists (`pluginInstall.sources`, `github.allowedOwners/Repos`, `github.allowedLogins`) | Kept **per layer**, and every layer must pass. See Deviations. |
| Machine-only: `github.clientId`, `github.appSlug`, `github.settingsLocked`, `github.disconnect`, `vaultPolicy` | Ignored in a vault file, with a `console.warn`. |

`vaultPolicy: "ignore"` in the machine file removes the vault layer entirely (the file is not read). There is
no `widen` option.

### Protected path

Writes to `<vault>/.geode/policy.json` are refused with `Refusing to modify .geode/policy.json: it is a
host-owned policy file.` by these handlers: `vault-write`, `vault-write-binary`, `vault-mkdir`,
`vault-delete`, `vault-rename` (source and destination), `vault-rmdir`, `config-write` (the `name` argument is
caller-controlled and reaches the file as `policy`, `../.geode/policy` and so on) and `plugin-files-replace`.
The check canonicalizes symlinks (including a symlinked `.geode` and a dangling link to a not-yet-created
policy), folds case, `..`, trailing dots/spaces, `:stream` suffixes and compatibility forms, compares file
identity (hard links, 8.3 short names), and also refuses removing or replacing `.geode` itself while it holds a
policy file. It runs inside the existing per-path lock.

Unreachable by construction, checked and not changed: `sync-local-apply` (`sync-apply.ts` rejects dot segments
other than portable `.geode`/`.obsidian`, and portable writes map only to fixed config names, themes and
snippets), vault-pack import (`.geode` allowlist is `app.json`, `hotkeys.json`, `plugins.json`, `themes/`,
`snippets/`), community and supported-plugin install (write only under `.geode/plugins` and `.geode/themes`).

**Not protected, and cannot be at this layer:**

- Code with Node access. The renderer runs with `nodeIntegration: true`, `contextIsolation: false`,
  `sandbox: false`, so a plugin can `require("fs")` and write the file directly. Likewise any harness process a
  thread starts on "This machine" with the user's permissions. This is the same limit ADR 0002 records for
  plugins in general; the vault file is a convention strong enough against accidents and against the Geode IPC
  surface, not a boundary against arbitrary local code. Pair it with the machine `plugins` allowlist.
- The user, who owns the vault and may edit or delete the file in a text editor or shell.
- Writes through a file path outside the vault root that happens to alias it (for example an external root
  mounted over the same directory) are not in the vault IPC path and were not tested.

### Failure modes

| Situation | Result |
|---|---|
| Machine or vault file missing, unreadable, invalid JSON, wrong `policyVersion`, or over 1 MiB | That layer is ignored (fail open). |
| One area malformed | That area is ignored; other areas apply. Bad optional field: only the field is dropped. |
| Non-empty list with no valid entry | Dropped (fail open), **except** `github.allowedOwners/allowedRepos/allowedLogins`, which fail **closed** (replaced by a sentinel that matches nothing). |
| Unknown keys | Ignored. |
| Vault file tries to widen | Ineffective: the machine layer is still in the AND. |
| Vault file sets a machine-only key | Ignored, warned. |
| No window vault open | Machine layer only. |

## Deviations from the design document

- **GitHub allowlists and install sources are per-layer, not intersected.** The design table said
  "intersection", but owners and repos are an OR within one layer (a repo passes if it matches an owner or a
  repo entry, as `resolveGithubAppSettings` already does) and install sources and login patterns are globs.
  Intersecting `owners` and `repos` separately would let `owners:[b]` in one layer and `repos:[a/x]` in another
  produce "any repo of b", wider than the first layer allows. Keeping one entry per layer and requiring all to
  pass is exactly the existing GitHub behavior and cannot widen.
- **`github.disconnect` is machine-only.** The design listed only the pins and `settingsLocked`. A vault that
  could set `disconnect: false` could stop a user removing a global connection while in that vault, the same
  lock-out the design already forbids for `settingsLocked`.

## Consequences

- Teams get a vault-carried narrowing policy with no MDM; admins keep an off switch (`vaultPolicy: "ignore"`).
- Opening someone else's vault can only remove capabilities, never add them. The residual risk is nuisance
  (a vault disabling features inside itself), mitigated by the open-time notice and by the user being able to
  read the plain JSON file.
- Policy still applies on next vault open or next call, not live (ADR 0002).
- Vault-pack export/import still evaluate the machine layer only (`vault-pack.ts` calls `isPluginBlocked`
  with the machine policy); pack handling of a vault layer is follow-up work.
- The provenance map is returned by the IPC but no UI renders it yet.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Vault policy may widen or pin | Reintroduces ADR 0002's objection: an untrusted vault would gain authority over the machine. |
| Intersect every list | Wrong for OR-within-layer and glob lists (see Deviations). |
| Protect the file with an OS read-only bit or a watcher that restores it | Does not survive a plugin that can run `chmod`, and a watcher contradicts the read-fresh, no-watcher model. |
| Move enforcement to a sandboxed renderer | The right long-term fix for the Node-access gap; a large separate change, out of scope here. |
