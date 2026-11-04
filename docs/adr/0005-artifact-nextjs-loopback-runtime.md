# ADR 0005: Artifact manifest schema v2 and the loopback Next.js runtime

Status: Accepted. Extends ADR 0004 (the "no dev server" non-goal is superseded
for the `nextjs` runtime only; static artifacts are unchanged).

## Context

The Threads Design plugin produces richer prototypes with a Next.js dev server.
It writes `schemaVersion: 2` manifests (`runtime: "nextjs"`,
`permissions.network: "loopback"`, `entry: "app/page.tsx"`). Geode 0.30.15
rejects every manifest that is not v1/static/none, so such designs cannot be
opened. ADR 0004 said a dev-server runtime needs a separate capability contract
and an explicitly reviewed extension. This is that extension.

## Decision

- **Manifest v2.** Geode reads schema versions 1 and 2. v1 is exactly as
  before. v2 adds `runtime` in `static | nextjs` and `permissions.network` in
  `none | loopback`, coupled: `static` requires `none`, `nextjs` requires
  `loopback`. `clipboard` stays `false`. `nextjs` with `vault: "read"` is
  rejected so the vault bridge and guest preload never exist on an http origin.
  Unknown versions (3+) are still rejected, never guessed.
- **The producer owns the dev server.** The plugin starts
  `next dev -H 127.0.0.1 -p <port>`, then opens the view with
  `{ root, url, runtime: "nextjs" }` and may call
  `captureArtifact(root, { url })`. Geode does not spawn or supervise the
  process.
- **Main validates the URL, never the renderer.** `parseLoopbackDevServerUrl`
  accepts only `http://127.0.0.1:<port>[/]` with an explicit port in
  1024-65535: no credentials, path, query, or fragment, no `localhost`,
  `0.0.0.0`, IPv6, or alternate spellings. A URL for a static manifest, or a
  missing URL for a nextjs manifest, fails registration.
- **Exact-origin request filter.** The session `onBeforeRequest` filter stays
  authoritative. For a nextjs artifact it allows only that one origin over
  `http` and `ws` (plus inert `data:`/`blob:` subresources) and denies
  everything else, including other loopback ports, other hosts, `https`, and
  the `geode-artifact` scheme. Guest `will-navigate`, redirects and frame
  navigations off the origin are cancelled, and popups are denied outright.
- **Dev-only CSP.** `onHeadersReceived` replaces any CSP from the dev server
  with `default-src 'self'`, `script-src 'self' 'unsafe-inline' 'unsafe-eval'`
  (React Refresh and webpack dev need it), `connect-src 'self' ws://127.0.0.1:<port>`,
  `frame-src/child-src/object-src 'none'`, `base-uri 'self'`,
  `form-action 'none'`. It is a separate constant from the static CSP and is
  defense in depth, not the boundary.
- **No privileged surface.** nextjs artifacts get no vault grant, no guest
  preload, no Node, and keep the ephemeral partition, denied permissions and
  blocked downloads. No file watcher is attached; HMR handles updates.
- **Capture.** With a live guest, capture uses it. Otherwise main captures
  through an unattached offscreen `WebContentsView` bound to a throwaway session
  with the same restrictions. No visible window is created.

## Threat model

- The dev server is a localhost process the user's plugin started. Any other
  local process that binds the chosen port can serve content, so the guest is
  treated as untrusted exactly like a static artifact: sandboxed, isolated
  session, no bridges. The risk added over static is reachability of one
  loopback port, not host privileges.
- A compromised renderer could pass an arbitrary URL; main re-validates it with
  the strict parser, so the allowed origin can only ever be `127.0.0.1:<port>`.
- A page in the guest cannot reach other loopback services (other ports),
  the LAN, or the internet through fetch, XHR, WebSocket, or navigation.
- `unsafe-eval`/`unsafe-inline` widen what that one origin's own scripts can do
  but not where they can connect or what they can access.

## Rejected alternatives

- Allowing `localhost` or a port range: widens the filter to services the
  artifact has no business reaching.
- Letting Geode spawn the dev server: process, dependency, and teardown risk
  that the plugin already owns.
- Serving nextjs through the vault bridge: no use case, and it would put the
  guest preload on an http origin.

## Consequences

- Prototypes can use a real Next.js app while keeping the ADR 0004 boundary.
- Geode must keep the exact-origin filter and the URL parser covered by tests.
- A stale persisted `url` shows a load error until the plugin reopens the view
  with the current port; the same root re-registers in place.
