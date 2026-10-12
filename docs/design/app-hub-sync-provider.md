# App hub sync provider ("Folder, SSH or HTTPS hub")

The app can sync to the same hub store the headless `geode-wiki sync` CLI uses: a directory store
(`FsStoreProvider`), an ssh-reachable one (`geode-wiki sync serve --store` over `ssh`,
`RpcStoreProvider`), or, on desktop and on iOS, an HTTPS one (`geode-wiki sync serve --http` behind TLS, over
a WebSocket; see "HTTPS hub" below). CLI reference: [headless-wiki-sync.md](headless-wiki-sync.md),
[ADR 0025](../adr/0025-geode-wiki-sync-cli.md). This page records how the app side is built and
what it does and does not share with the CLI.

## Decision: engine stays in the renderer, only the *store* crosses the process boundary

(Folder and ssh targets. The HTTPS target does not cross the process boundary at all; see "HTTPS hub".)

The app already runs `HistoryController` in the renderer (`SyncService`), scanning and applying through
guarded main-process IPC. A hub store is just an `AppendOnlySession` (`scan`, `putBlob`, `readBlob`,
`appendRecord(s)`). Only that needs Node (fs, `child_process`), so:

```
renderer                                   main (Node)
SyncService -> HistoryController
   HubSyncProvider  --- IPC "hub-sync" --->  HubStoreManager  -> FsStoreProvider | spawnSshStore
   (AppendOnlySyncProvider, id geode.hub)    (src/sync-node/app-hub.ts)
```

Rejected: running the whole CLI workflow (`wiki-sync.ts`, `NodeHost`) in main for the app. It would
replace the app's scan, apply, editor-guard, conflict UI and portable-config projection with the
headless ones (a second engine in the product) and forfeit the existing Sync settings tab. Also
rejected: shelling out to the `geode-wiki` binary (not shipped with the app).

* `src/sync-node/app-hub.ts` is the only new Node module. It is **not** exported from
  `src/sync-node/index.ts`, so the CLI bundle never contains it (`scripts/cli-import-audit.mjs` is
  unchanged and still passes). It imports only `sync-node`/`sync-core`/`shared`.
* `src/main/hub-sync-ipc.ts` registers the IPC handlers and owns session lifetime (closed when the
  window's webContents is destroyed).
* The renderer bundle imports only `src/sync-core/*` (platform neutral) and the IPC contract types;
  esbuild's renderer build would fail on any `node:` import, and `tests/unit/sync-core-boundary.test.ts`
  keeps `sync-core` Node-free.

## IPC surface

One `ipcMain.handle("hub-sync", (e, req))` with a discriminated request, plus `hub-sync-abort`:

| `method` | Args | Result |
|---|---|---|
| `discover` | `target` | `VaultDescriptor[]` |
| `createVault` | `target`, `{name, operationId}` | `VaultDescriptor` |
| `open` | `target`, `binding`, `deviceId` | `{sessionId, uploadConcurrency, readConcurrency, commitVerified, appendRecords}` |
| `scan` `putBlob` `readBlob` `appendRecord` `appendRecords` | `sessionId`, as the session API | as the session API |
| `close` | `sessionId` | void |

`target` is `{kind:"fs", path}` or `{kind:"ssh", host, path}` (the type `MainHubTarget`; the `http` target kind is never sent over IPC); validated in main (absolute path, no NUL,
host matches the existing `SAFE_HOST` rule). A renderer abort sends `hub-sync-abort(requestId)`.
Errors are returned as a `{error:{code, message, hint}}` envelope (Electron drops custom fields on
thrown errors) and rethrown renderer-side as `HubSyncError`.

## Config and device identity

* Provider config (target, `create` flag) is per vault, stored in `host.deviceState` under
  `sync-hub/config/<vault root>`. That is the app's userData (outside the vault), the same place the
  engine keeps its binding and controller state. It is never written into the vault.
* Device id and engine state are the existing `SyncService` binding (`sync-history-binding/<root>`,
  `sync-history/<root>/<bindingKey>`). The CLI keeps its own (`~/.geode/sync/root-<hash>`). The app and
  the CLI are therefore two *devices* with distinct device ids; do not bind the same folder with both.

## ssh

* `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 <host>
  geode-wiki sync serve --store '<path>'`. `~/.ssh/config` aliases, `IdentityFile`, `ProxyJump` apply
  because it is the system `ssh`. BatchMode means no prompt can ever hang the app.
* stderr is captured (last lines) and turned into a status message: `Permission denied` ->
  "ssh authentication failed (is the key loaded / the agent unlocked?)", `Could not resolve hostname`,
  `Connection refused|timed out`, `geode-wiki: command not found` -> "geode-wiki is not on the hub's
  non-login PATH". Connection-establishing calls (`discover`, `createVault`, `open`) also carry a 30 s
  deadline so a wedged ssh becomes an error, not a hang.
* Electron started from the Dock has no `SSH_AUTH_SOCK`; keys must be usable without an agent (the same
  limitation as the launchd schedule in the CLI doc). Surfaced as the authentication message above.

## Hostile input, deadlines, Test connection (QA follow-up)

* **The ssh host is user-controlled.** `hubTargetProblem` (`src/shared/hub-sync.ts`, shared by the form, the
  provider and main, and by `spawnSshStore` so the CLI gets it too) accepts only a host name, IPv4 address or
  `~/.ssh/config` alias, optionally `user@`: it must start alphanumeric, no whitespace/control characters,
  quotes, `;`, `$`, backticks, `:`, `/`, brackets. ssh is always spawned from an argv array (never a shell) with
  `--` before the host. The store path is single-quoted with the existing `shellQuote`; control characters
  (newline, NUL) and `..` segments are refused. The form refuses bad values with a message and saves nothing;
  main re-validates every request. Tests assert ssh is never spawned for hostile hosts.
* **No operation can wedge the UI.** Every connecting call races a deadline (30 s ssh, 15 s folder) against the
  store call itself, so a store that never settles (and ignores its abort signal) still rejects with a
  "Timed out accessing the hub folder <typed path>" error and releases the provider. Creating a vault first runs
  a read-only pre-check (`inspectFsHub`) that walks up to the nearest existing ancestor, so an impossible path
  (a file in the way, an unwritable or non-existent root) fails at once with a message that names the path the
  user typed. errno messages never leak internal `blobs/`/`records/` paths.
* **Test connection** is a `probe` request: for a folder it reports reachable vaults plus, with "Create the hub if
  it is missing" on (or the folder missing), whether the hub can be created/written (access checks on the nearest
  existing ancestor; nothing is created). For an existing hub with Create off it says it checked read access only.
  Over ssh it can only list vaults; creatability is known when you create.
* **Settings save themselves** (debounced 300 ms) and "Create shared vault" / "Find shared vaults" / "Test
  connection" flush a pending save first, so a ticked box is never ignored for want of a Save click.

## Safety rails

Rails live in `src/sync-core/rails.ts` (pure; the CLI's `wiki-sync.ts` now imports the same constants
and functions, so there is one definition of the limits). The provider opts in with
`safetyRails: true`; plugin providers are unchanged.

| Rail | App behaviour |
|---|---|
| (a) first run needs approval | The existing controller approval. For this provider the Sync tab replaces the generic "Approve & sync" with an explicit confirm row showing the plan counts ("N uploads, M downloads, K deletions"); the scheduled/auto path never approves, and a status of `preview` is never auto-run. |
| (b) deletion cap `max(20, 1% of files found)` | Evaluated in `SyncService.run` after a fresh preview and before apply; refusal is an error status naming the counts, and the tab offers "Allow N deletions once". Auto runs never override. |
| (c) shrunk scan (found < 50% of known) | Wraps the snapshot port; fires in preview and run. Tab offers "Sync despite shrunk scan (once)". |
| (d) iCloud placeholders | The strict sync scan (`listVaultFiles`, `strictSync`, new `vault-sync-scan-blocked` IPC) reports a `.name.icloud` stub with no real sibling as a *blocked* path (`icloud-not-downloaded`): untouchable, never read as deleted, never hydrated. Same per-path behaviour as the CLI. Unlike the CLI the app does not detect evicted-but-named files by `blocks === 0` (APFS-compressed files look the same, and a false positive would stall every sync); only stubs are caught. Applies to every append-only provider. Without a collector the scan fails closed. |

Overrides are one-shot, held in memory, cleared after the next controller attempt, and cannot be set by
the 30 s poll.

## Format compatibility with the CLI

The app also publishes its own projected settings documents (`editor.json`, `appearance.json`, `hotkeys.json`, `daily-notes.json`, namespace `portable-config`) on its first sync; the CLI ignores them. Content records are never republished by a join (asserted in the convergence test).

Hub **content** is identical: same `descriptor.json`, `records/`, `blobs/`, the same `HistoryRecord`s and
vault descriptor discovery. A store created by either side is discoverable and joinable by the other
(`discover` returns the descriptor; `joinVault` binds). Device state and binding keys are device-local
and do not appear in the store, so nothing needs migrating and nothing is re-uploaded by changing
hosts: a joining device downloads, and content with identical hashes on both sides converges without
conflict.

**Config does not unify, and cannot without a larger change.** The CLI scope sets `rawConfig` (byte-for-byte
`.geode/` and `.obsidian/` files, including community plugin code, as `raw.geode/*`, `raw.obsidian/*`
resources). The desktop deliberately does not:

* its configuration is a running app's *projected documents* (`editor.json`, ... through
  `portable-config.ts` and `host.config`), applied by reloading app state, not by writing files under a
  watcher; and
* `SyncService.updateScope` refuses community plugin config for append-only sync on purpose (code
  execution trust; ADR 0016).

Consequently the app ignores `raw.*` resources and the CLI does not exchange projected documents. Two
app devices converge on settings; two CLI devices converge on config files; app and CLI converge on all
content files (notes, attachments, themes/snippets assets are the exception: they are the same resource
names on both sides and do converge). A migration would mean teaching the app to ingest/emit `raw.*`
(a scope flag plus a main-process apply path for config files) and a decision on plugin code. That is
out of scope here.

## HTTPS hub (desktop and iOS)

A phone has no Node, no `child_process` and no main process, so folder and ssh hubs cannot exist there
([ADR 0007](../adr/0007-mobile-runtime-and-platform-boundary.md): no Node/Electron on iOS). The HTTPS target
is the one hub kind the renderer can reach by itself, which is also why it is the only kind offered on a phone
(`HubSyncProvider.supportedKinds` is `["http"]` when the host supplies no `hubSync` bridge). Why this transport and not
the alternatives: [ADR 0029](../adr/0029-https-websocket-hub-transport.md).

```
renderer (desktop window or iOS web view)               hub machine
SyncService -> HistoryController
   HubSyncProvider -> HttpStoreProvider  --- wss:// --->  TLS proxy (tailscale serve) --- ws://127.0.0.1:8787 --->
   (src/renderer/sync/http-store.ts)                      geode-wiki sync serve --http  -> serveStore -> directory store
```

* **Target.** `{kind:"http", url}`. The URL must be `https:` or `wss:` (`hubUrlProblem`, `src/shared/hub-sync.ts`):
  printable ASCII only (an international domain is entered as punycode), no embedded user name/password, no
  backslash, a real host. A path or query is allowed (a reverse-proxy prefix); the fragment is dropped
  (`canonicalHubUrl`). `https://` is dialled as `wss://`. `ws://` and `http://` are refused by the product; only a
  test seam (`allowInsecure`) permits them. The settings form and the provider share this check; nothing is saved
  on a bad URL.
* **The session lives in the renderer.** `HttpStoreProvider` / `HttpStoreSession` mirror the ssh client
  (`RpcClient`/`RpcStoreSession`) one for one: lazy connect, hello first, reconnect with hello + open replay,
  pipelined requests, 4 MiB chunking, the same named errors (`src/shared/store-errors.ts`) and the same framing
  (`src/shared/store-framing.ts`, `store-protocol.ts`), so the history engine cannot tell the transports apart. It
  is browser-safe on purpose: no `node:` imports, no `Buffer`, `crypto.subtle` for sha256, the platform
  `WebSocket`. There is no main-process bridge and no IPC for this target, and no connection stays open while
  sync is idle: the provider opens a client per operation or per opened session and closes it with it. A connect
  deadline of 15 s applies.
* **Config and identity** are the same as for the other targets (`host.deviceState`, `sync-hub/config/<vault
  root>`); the config holds the URL and the create flag, never the token.

### Token storage

The token is a shared secret and is stored only in the host's secure storage, `host.secrets.app`:

* Electron: `safeStorage`-encrypted, through three IPC handlers (`app-secret-read|write|remove`, preload
  `readAppSecret`/`writeAppSecret`/`removeAppSecret`). They use a namespace, `@geode`, that starts with a character
  no plugin id can start with, so a plugin capability can never address it; keys are limited to
  `[A-Za-z0-9._:/-]{1,300}` and values to 8192 characters.
* iOS: the Keychain, through `appSecretGet|Set|Remove` on the native managed-vault plugin
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, Geode's own service namespace), so it does not migrate to
  another device through a backup.
* The key is `hub-token/<host:port>` (`hubTokenKey`): a token is only ever read for the host it was entered for.
* **No fallback.** If the host has no secure storage (`canStoreToken` false) the provider refuses to take a token
  (`secure-storage-unavailable`) rather than keep it in device state, web storage or the vault, and the settings
  field is disabled with an explanation. The token is never put in the vault, so it is not synced.

### WebSocket authentication

A browser `WebSocket` (WKWebView included) cannot set an `Authorization` header, and a token in the URL would be
written to proxy and access logs and to history. So the client offers two sub-protocols in
`Sec-WebSocket-Protocol`: the real one, `geode-store.v1`, and `bearer.<base64url(utf8 token)>`. The server
(`src/sync-node/http-serve.ts`):

* authenticates **before** the upgrade, comparing SHA-256 digests with `timingSafeEqual`; a missing or wrong token
  is a body-less `401` with `WWW-Authenticate: Bearer` and nothing else about the server is revealed (a plain
  HTTP request gets a body-less `426`);
* also accepts `Authorization: Bearer <token>` (the CLI and Node clients); it never accepts the token from the URL;
* never echoes the token entry back: the `101` response names only `geode-store.v1`;
* requires the token to be at least 24 characters, and `GET`, `Upgrade: websocket`, version 13, and either no
  named sub-protocol or `geode-store.v1`; `503` with `Retry-After` past 8 simultaneous connections.

Because the refusal happens before the upgrade, a browser reports a bad token only as a failed connection. The
client therefore cannot tell "wrong token" from "unreachable": both surface as `unavailable`, with a message that
names both causes.

### Frames: binary only

One connection is one `serveStore` session speaking the unchanged JSON-lines + binary framing; the WebSocket is a
byte pipe and message boundaries carry no meaning (the framing parser reassembles). The server sends only binary
frames and rejects text frames (close `1003`), unmasked client frames, reserved bits, unknown opcodes and bad
fragmentation (`1002`), and any frame whose declared length exceeds `MAX_HEADER_BYTES + MAX_FRAME_BYTES` (`1009`,
before reading the payload). Ping every 25 s; a peer that does not answer is dropped. Minimal RFC 6455 is
implemented in-repo (no dependency); no extensions.

### Origin is not checked

The server does not look at the `Origin` header. Defence rests on the token (a page on another origin has no token
to offer) and on binding to loopback behind a TLS proxy that is reachable only over the tailnet. An `Origin`
allow-list would be defence in depth against a token leaked into a hostile page; it is not implemented.

### Mobile support

The history engine needs a guarded way to write into the vault and a place to keep frozen bytes and operation
journals, both of which are Node modules on desktop (`sync-apply.ts`, `sync-private-storage.ts`). On iOS they are
ported, not shared:

* `src/renderer/host/mobile-sync-safety.ts` builds `host.syncSafety` from a small set of native ports
  (`MobileSyncPorts`: `stat`, `readBinary`, `writeBinary`, `mkdir`, `trash`, app-sandbox private storage). It is
  the same hash guard, intent receipts, preimage recovery and crash-safe retry, and the same storage vocabulary, as
  the desktop. Sync-private bytes live in the app sandbox (Application Support, excluded from backup), never in
  the vault tree, so they are never scanned or uploaded.
* `capacitor-host.ts` supplies `host.syncSafety` only when the native plugin has the primitives; an older native
  build has none and history sync stays refused. The native methods added are `stat` (never follows links: a link on
  the path reports `symlink`), `syncPrivateWrite|Read|List|Remove|AvailableBytes`, `appSecretGet|Set|Remove`, and a
  `writeBinary` that stages in the target's directory and swaps atomically with rollback.
* Differences forced by the platform: one web view owns the vault, so the owner lease is an in-memory token scoped
  to the open vault; deletions go through the vault's own trash; and the window between the final hash re-check and
  the native write cannot be closed from JavaScript. The check is repeated immediately before the mutation, as on
  desktop, but a file edited by another process (the Files app, a provider) inside that window can still be
  overwritten. This is a limitation of the platform, not something the port can close.
* **Blocked paths.** The mobile scan reports a `.name.icloud` stub with no real sibling as blocked
  (`icloud-not-downloaded`, `splitICloudPlaceholders`) at the real file's path: untouchable, never read as deleted,
  never downloaded by Geode. A read the provider fails with `CONTENT_UNAVAILABLE` is also demoted to that path being
  blocked, not an error that fails the run. These are stubs and read failures only; the mobile host does not
  detect evicted-but-named files.
* **Local caches never sync.** `.geode/metadata-cache/` and atomic-write temp files in a config root are excluded
  by `isLocalOnlyConfigPath` (src/sync-core/scope.ts) at every choke point (desktop, mobile, headless scan; app and
  raw-file scopes), regardless of user scope. Copies already on the hub are skipped by the planner, not downloaded,
  deleted or counted by the rails.
* **32 MiB bridge limit.** Binary data crosses the Capacitor bridge as base64, and the native plugin rejects a
  payload over 32 MiB (`PAYLOAD_TOO_LARGE`; the sync-private store has the same cap). The provider advertises
  100 MiB, so on iOS a local file between 32 and 100 MiB is shown as blocked (`too-large-for-mobile`) and is neither
  uploaded nor treated as deleted. The same native cap applies to `writeBinary`, so a remote file of that size cannot
  be written into the phone's vault; that path was not exercised on a device.
* Rails (deletion cap, shrunk-scan guard, first-run approval) are evaluated by `SyncService` exactly as on desktop.
  The phone settings rows are laid out one full-width, touch-sized field per row.

### Running the hub

`geode-wiki sync serve --http` and the TLS front are described in
[headless-wiki-sync.md](headless-wiki-sync.md#https-hub-geode-wiki-sync-serve---http).

### HTTPS risks

* **The token is a bearer secret for the whole store.** Anyone holding it can read, add and (through the append-only
  protocol) publish deletions for every vault in that store. There is one token per hub, no per-device revocation
  other than rotating it, and no rate limiting beyond the connection cap. Treat it like an ssh key.
* **TLS is the proxy's job.** The server itself speaks plain `ws://`. `serve --http` warns when it is bound to a
  non-loopback address, but cannot tell whether a TLS proxy is in front. Binding a public address without one
  sends the token and vault data in the clear.
* **Origin is not checked** (above).
* **Failed auth is indistinguishable from unreachable** on a browser/WKWebView client (above).
* **Mobile apply window and 32 MiB limit** (above).
* **Not covered by automated tests:** a real tailnet with `tailscale serve`, a physical iPhone against a remote
  hub, App Transport Security behaviour against a real certificate, and background/suspended-app reconnects. The
  server, client, convergence (a desktop-style device and the mobile host through one hub), mobile safety port and
  a phone Playwright spec are covered in `tests/unit/sync-http-serve.test.ts`, `sync-http-store.test.ts`,
  `hub-http-provider.test.ts`, `mobile-hub-convergence.test.ts`, `tests/unit/host/mobile-sync-safety.test.ts`
  and `tests/mobile/hub-sync.spec.ts`; the native Swift stores have XCUITests and a simulator proof.

## Risks

* Renderer-chosen filesystem path: any renderer code (including a community plugin with preload
  access) can ask main to create/read a hub store under a path it names. Same exposure class as the
  existing `write`/`createVault` IPC; main validates shape only.
* A hub shared by the app and the CLI on one machine/folder is two devices fighting over the same files;
  documented, not prevented.
* The iCloud rail is coarser in the app (whole run) than in the CLI (one path).
* `geode-wiki` must be on the hub's non-login PATH for ssh.
* Large blobs (<= 100 MiB) cross IPC as ArrayBuffers on folder/ssh targets: peak memory is one blob per
  in-flight upload (concurrency 4). The HTTPS target does not use IPC; it sends 4 MiB frames from the renderer.

## Test plan

Unit (vitest, no Electron): `sync-rails` (limits, shrunk-scan, known count), `app-hub` (target
validation, discover/create/open/scan/put/append over a temp directory store, error classification of ssh
stderr, abort, session close), `hub-sync-provider` (IPC envelope round trip, config load), the SyncService
rail wiring, `vault-sync-scan` (iCloud stub refused). **Convergence**: the real `SyncService`
+ `HubSyncProvider` (store access in-process through `HubStoreManager`, device = a temp vault with a
fake host over real fs) and the CLI engine (`syncInit/syncRun`) against one temp directory hub:
upload both ways, a concurrent edit (conflict surfaced, resolved), a delete both ways, no re-upload.
E2E (Playwright, `GEODE_HEADLESS=1`): two app instances with separate vaults and profiles, provider
configured to one temp directory hub through the real Settings tab, first-sync confirm, files appear in
the other vault.

Not covered by automated tests: real ssh (a stand-in ssh script is used for the stderr classification
and a full session through `ssh` to a local `geode-wiki serve`), real iCloud, a physical second machine.
