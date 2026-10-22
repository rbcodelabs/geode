# ADR 0052 — Plugin install policy (`pluginInstall`)

Status: Accepted
Date: 2026-10-22
Extends [ADR 0002](0002-enterprise-plugin-policy.md) and [ADR 0051](0051-policy-layering.md).
Design: [enterprise-controls.md](../design/enterprise-controls.md), section 2.

## Context

`plugins` (ADR 0002) stops a plugin from running, but Geode would still download it and write it to
`<vault>/.geode/plugins/<id>/`. An administrator who wants plugin code never fetched needs a separate control.

## Decision

The `pluginInstall` area is enforced in the **main-process IPC handlers**, using the effective (machine plus
vault, narrowing-only) policy for the calling window's vault, read fresh on every call. The decision is a pure
function (`decidePluginInstall` in `src/main/plugin-install-policy.ts`); `guardPluginInstall` is the one call
each handler makes first, before any network fetch or file write.

| Mode | Allowed | Refused |
|---|---|---|
| `allowed` (or no policy) | everything | nothing, unless `sources` excludes the repository |
| `catalog-only` | `supported-plugin-catalog`, `supported-plugin-install` | `community-install`, `community-resolve`, `community-import-obsidian`, `plugin-files-replace` |
| `disabled` | nothing | all six |

### Enforcement points (`src/main/main.ts`)

`community-resolve`, `community-install`, `supported-plugin-catalog`, `supported-plugin-install`,
`community-import-obsidian`, `plugin-files-replace`. For `supported-plugin-install` the mode is checked before the
catalog is fetched, and `sources` after admission once the catalog repository is known.

`plugin-files-replace` only restores a plugin's previous files after a failed hot reload (today the mobile
runtime; nothing on desktop calls it). It writes caller-supplied code into an existing plugin folder, so it is
refused under `disabled` and `catalog-only`. It has no source repository, so `sources` cannot apply to it. It
stays permitted under `allowed`.

Community **updates** go through `community-resolve`/`community-install`, so they are refused too. Existing
installed plugins and their config are untouched; refusal is non-destructive.

### `sources` matching (open question in the design doc, resolved conservatively)

The install spec (`owner/repo`, a github.com URL, or `.git` form) is parsed to `owner/repo` **before any
network fetch** and matched against every layer's list (each layer must admit it). Patterns, as the stage-1
validator allows them (`*` only as a whole last segment):

- `owner/repo` or `github.com/owner/repo`: exact, case-insensitive.
- `owner/*` or `github.com/owner/*`: any repo of exactly that owner. `*` is one segment, not recursive, not a
  prefix or suffix glob.
- `github.com/*`: every GitHub repository.
- Another host (`gitlab.com/...`), extra path segments, or the `!none` fail-closed sentinel: never match.
- A present but empty list admits nothing. If the repository cannot be determined, the call is refused.

`sources` is applied to every action that names a repository, including the supported catalog install: an
administrator who lists sources and wants the catalog too lists the catalog repositories. It is not applied to
catalog listing, Obsidian import, or file replace, which carry no repository.

### Failure modes

- Missing, unreadable, oversized or invalid policy: fail open (ADR 0002). An all-invalid `sources` list fails
  closed (stage 1 behavior).
- Refusal throws `Plugin install blocked by administrator policy: pluginInstall (<reason>).` and logs the
  action in the main process. Nothing is written.
- Policy changes apply on the next call; nothing is cached and an open vault is not unloaded.

### UI

Settings, Community plugins: the "Add..." and "Import from .obsidian" buttons are disabled, the catalog shows a
note instead of loading, and a "Managed by your administrator" note explains why. These are advisory only.

## Limits (not enforceable)

- The renderer has `nodeIntegration: true`. Code already running there (a plugin, a hostile vault script) can
  write into `.geode/plugins/` directly, bypassing these handlers.
- Plugins can also be copied in by hand or synced from another machine; those are not installs. Use the
  `plugins` allowlist (enforced on enable) for code already on disk.
- Users can run any binary or download anything outside Geode.
- A repository renamed or transferred on GitHub is matched by the name in the request, not its current owner.
- The check is per call, not per session; an in-flight install that already passed the check completes.
