# ADR 0053 — Sync policy for the in-app providers

Status: Accepted
Date: 2026-10-22
Extends [ADR 0002](0002-enterprise-plugin-policy.md) and [ADR 0051](0051-policy-layering.md).
Design: [enterprise-controls.md](../design/enterprise-controls.md), section 3 (in-app providers only; the headless
`geode-wiki sync` CLI is a separate change).

## Decision

The effective `sync` policy (machine layer intersected with the vault's narrowing-only layer) is enforced in the **main
process**, read fresh on every call from `get-effective-policy`'s source (`loadEffectivePolicy`) for the calling
window's vault. No cache, no watcher.

- `sync.enabled: false` is the kill switch for every in-app provider.
- `sync.providers` narrows to a set. The ids are `hub` (the built-in "Folder, SSH or HTTPS hub", registered in the
  renderer as `geode.hub`; both spellings mean hub) and `icloud`. A plugin-provided provider is matched by its own id.
  Omitted means all. An empty list, or one whose entries were all invalid (the validator's fail-closed sentinel), permits
  none.
- `sync.hubAllowlist` pins hub origins: exact scheme + host + port, compared as `URL.origin` (host lower-cased and
  punycoded, default port dropped, path/query/fragment ignored). `https://` and `wss://` differ; a trailing dot, a
  different port, a subdomain, userinfo or a non-ASCII host never match (hub URLs with credentials, a backslash or
  non-ASCII are already rejected by `hubUrlProblem`). With an allowlist set, folder and ssh hubs are refused: they have no
  URL to match, a folder can be a network mount and ssh reaches any host the user can.

Decision functions are pure and live in `src/shared/sync-policy.ts` (used by main and, advisory only, the renderer).

## Enforcement points

| Where | What it refuses |
|---|---|
| `hub-sync` (`src/main/hub-sync-ipc.ts`) | Everything except `close` when sync is off or `hub` is not permitted. Requests that carry a target (`discover`, `probe`, `createVault`, `open`) are additionally checked by `validateHubTarget(target, policy)` (`src/sync-node/app-hub.ts`) before any provider, folder access or ssh child exists. |
| `icloud-container` (`src/main/icloud-container-ipc.ts`) | Every method except `discardWrite` (local cleanup of staged writes) when sync is off or `icloud` is not permitted. Reported as bridge code `unavailable` with the policy message (no new error code). |
| `sync-owner-claim`, `sync-private-storage`, `sync-local-apply`, `vault-sync-scan`, `vault-sync-scan-blocked` (`main.ts`, via `assertSyncChannelAllowed`) | Throw `blocked by administrator policy: sync ...` when sync is off or the provider list permits nothing. These channels cannot tell which provider calls, so a per-provider narrowing cannot be applied here. `sync-owner-release` and `vault-refresh-scan` are deliberately not gated (release must always be able to end a lease; the refresh scan is used by non-sync features, and `vault-sync-scan` is not reachable from refresh while `scanForRefresh` exists). |
| Renderer (`HubSyncProvider`, Sync pane, provider picker, iCloud toggle) | Advisory: refuses early with the same message and shows "Managed by your administrator" notes. The only place an **HTTPS hub allowlist** can be applied, because that hub is dialled from the renderer (see Limits). |

`sync-local-apply` is also used by mobile pairing to write portable settings, so `sync.enabled: false` stops pairing's
settings apply too (it already degrades to "skipped" when no lease can be claimed).

## Mid-session changes and non-destructive disabling

Disabling is a refusal of new work, never a cleanup. No local history, vault content, stored hub binding or hub
configuration is deleted or rewritten; the Settings pane still lists the bindings, and removing the policy resumes sync.

- New operations (a new session, claim, storage or apply call) are refused immediately: the policy is read per call.
- An in-flight request is not aborted; it completes (guarded applies are journaled and atomic).
- An open hub session is ended cleanly: the next session method (scan, put/read blob, append) is refused and the main
  process closes that session (and its ssh child) first. `close` and `sync-owner-release` always work.
- Saving hub settings is still allowed; using the hub is what is refused.

## Failure modes

Missing, unreadable, oversized or invalid policy files fail open (ADR 0002); a policy that fails to evaluate is logged
and allows. A `sync.hubAllowlist` or `sync.providers` array that is non-empty but has no valid entry fails CLOSED (the validator
replaces it with a sentinel that matches nothing), and an explicitly empty array restricts everything, so a typo in every
entry can never remove the restriction. (Changed after integration; stage 1 originally dropped such a list.)

## Limits (not enforceable here)

- The renderer runs with `nodeIntegration`, so renderer code, including plugins, can bypass every renderer check.
- **HTTPS hubs are dialled from the renderer** (`src/renderer/sync/http-store.ts`, WebSocket) and never cross IPC, so
  the main process cannot see them. `hubAllowlist` is enforced for them only by renderer code. What main does control
  is the guarded local half every history sync needs (owner lease, private storage, guarded apply, strict scan): with
  `sync.enabled: false` those are refused, so an append-only hub sync cannot read or write the vault even if a renderer
  dials the hub.
- Plugin-provided providers (conditional-write coordinator) do not use those channels and run in the renderer; they are
  restricted only by `sync.providers` in renderer code. Use `plugins` policy to control them.
- Anyone who can run their own Node or the headless CLI is outside this control; endpoint controls are needed for that.
