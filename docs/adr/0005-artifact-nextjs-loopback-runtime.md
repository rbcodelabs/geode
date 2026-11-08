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
  through a never-shown offscreen `BrowserWindow` (`show: false`, content-sized
  to the manifest viewport) bound to a throwaway session with the same
  restrictions. An unattached `WebContentsView` is not used: it has no host
  surface, never paints, and `capturePage()` returns an empty 0x0 image
  (observed). No visible window is created.

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

## Open requirements: local daemon and multiple vaults (not built)

Everything above assumes the dev server listens on the Mac's own loopback. The
local daemon (an `agent-threads` daemon in an Apple `container` VM, see
`docs/design/enterprise-controls.md` section 4) runs `next dev` inside the VM,
so its loopback is not the Mac's. The design is to publish the dev-server port
from the container to the Mac's `127.0.0.1`. With two vaults open, each with its
own container, a hardcoded host port can collide, or worse, make one vault's
artifact load the other vault's app, because the exact-origin filter checks
host and port, not who owns the port.

**None of the following is implemented or tested.** Today the manifest takes a
literal loopback URL, and nothing ties a port to a container.

1. **Dynamic host ports per container.** Publish with an OS-assigned host port
   (for example `127.0.0.1:0:<container-port>`) and read back the assigned port.
   No fixed host port is configured or assumed. The dev server inside the
   container must bind `0.0.0.0` (a server bound to the VM's `127.0.0.1` cannot
   be forwarded).
2. **Logical reference in manifest v2, not a raw port.** The manifest names the
   dev server logically (for example a `devServer` id scoped to the vault)
   instead of `http://127.0.0.1:<port>`. Main resolves the reference to the
   current host port at load time. This is a schema change on top of the
   current v2 and needs its own version or field gating, and the existing
   literal-URL path stays valid for dev servers started on the Mac.
3. **Ownership check before load.** Before registering or loading, main
   verifies the resolved host port is published by the daemon container that
   belongs to this artifact's vault. If the port is unowned, owned by another
   vault's container, or the container is gone, registration fails closed. The
   exact-origin filter then allows only the verified origin.
4. **Loopback-only publishing.** Ports are published to the Mac's `127.0.0.1`
   only, never `0.0.0.0` or a LAN address. The strict URL parser's rejection of
   other hosts stays unchanged.

Still to decide: where the container-to-vault mapping lives, how main queries
the container runtime, how this interacts with the `threadExecution` policy
(`localDaemon`), and what happens when the container restarts and the host port
changes (likely the same re-register-in-place behavior as a stale URL).

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
