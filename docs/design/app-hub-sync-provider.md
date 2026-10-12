# App hub sync provider ("Folder or SSH hub")

The desktop app can sync to the same hub store the headless `geode-wiki sync` CLI uses: a
directory store (`FsStoreProvider`) or an ssh-reachable one (`geode-wiki sync serve --store` over
`ssh`, `RpcStoreProvider`). CLI reference: [headless-wiki-sync.md](headless-wiki-sync.md),
[ADR 0025](../adr/0025-geode-wiki-sync-cli.md). This page records how the app side is built and
what it does and does not share with the CLI.

## Decision: engine stays in the renderer, only the *store* crosses the process boundary

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

`target` is `{kind:"fs", path}` or `{kind:"ssh", host, path}`; validated in main (absolute path, no NUL,
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

## Risks

* Renderer-chosen filesystem path: any renderer code (including a community plugin with preload
  access) can ask main to create/read a hub store under a path it names. Same exposure class as the
  existing `write`/`createVault` IPC; main validates shape only.
* A hub shared by the app and the CLI on one machine/folder is two devices fighting over the same files;
  documented, not prevented.
* The iCloud rail is coarser in the app (whole run) than in the CLI (one path).
* `geode-wiki` must be on the hub's non-login PATH for ssh.
* Large blobs (<= 100 MiB) cross IPC as ArrayBuffers: peak memory is one blob per in-flight upload
  (concurrency 4).

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
