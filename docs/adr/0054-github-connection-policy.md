# ADR 0054 — GitHub connection policy

Status: Accepted
Date: 2026-10-22
Builds on [ADR 0002](0002-enterprise-plugin-policy.md) (managed policy, fail open) and
[ADR 0051](0051-policy-layering.md) (machine + vault layering).
Design: [enterprise-controls.md](../design/enterprise-controls.md), section 5.

## Context

Settings -> GitHub signs a user in to a GitHub App with the device flow and hands threads short-lived,
repository-scoped tokens. Every input to that (App `clientId`/`appSlug`, the allowlists, connect and
disconnect) was user-writable, so none of it bound an administrator's intent. Stage 1 added the `github`
policy schema and layering; this ADR records its enforcement.

## Decision

All enforcement is in the **main process**, against the **effective policy for the calling window's vault**,
read fresh on every call (no cache, no watcher). The policy is read in `currentGithubSettings()` in
`main.ts` and passed to `resolveGithubAppSettings`, so the service sees it on every operation.

| Policy field | Behavior |
|---|---|
| `clientId`, `appSlug` | Pinned. Beat env vars, the vault's `.geode/app.json` and `geode.json`, in both `resolveGithubAppSettings` and `describeGithubAppSettings` (new source value `policy`). They apply with or without `settingsLocked`. The App lookup and the device flow read the resolved values, so they use the pin. Tokens issued by another App when a pin appears are **kept** (never sent to the pinned App) and the status is `reauth_required`; relaxing the pin restores them. |
| `settingsLocked` | `github-auth-set-settings` (save and reset) is refused with `blocked by administrator policy: github`. The form is shown read-only with "Managed by your administrator". |
| `allowedOwners`, `allowedRepos` | One more entry in `GithubAppSettings.allow`, which `isRepoAllowed` already requires every entry to satisfy. env, `geode.json` and the vault can narrow but cannot remove it. Honored by `getAccessToken(repo)`, `listAccess` and `checkRepo`. A malformed list is already `[!none]` from stage 1 and restricts everything (fail closed). |
| `connect: false` | `github-auth-start` is refused before any network call. The UI shows a managed note instead of a Connect button. An existing connection is **blocked, not deleted**: no tokens are issued until the policy is relaxed. |
| `disconnect: false` | `github-auth-disconnect` is refused; tokens stay. Machine-only (stage 1). See open question below. |
| `allowedLogins` | Checked against `fetchViewerLogin` before the token is saved. Mismatch (or an unreadable login) rejects the sign-in; the token is discarded and never persisted. Also re-checked on every token issuance: an already-connected non-matching account becomes state `blocked_by_policy`, stops getting tokens, and the UI says to reconnect with an allowed account or contact the administrator. Matching is case-insensitive, exact or a single leading `*` (`*_corp-emu`). Relaxing the policy restores the connection. |
| `deliverToRemoteDaemon` | **Not enforced here.** The agent-threads plugin has no remote-daemon GitHub delivery today (host and local container only). The value is exposed in `get-effective-policy` (`effective.github.deliverToRemoteDaemon`); enforcement belongs to stage 3, in the plugin, when remote delivery exists. |

New auth status value: `{ state: "blocked_by_policy", login, message }`. `getStatus()` also returns
`managed: { settingsLocked, connect, disconnect, loginRestricted }` so the UI can explain disabled controls.
New error code `blocked_by_policy` (`GithubAuthError`) crosses IPC as `{ ok: false, code, message }`; every
refusal message starts with `blocked by administrator policy: github`.

## Failure modes

- Missing, unreadable or invalid policy file: fail open (ADR 0002), unchanged behavior.
- `allowedOwners`/`allowedRepos`/`allowedLogins` present but unusable: fail closed (`!none` sentinel).
- Login cannot be fetched while `allowedLogins` is set: treated as not allowed (cannot show it is).
- Policy changes while a sign-in is pending: `connect` and `allowedLogins` are evaluated again when the
  token arrives, so the token is dropped if the policy now forbids it.

## Limits (what this does not do)

- The renderer runs with `nodeIntegration`. Renderer-side disabling is advisory; the guarantees above hold
  for calls into Geode's main-process handlers, not for code that already has Node access.
- A user's own `gh` login, `GH_TOKEN`, git credentials or a personal token outside Geode are untouched. Use
  `threadExecution` controls and endpoint egress rules for that.
- The tokens are in a keychain-backed file that Geode, and any code in the renderer's Node context, can
  reach. Blocking is "Geode stops issuing tokens", not "the token is unreadable".
- `allowedLogins` proves the account that signed in through this flow; it cannot stop the same user
  authorizing the App with a different account on another machine.
- The pinned values are as trustworthy as the machine policy file (ADR 0002): admin-owned path or MDM.

## Test seam

`GEODE_GITHUB_API_BASE` (already used by community install) now also redirects `api.github.com`, and the new
`GEODE_GITHUB_WEB_BASE` redirects `github.com` (device flow endpoints), so e2e can run against a local fake.
Unset in production. It is not a policy boundary: anyone who controls the app's environment can already do
more.

## Open question

`disconnect: false` protects a per-user OAuth token, not an admin-provisioned one, so there may be little to
protect; it is implemented as specified and kept for review. It does not stop expiry-driven re-authentication
or an App change from clearing tokens (those are not user disconnects).
