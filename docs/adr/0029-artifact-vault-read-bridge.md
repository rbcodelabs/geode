# ADR 0029: Opt-in, allowlisted Bases read bridge for sandboxed artifacts

Status: Accepted. Extends [ADR 0004](0004-artifact-sandbox.md); nothing in
0004 is relaxed.

## Context

ADR 0004 gives agent-generated HTML artifacts a hermetic origin: no Node, no
network (`connect-src 'none'`), no preload, no guest-to-host channel. That makes
artifacts safe but static. Rick wants durable artifacts (dashboards, boards)
that render **live Bases query results**, so they stay correct as notes change.

The producer of an artifact is an LLM, and the artifact's HTML/JS is untrusted
content. Anything we expose to it is exposed to whatever the model (or a prompt
injection that steered the model) wrote.

## Decision

Add one capability, **read-only Bases queries**, that is off unless the
artifact's validated manifest asks for it, and that is scoped by an allowlist.

### Manifest (schema version stays 1, additive)

```jsonc
"permissions": {
  "network": "none",
  "clipboard": false,
  "vault": "read",                       // optional; "none" (default) | "read"
  "vaultAllowlist": ["Tasks.base", "Projects/", "Bases/*.base"]  // required, 1-32 entries, iff vault is "read"
}
```

- Absent `vault` equals `"none"`; every existing v1 manifest stays valid.
- `vaultAllowlist` is rejected unless `vault` is `"read"`, and is required and
  non-empty when it is. Unknown permission fields are still rejected, and there
  is deliberately no `"write"` value.
- Entry grammar (vault-relative, case-sensitive, validated at parse time):
  exact path (`Tasks.base`), folder prefix with trailing slash (`Projects/`),
  `*` within a segment, `**` segment spanning directories (`**/*.base`).
  Absolute paths, drive letters, backslashes, control characters, empty/`.`/`..`
  segments, and match-everything entries (`**`, `**/*`, `*`) are rejected.
- The grant is read once at registration and is fixed for that registration:
  editing `artifact.json` live (which triggers the existing hot reload) cannot
  widen the allowlist of an already-open view.

### Guest API (`window.geodeArtifact`, only for vault-read artifacts)

Artifacts without the permission get **no** `window.geodeArtifact` and no
preload at all. For artifacts with it:

```ts
window.geodeArtifact.query(request: {
  base: string;     // vault-relative path of a .base file, must match the allowlist
  view?: string;    // view name inside the base; defaults to the first view
  limit?: number;   // positive integer, default 500, clamped to 1000
}): Promise<QueryResult | { error: { code: ErrorCode; message: string } }>   // never rejects

window.geodeArtifact.onChange(cb: (e: { changedAt: number }) => void): () => void  // returns unsubscribe
```

Success shape (plain JSON; survives `structuredClone`):

```ts
interface QueryResult {
  base: string;                       // resolved path
  view: string;
  viewType: string;                   // e.g. "table", "cards"
  columns: { path: string; name: string }[];   // view.order (or every known property if unset); name = displayName override or path
  rows: Row[];                        // filtered, sorted, limited by the base; capped by `limit`
  groups: { key: Cell; rows: Row[] }[] | null; // present iff the view has groupBy
  summaries: Record<string, Cell>;    // column path -> custom summary value
  totalRows: number;                  // rows produced before the cap
  truncated: boolean;                 // true if rows were dropped by `limit` or the ~3 MB size budget
}
interface Row {
  file: { path: string; name: string; basename: string; extension: string; mtime: number; ctime: number; size: number };
  values: Record<string, Cell>;       // keyed by columns[].path
  formulas: Record<string, Cell>;     // every base-level formula, keyed by formula name
}
interface Cell {
  type: "null"|"string"|"number"|"boolean"|"date"|"duration"|"list"|"object"|"link"|"file"|"regexp"|"html"|"image";
  value: unknown;   // null | string | number | boolean | date as epoch ms | {amount,unit} | plain JSON array or object |
                    // link {raw, display|null, path|null} | file as vault path | regexp {source,flags} | image source string
  display: string;  // the text Geode itself would render (truncated at 10k chars)
}
type ErrorCode = "bad_request" | "not_allowed" | "not_found" | "invalid_base" | "query_failed" | "too_many_requests" | "unavailable";
```

`onChange` fires after the vault or metadata cache changes, debounced
(250 ms). It carries no path or content: it says *that* something changed; the
artifact re-runs `query`, which is allowlist-checked. Inline base definitions
are deliberately not supported: a guest-supplied filter could select arbitrary
vault data, which would bypass the allowlist.

### Mechanism

- `src/main/artifact-guest-preload.ts` is a separate, tiny sandboxed preload.
  `ArtifactRuntime.secureWebviewAttachment` sets `webPreferences.preload` to it
  **only** when the validated manifest has `vault: "read"`; the other forced
  `webPreferences` (`nodeIntegration:false`, `sandbox:true`,
  `contextIsolation:true`, `webSecurity:true`) are unchanged. It exposes a frozen
  `{ query, onChange }` through `contextBridge`. It never exposes
  `ipcRenderer`, an IPC event, or Node APIs, and it sends with `sendToHost`,
  so messages reach only the embedding renderer, never the main process.
- `src/renderer/views/artifact-view.ts` (which owns the `<webview>`) handles
  the guest's `ipc-message`s through `ArtifactVaultBridge`
  (`src/renderer/artifacts/vault-bridge.ts`). Each request is re-validated
  server-side (strict field list, `.base` extension, portable path with no
  traversal), checked against the manifest allowlist **before** any vault
  lookup (so a denied path does not reveal whether the file exists) and again
  on the resolved canonical path, then run with the existing `runQuery` engine
  and serialized to plain JSON. Errors resolve to `{ error }`. At most 4 queries
  run concurrently, rows and response size are capped, and the toolbar shows a
  "Vault: read" badge listing the allowlist.
- Pure policy (path normalization, allowlist matching, request parsing) lives in
  `src/artifacts/vault-access.ts` and is unit tested; the manifest parser uses
  the same validator.

### What does not change

- `STATIC_ARTIFACT_CSP` (`connect-src 'none'`, no frames/forms/objects) and
  `isArtifactUrlAllowed` / the session `webRequest` filter are untouched. Data
  reaches the artifact only through the preload channel, never over the network.
- Permission requests, downloads, popups, navigation, clipboard stay denied.

## Threat model

Assets: vault note contents/frontmatter. Adversary: artifact HTML/JS written by
an LLM, possibly steered by injected content.

- **Reading outside the grant.** Mitigated by the allowlist (exact paths,
  folders, narrow globs only), lexical rejection of `..`/absolute/backslash
  paths, matching on the resolved canonical path, `.base`-only targets, and no
  inline definitions.
- **Scope of an allowed Base.** A Base is code: it selects rows by its own
  filters. Allowlisting `Tasks.base` grants whatever rows and columns that view
  returns, including note properties, **not** the file bodies. The allowlist
  governs *which Bases*, not which notes they touch. Only allowlist Bases whose
  output you are willing to expose to the artifact. (Note bodies/embeds are out
  of scope for v1.)
- **Exfiltration.** The artifact cannot reach the network (CSP + session
  filter), so queried data stays in the guest. The residual channel is any
  covert side channel the page already had; none is added.
- **Self-granting.** The manifest is authored alongside the untrusted content,
  so the manifest is a *request*, not a consent. v1 mitigates by surfacing the
  grant in the view and by fixing it per registration; an explicit user consent
  prompt (persisted per artifact) is the recommended follow-up before artifacts
  from non-first-party producers are supported.
- **Privilege escalation via preload.** The preload is a separate file, attached
  per registration, with a two-function frozen surface, no Node, no raw IPC.
- **Resource abuse.** Concurrency, row, and size caps; a query that never
  resolves times out in the guest after 15 s.
- **Writes.** None exist. No write capability is reachable through this bridge.

## Rejected alternatives

- **Inline query definitions from the guest**: would bypass the allowlist.
- **Custom protocol / fetch to a Geode endpoint**: requires relaxing
  `connect-src` and the URL filter, the very boundary 0004 defends.
- **Handling guest IPC in the main process**: main has no vault index or
  metadata cache; the renderer owns both, and `sendToHost` keeps the channel
  scoped to the embedder.
- **Bundling the guest API inside every artifact preload**: widens the default
  surface; the bridge exists only where explicitly requested.

## Consequences

- Artifacts can show live Bases data with a small, reviewable surface.
- Allowlist authoring is a producer responsibility; invalid grants fail loudly
  at registration with path-level manifest issues.
- Mobile has no artifact runtime, so nothing changes there.
