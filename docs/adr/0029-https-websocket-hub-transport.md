# ADR 0029 — HTTPS/WebSocket hub transport for mobile

Status: Accepted
Date: 2026-10-12
Extends [ADR 0025](0025-geode-wiki-sync-cli.md) (the hub store and its `serve` protocol) and
[ADR 0007](0007-mobile-runtime-and-platform-boundary.md) (the mobile runtime boundary).

> Numbering note: this directory carries several duplicated numbers (0003, 0004, 0007, 0015, 0016, 0022, 0025).
> 0029 is the next unused number. `0007` here means `0007-mobile-runtime-and-platform-boundary.md`.

## Context

Desktop devices reach a hub store by folder or by `ssh <host> geode-wiki sync serve`. The hub protocol
(`serveStore`: JSON header lines plus length-prefixed binary frames) is transport-neutral, but both existing
transports need something an iPhone does not have: a filesystem the app can address, or `ssh` and
`child_process`. ADR 0007 puts the mobile app in a web view with a small native plugin and no Node. Mobile sync was
therefore blocked on a transport the renderer can open by itself, for a person who runs their own hub.

Constraints that shaped the choice:

- **Self-hosted.** The hub is a directory on a machine the user owns. Geode does not run one, and ADR 0007
  explicitly leaves a Geode-hosted sync backend as a separate decision; this must not become one.
- **One engine, one protocol.** The history engine and the store protocol (limits, error codes, resumable
  uploads, pipelining) already exist and are tested against folder and ssh. A second protocol would be a second
  thing to keep correct.
- **Browsers cannot set headers on a `WebSocket`**, and a token in a URL is logged by proxies and kept in history.
- **Encrypted transport.** Certificate management is not something Geode should own.

## Decision

Add an HTTPS target to the hub provider, carried over a **WebSocket** that runs the existing store protocol
unchanged.

- **Server:** `geode-wiki sync serve --store <dir> --http --token-file <file> [--listen host:port]`
  (`src/sync-node/http-serve.ts`). One WebSocket connection is one `serveStore` session; the WebSocket is a byte pipe
  carrying binary frames only, with message boundaries ignored. The server binds loopback by default and does **not**
  terminate TLS; a proxy (`tailscale serve`) provides `wss://`. Minimal RFC 6455 is written in-repo, so there is no
  new dependency.
- **Client:** `HttpStoreProvider`/`HttpStoreSession` in the renderer (`src/renderer/sync/http-store.ts`), browser-safe
  and a one-to-one mirror of the ssh client. The session runs in the renderer on desktop and iOS alike; there is
  no main-process bridge for this target. The URL must be `https://` or `wss://`.
- **Authentication:** a shared bearer token. Over a WebSocket it travels as the sub-protocol entry
  `bearer.<base64url(token)>` next to `geode-store.v1` (Node clients may use `Authorization: Bearer`). It is checked
  in constant time before the upgrade, answered with a body-less `401`, never echoed back and never read from the
  URL. The client stores it only in `host.secrets.app` (Electron safeStorage, iOS Keychain) and refuses to take a
  token on a host without secure storage.
- **Mobile host:** iOS gets `host.syncSafety` as a port of the desktop guarded apply and sync-private storage over
  new native methods, so the same rails and crash recovery apply. Limits that come with the platform are stated, not
  hidden: iCloud placeholders are blocked paths, the native bridge carries at most 32 MiB so larger files (up to the
  100 MiB advertised) show as blocked on iOS, and the check-to-write window cannot be closed from JavaScript.

## Alternatives rejected

- **An embedded ssh client in the app.** It would reuse the existing remote command, but iOS has no `ssh` binary and
  no Node; it means bundling a native or WASM ssh stack, managing private keys and host-key trust on the phone,
  and running a long-lived socket from a web view anyway. More code and attack surface than a token over TLS.
- **Request/response HTTP (REST or RPC over POST).** Easy to proxy, but the protocol is a pipelined, resumable,
  chunked stream with backpressure; mapping it to stateless requests would mean redesigning sessions, upload
  windows and ordering, and re-proving the conformance suite. A WebSocket reuses the protocol and its tests as is.
- **A cloud store (an object store or file-sync service as the hub) or a Geode-hosted service.** The first has no
  atomic append or server-side verification for the engine to rely on and ties users to a vendor; the second is a
  Geode backend, which ADR 0007 keeps as a separate decision. Neither is self-hosted.
- **Token in the URL query string.** Simplest for a browser, but URLs are logged and kept in history.
- **Terminating TLS inside `geode-wiki`.** Would need certificate provisioning and renewal; a tailnet proxy already
  does this and keeps the hub off the public internet.

## Consequences

- A phone (and any desktop) can sync with a hub that needs only `geode-wiki` and a TLS front, with no ssh setup and
  no change to the store format; hubs stay interchangeable between folder, ssh and HTTPS clients.
- The operator owns three things the ssh transport got from ssh: TLS (a proxy), the secret (one token per hub; revoke
  by replacing the file and restarting; no per-device tokens), and reachability (a tailnet or firewall).
- The token grants full access to the store: a holder can read it and publish records. The first-run approval rail is
  per device state and is not bypassed by the token.
- A bad token and an unreachable hub look the same to a browser (the refusal happens before the upgrade); messages
  name both causes.
- The server does **not** check `Origin`. This is accepted for now (the token is the control and the listener is on
  loopback behind the proxy); an allow-list is a possible hardening.
- Binding a non-loopback address without a TLS proxy sends the token and vault data in clear; the CLI only warns.
- The CLI's `sync init` still has no HTTPS target; only the apps do.
- Files between 32 and 100 MiB are blocked on iOS. Not verified on a device: applying such a file arriving from the
  hub, a real tailnet with `tailscale serve`, and background/suspended-app reconnection.
- The framing and error vocabulary moved to `src/shared/` (`store-framing`, `store-errors`, `store-protocol`) so the
  stdio server, WebSocket server and browser client share one definition.

Reference: [headless-wiki-sync.md](../design/headless-wiki-sync.md#https-hub-geode-wiki-sync-serve---http),
[app-hub-sync-provider.md](../design/app-hub-sync-provider.md#https-hub-desktop-and-ios).
