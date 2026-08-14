# ADR 0002 — Enterprise-managed plugin allowlist/blocklist

**Status:** Accepted.
**Date:** 2026-08-13

---

## Context

Geode is a solo-maintained, local-first, MIT-licensed Obsidian clone (Electron
+ TypeScript + CodeMirror 6, renderer with `nodeIntegration: true`). Its
plugin model already mirrors Obsidian's: a plugin is a folder at
`<vault>/.geode/plugins/<id>/` containing `manifest.json` + `main.js` (+
optional `styles.css`), discovered and enabled/disabled by `PluginManager`
(`src/renderer/plugin-manager.ts`). The enabled-set is a per-vault JSON array
at `<vault>/.geode/plugins.json`. Plugins run with full Node/Electron access —
same trust model as Obsidian.

There is currently no machine-level concept of "which plugins are allowed to
run" at all. Every enable/disable decision lives per-vault, made by whoever
opens Geode. An IT admin deploying Geode to a fleet of managed machines (via
Jamf, Intune, or manual imaging) has no way to constrain which third-party
plugin code can execute, short of restricting filesystem write access to
`.geode/plugins/` itself.

### Locked-in constraints (not up for relitigation)

1. **Delivery: managed policy file, no console, no phone-home, no per-org
   fork.** Consistent with Geode having no backend, no auth, no licensing
   infrastructure today, and a stated local-first philosophy.
2. **Scope: plugin allowlist/blocklist only**, this iteration. Schema must not
   preclude future policy areas (feature flags, update pinning, forced
   settings) but must not design them now.
3. **Not monetization.** No license keys, no entitlement checks, no paid-tier
   gating. This is an admin-manageability feature available to anyone.

## Decision

1. Geode's main process reads a single JSON file from a fixed, OS-specific,
   machine-level path (not inside any vault, not inside the per-user Electron
   `userData` directory) on every `get-plugin-policy` IPC call — no caching,
   no file watcher.
2. The schema is namespaced (`{ policyVersion, plugins: { mode, ids } }`) so
   future policy areas can be added as sibling keys without a breaking
   change.
3. Enforcement happens in exactly one place: `PluginManager.enable()`. A
   blocked plugin's `enable()` call throws before any code executes; nothing
   about plugin discovery, manifest parsing, or the persisted
   `.geode/plugins.json` enabled-list is touched by policy.
4. Policy is evaluated fresh on every vault open (`PluginManager.initialize()`)
   but not live-watched — an already-running vault with an already-loaded
   plugin is not interrupted mid-session if the policy file changes
   underneath it.
5. Tamper resistance for v1 is OS file permissions only (the policy path
   requires admin/root to write on all three platforms). No cryptographic
   signing.

## Scope

**In scope:**
- A single machine-level policy file, read-only, no caching.
- Plugin allowlist/blocklist by manifest `id`.
- Fail-open on any malformed/missing/unreadable policy.
- A startup Notice for a plugin blocked on launch, and a Settings badge for
  community-tracked blocked plugins.

**Non-goals (deferred, see "Open questions / future extensibility" below):**
- Feature flags, update pinning, or forced settings (future sibling keys).
- Wildcard/glob matching, dual allow+block precedence rules.
- Live-apply / file watching mid-session.
- Cryptographic signing / integrity verification.
- Windows GPO/ADMX registry-based policy.

## Alternatives considered

### Delivery mechanism

| Option | Why rejected |
|---|---|
| Policy embedded in the vault (`<vault>/.geode/policy.json`) | Same trust boundary as everything else a normal user can already edit — defeats the purpose. Also multiplies admin effort across N vaults instead of one machine-wide file. |
| Central admin console / SaaS policy service | Requires a backend, auth, and hosting Geode has none of today; violates "no phone-home" and "local-first" explicitly. |
| Build-time white-label fork per organization | Doesn't scale past a handful of orgs, no per-org build pipeline exists, and it's a packaging/distribution problem, not a runtime one. |
| **Chosen: fixed OS-level machine path, read locally, no network** | Matches Chrome's Linux policy model and VS Code/GitHub Copilot's managed-settings model — plain JSON files at admin-writable, MDM-deployable paths, no server round-trip. |

### Schema: allowlist vs. blocklist

| Option | Why rejected |
|---|---|
| Chrome's dual-list model (`ExtensionInstallBlocklist` + `ExtensionInstallAllowlist` with `"*"` wildcard) | Introduces precedence rules (which list wins?) that are pure complexity for a v1 with no evidence anyone needs it. |
| Allowlist-only, no blocklist | Doesn't cover the common enterprise case of "everything's fine except this one plugin we don't trust" without enumerating every approved plugin up front. |
| **Chosen: single `mode: "allowlist" \| "blocklist"` selector over one `ids` array** | No precedence ambiguity — a plugin id is unambiguously blocked or not from one field + one list. |

### Enforcement point

| Option | Why rejected |
|---|---|
| Filter policy-blocked ids out of the `plugins-list-ids` IPC response in main | Main process today does no plugin business logic, only path-safety and filesystem operations. It also removes the manifest info the UI needs to render a *named* "blocked by admin" row. |
| **Chosen: `PluginManager.enable()`** | Already the single point every enable path funnels through — the auto-enable loop and the community-install flow both call `enable()` directly. |

### Tamper resistance

| Option | Why rejected |
|---|---|
| Cryptographically sign the policy file | Geode has zero signing infrastructure anywhere in the codebase today. A signature scheme needs a key held by *someone* — no per-org key distribution story for a solo-maintainer OSS project — and would defend against a threat (a user with write access to a root/admin-owned path) that OS permissions already block. |
| **Chosen: rely on OS file permissions at the chosen paths** | Matches Chrome's and VS Code's own unsigned-JSON managed-settings tiers, protected only by filesystem ACLs. |

### Live-apply vs. read-once

| Option | Why rejected |
|---|---|
| `chokidar`-watch the policy file, hot-apply mid-session | No existing precedent for watching app-level config. Force-unloading a plugin mid-session risks losing in-progress plugin state for a feature that is not time-critical the way a security patch is. |
| **Chosen: read fresh (no cache) on each `get-plugin-policy` IPC call, applied at `PluginManager.initialize()` time** | A new vault window opened in an already-running Geode process picks up a just-changed policy immediately — but an already-open vault's already-loaded plugins are never interrupted. |

## Design

### 1. Policy file paths (fixed, per OS)

| OS | Path |
|---|---|
| macOS | `/Library/Application Support/Geode/managed-policy.json` |
| Windows | `%ProgramData%\Geode\managed-policy.json` |
| Linux | `/etc/geode/managed-policy.json` |

These are **not** the same directory as Geode's existing per-user app config
(`app.getPath("userData")`, which on macOS resolves under
`~/Library/Application Support/Geode/` — inside the user's home, not
`/Library/Application Support/` at the filesystem root). The managed-policy
path is root/admin-owned by construction; the userData path is user-owned.

macOS and Linux paths follow the precedent set by GitHub Copilot's VS Code
managed settings and VS Code's own Linux policy file — a single flat JSON
file, vendor-namespaced directory, no plist/ADMX machinery required. Windows
uses `%ProgramData%` because it's the conventional location for
admin-managed configuration independent of where the app binary is
installed, and the standard target for Intune/GPO file-drop deployments.

**Test/dev override:** the `GEODE_POLICY_PATH` environment variable, checked
before the OS-default path, mirrors the precedent set by ADR 0001's
`GEODE_GITHUB_API_BASE`/`GEODE_GITHUB_RAW_BASE` overrides — it exists purely
so unit/e2e tests can point at a temp file instead of requiring root writes
to `/etc` or `/Library` in CI.

### 2. Schema

```ts
interface ManagedPolicy {
  policyVersion: 1;
  plugins?: {
    mode: "allowlist" | "blocklist";
    ids: string[];          // plugin manifest `id` values, per plugin-manifest.ts ID_RE
  };
}
```

Example file (blocklist mode):

```json
{
  "policyVersion": 1,
  "plugins": {
    "mode": "blocklist",
    "ids": ["some-untrusted-plugin"]
  }
}
```

Notes:
- `policyVersion` is required from day one specifically so a future breaking
  schema change has a discriminant to gate on.
- The whole `plugins` key is optional — absence of `plugins` ⇒ no plugin
  restriction.
- Plugin identification is by manifest `id` (`src/renderer/plugin-manifest.ts`),
  the same identifier already used in `.geode/plugins.json` and
  `.geode/community.json` — no new identity scheme.
- `ids` entries are validated against the existing `ID_RE` pattern
  (`^[a-z0-9][a-z0-9-]*$`) at parse time; an entry that fails is **skipped
  with a logged warning**, not treated as invalidating the whole file.
- No glob/wildcard support in v1. Keeps matching a single `Array.includes`
  check, trivially unit-testable.
- **Extensibility for future policy areas:** add sibling top-level keys, e.g.
  `updates: { pin: "0.2.17" }` or `settings: { forced: {...} }`, following
  the same `policyVersion`-gated, optional-key pattern.

### 3. Where policy is loaded, and how it reaches the renderer

**Main process** (`src/main/main.ts`), alongside the existing app-level
(non-vault) config precedent already in the file — `appConfigPath()` /
`loadConfig()` / `saveConfig()`. The managed policy loader follows the same
"plain JSON via Node `fs`" pattern but is read-only and targets the fixed OS
path above:

```ts
function policyFilePath(): string { /* GEODE_POLICY_PATH override, else OS switch */ }
function loadManagedPolicy(): ManagedPolicy | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(policyFilePath(), "utf8"));
    return validatePolicy(parsed);
  } catch {
    return null; // missing file, unreadable, or invalid JSON — fail open
  }
}
```

New IPC handler, registered next to `get-recent-vaults`, deliberately **not**
inside the vault-scoped handlers, since policy is machine-level, not
per-vault:

```ts
ipcMain.handle("get-plugin-policy", () => loadManagedPolicy());
```

**Preload** (`src/main/preload.ts`), one addition to the `api` object, same
style as `getRecentVaults`:

```ts
getPluginPolicy: (): Promise<ManagedPolicy | null> => ipcRenderer.invoke("get-plugin-policy"),
```

**Renderer**: a new pure module `src/renderer/policy.ts`, mirroring the shape
of `plugin-manifest.ts` (parse/validate logic separated from IO, fully
unit-testable):

```ts
export function isPluginBlocked(policy: ManagedPolicy | null, id: string): boolean {
  const p = policy?.plugins;
  if (!p) return false;
  const listed = p.ids.includes(id);
  return p.mode === "allowlist" ? !listed : listed;
}
```

**Implementation note (resolved during build):** `src/main/main.ts` imports
`validatePolicy`/`ManagedPolicy` directly from `src/renderer/policy.ts`
rather than duplicating the validation logic. `esbuild.config.mjs` bundles
`main.ts` and `app.ts` (renderer) as two **independent** `bundle: true`
entry points built from their own module graphs — "main" and "renderer" are
directory conventions, not a hard compilation boundary enforced by the
bundler or `tsconfig.json` (`include: ["src/**/*.ts"]` covers both). Because
`policy.ts` has zero IO and zero DOM/Electron imports, importing it from
`main.ts` pulls in only what `policy.ts` itself imports (nothing), so the
main-process bundle gains no renderer/DOM code. Sharing one module means the
validation logic (including the fail-open behavior tested in
`tests/unit/policy.test.ts`) can never drift between the two processes.

### 4. Enforcement point: `PluginManager`

- `private policy: ManagedPolicy | null = null;`
- `initialize()` fetches policy before the auto-enable loop and surfaces a
  blocked-on-startup plugin via `App.notify()` (existing toast mechanism),
  not silent `console.error`.
- `isBlocked(id): boolean` — a public, **stateless** check re-derived from
  the current policy each call.
- `enable()` gates right after the "unknown plugin" check and before the
  `minAppVersion` check:

```ts
if (this.isBlocked(id)) {
  throw new Error(`Plugin "${id}" is blocked by administrator policy`);
}
```

**What happens to a plugin that's in `.geode/plugins.json` but now
blocked:** nothing rewrites that file. `enable()` throws before the plugin is
marked loaded, so `isEnabled(id)` correctly reports `false` for the rest of
the session, and the plugin never executes — that *is* the auto-disable; it's
implicit rather than an explicit `disable()` + persist call. Deliberately
leaving `.geode/plugins.json` untouched means: if an admin later relaxes the
policy, the plugin resumes automatically on the next vault open with no user
action required, because the persisted enabled-list still reflects the
user's actual intent — policy is a runtime gate layered on top of that
intent, not a mutation of it.

The community-install path needs no change — it already funnels through
`enable()`, so a blocked plugin simply can't be enabled immediately after
install; the install itself (files written to disk) is unaffected.

### 5. UI: surfacing "blocked by admin policy"

Geode does not have a generic "all installed plugins, with an enable/disable
toggle per plugin" settings view. The only per-plugin management UI today is
`SettingsModal.renderCommunityRow()`, which only lists plugins/themes tracked
in `.geode/community.json`. Given that gap, the design is two-tiered:

1. **MVP, works regardless of install source:** the `App.notify()` toast
   added in `initialize()` is the primary, always-present signal. It fires
   for *any* blocked plugin that was previously enabled, whether it was
   hand-dropped or community-installed.
2. **Enhancement, community-tracked items only:** `renderCommunityRow()` gets
   a `blocked by admin` badge next to the existing `pinned` badge, using
   `pluginManager.isBlocked(item.id)`.

**Known gap, not designed here:** a proper Obsidian-style "Installed
plugins" list — every plugin under `.geode/plugins/`, community-tracked or
not, with a real enable/disable toggle — doesn't exist yet. A hand-dropped,
policy-blocked plugin has *only* the startup toast, not a persistent
settings-row indicator. Flagged as follow-up work, not scope-creeped into
this ADR.

## Failure modes

| Condition | Behavior |
|---|---|
| Policy file absent (the overwhelming majority of installs) | Fail open — every plugin allowed. |
| Policy file present but malformed JSON, or `policyVersion` missing/unrecognized | Fail open, logged via `console.error` in main. |
| `plugins.ids` contains an entry that fails the `ID_RE` format check | That single entry is skipped (logged), the rest of the policy still applies. |
| `plugins.mode` present but not `"allowlist"`/`"blocklist"` | Whole `plugins` block treated as absent (fail open), logged. |
| Two Geode windows/vaults open in one running process, policy file changes on disk mid-session | The already-open vault's already-loaded plugins are unaffected (no watcher). A new vault opened in the same running process re-fetches via IPC (no cache) and sees the change immediately. |
| A plugin blocked by policy was enabled in a prior session | `enable()` throws on the next `initialize()`, `.geode/plugins.json` is left untouched, a Notice fires. If policy later relaxes, the plugin resumes with no user action. |

## Open questions / future extensibility

Not designed here, per the locked scope, but the schema (`policyVersion` +
namespaced top-level keys) is chosen so none of these require a breaking
change:

- **Feature flags** — e.g. `features: { disabled: string[] }`.
- **Update pinning** — e.g. `updates: { pin: string }`.
- **Forced settings** — e.g. `settings: { forced: Partial<AppSettings> }`.
- **Wildcard/glob plugin matching** — deferred; reintroduces the
  precedence-ambiguity problem the single-`mode` design was chosen to avoid.
- **Windows GPO ADMX template** — a much bigger lift (template authoring,
  registry-read code path in main) than a JSON file; not justified for v1.
- **Live-apply / file watching** — revisit only if there's a real
  requirement for policy changes to take effect without a restart.
- **Signing / integrity verification** — revisit only if Geode ever gains
  general code-signing infrastructure for other reasons.

## Test plan

Matches the repo's existing three-tier gate (`typecheck`, `test:unit` →
`vitest run`, `test:e2e` → `build` + `playwright test`).

- **`tests/unit/policy.test.ts`** — `isPluginBlocked()` (allowlist blocks
  unlisted incl. empty list ⇒ blocks all; blocklist blocks only listed; no
  `plugins`/`null` policy ⇒ never blocks) and `validatePolicy()` (missing
  `policyVersion`, unknown `policyVersion`, invalid `ids` entries skipped not
  fatal, invalid `mode`).
- **`tests/unit/plugin-manager.test.ts`** (extended) — `enable()` throws for
  a blocked id and never calls `onload`; `initialize()`'s auto-enable loop
  skips a blocked previously-enabled id, records a `loadErrors` entry,
  notifies, and does not call `writeConfig`; `isBlocked()` reflects policy
  changes across two `initialize()` calls (admin relaxes the policy).
- **`tests/e2e/plugin-policy.spec.ts`** — using `GEODE_POLICY_PATH` pointed
  at a temp file: blocklist case, allowlist case, and a no-policy-file
  baseline case confirming fail-open doesn't regress the default
  (non-enterprise) experience.

**Not tested:** actually deploying a file to the real OS-specific system
paths via Jamf/Intune — a deployment/ops verification step for whoever
pilots this with a real managed fleet, not something CI can assert.

## Consequences

- **What becomes easier:** an org can deploy Geode via standard MDM tooling
  and constrain plugin execution without any server-side infrastructure. The
  feature is genuinely free for any deployer.
- **What becomes harder:** every future policy area now has a schema
  precedent to respect (`policyVersion` + namespaced keys).
- **What we're betting on:** that OS file permissions are sufficient tamper
  resistance for the threat model that actually exists (a managed device
  where the standard user isn't admin/root) — a real but generally accepted
  limitation of file-based (vs. registry/profile-based) policy systems, per
  Chrome/VS Code precedent.
- **What would make me revise this:** a real deployment report showing (a)
  `%ProgramData%` write permissions are looser than assumed on some Windows
  configurations, or (b) actual demand for live-apply / wildcard matching /
  dual allow+block lists that this v1 deliberately deferred.
