# Geode iCloud Drive Sync (plugin)

A Geode sync provider plugin (`conditional-mutation-v1`, see [`docs/plugin-sync-api.md`](../../docs/plugin-sync-api.md)) whose "remote" is a folder in iCloud Drive:

```
~/Library/Mobile Documents/com~apple~CloudDocs/Geode/<remote folder name>/
```

The folder name is **your choice per vault** (Settings → iCloud Drive), not derived from the local path, so a second Mac with a different vault location can bind to the same remote.

macOS/iCloud moves bytes between your devices. This plugin only exposes that folder to Geode's host-owned sync engine (preview/approval, baselines, journal, conflict siblings). It is **macOS desktop only** and has no OAuth, network access, or secrets. It lives outside core: nothing in `src/` depends on it.

## Build and install

```bash
node packages/geode-icloud-sync/build.mjs      # -> packages/geode-icloud-sync/dist/{main.js,manifest.json}
```

Copy `dist/main.js` and `dist/manifest.json` to `<vault>/.geode/plugins/geode-icloud-sync/` and add `"geode-icloud-sync"` to `<vault>/.geode/plugins.json`, then choose **iCloud Drive** under Settings → Sync and preview/approve as usual. (The Google Docs provider is packaged the same way, as a standalone plugin directory with `manifest.json` + `main.js`.) On other platforms the plugin loads but registers nothing.

## Choosing the remote folder

Settings → **iCloud Drive** has:

- **Remote folder name**: text field plus Apply. Defaults to the vault folder's basename (sanitised; if sanitising changes it, a short hash is appended so distinct vaults never collide). Names you type are NFC-normalised, path separators/colons/control characters become `_`, leading dots are stripped, and length is capped at 80. Typing the same name on two Macs binds both to the same remote.
- **Use an existing remote folder**: dropdown of folders under `iCloud Drive/Geode/` that contain `.geode-sync/marker.json`, for picking what another Mac created.

The choice is stored per vault (keyed by the vault path) in the plugin's `data.json`. At `open()` the folder is resolved as: chosen folder, else the old path-derived name **only if that folder already exists** (back-compat with folders created before this setting), else the basename default.

Guard rails:
- Changing the folder while iCloud is the active sync provider is refused; Disconnect in Settings → Sync first (ADR-0015).
- A non-empty folder without the marker is refused in settings and, if bound anyway, scans return `partial` (`icloud-marker-missing`); the provider never writes a marker into someone else's folder.
- A new/empty folder is initialised with the marker on first sync.

## How it satisfies the contract

| Contract point | Behavior |
|---|---|
| Entries | `id` is `p:<NFC path>` (path-based; a move returns the new id). Folders are listed with revision `folder`. |
| Revision | `<mtime ms>:<size>:<sha256 hex>`, opaque to Geode. Hashes are cached per session by dev/inode/mtime/ctime/size; checks before a write always re-read the bytes. |
| Conditional writes | `update`/`move`/`trash` re-derive the revision from disk and throw `SyncPreconditionError` on mismatch. `update` writes a temp file in the same folder, fsyncs, re-verifies, then renames over the target. |
| Idempotent create | A record under `.geode-sync/ops/<sha256(operationKey)>.json` is written before the file and marked committed after. A replay returns the existing entry; a committed create whose file is gone fails rather than resurrecting it. Create publishes with a hard link so it can never overwrite. |
| Snapshots | `delta: false`; every scan is a complete `snapshot` or fails closed. |
| Trash | Moves into `.geode-trash/<timestamp>-<id>/<original path>`; non-empty folders are refused. |
| Excluded | `.geode-trash`, `.geode-sync`, `.geode-tmp-*`, `.DS_Store`, `._*`, `.Trash`, `.localized`, Spotlight/fseventsd/etc. |
| Size | `maxFileSize` defaults to 100 MiB: bigger files are listed with size (never hashed or read) and writes are rejected. |
| Abort | Every path honors its `AbortSignal`; `close()` aborts in-flight work and rejects later calls. |

## Fail-closed scans

- **iCloud Drive missing** (not signed in / not macOS): `unavailable`.
- **Evicted files** (`.name.icloud` placeholders): the scan runs `brctl download` for each, waits up to 15 s, and re-walks. Anything still evicted yields `partial` (`icloud-placeholders-unresolved`): no cursor, and the evicted file is neither listed nor implied deleted. Reads/writes of an evicted file ask for a download and throw rather than treating it as missing.
- **Missing marker**: a folder that has content but no `.geode-sync/marker.json` is presumed to still be arriving from iCloud: `partial` (`icloud-marker-missing`).
- **Unreadable/vanishing entries and symlinks**: `partial`.

## Conflict copies

When two devices edit a file offline, iCloud keeps one and writes the other as `name 2.ext`. A file shaped like `<base> <n>.<ext>` whose `<base>.<ext>` sibling exists is **withheld** from the scan and the scan returns `partial` (`icloud-conflict-copies`) until the user resolves it (merge, rename, or delete the copy). Geode will not push or pull around an unresolved iCloud conflict. The original stays listed. A numbered name with no matching original, or one this provider itself created (recorded in the op index), is ordinary. Details are logged to the console via `onDiagnostics`.

Cost of this conservatism: a legitimate `Chapter 2.md` made by hand beside `Chapter.md` on another device blocks sync until renamed.

## Known limits

- **Residual race**: the final check-to-rename window is not atomic; another process (including iCloud applying a remote change) can write in it. This is the same race ADR 0015 already accepts for local files. Do not run it against a vault you cannot afford to lose; use a disposable copy first.
- Cross-device behavior depends entirely on iCloud's propagation and eviction timing, which this plugin cannot observe or control. Syncs between devices are eventually consistent; expect `partial` scans while files are still arriving.
- Path-based ids mean a remote rename looks like delete+create to the host (recoverable via trash).
- The op index and trash are never garbage-collected.
- No Windows/Linux, no iOS (the Capacitor build cannot reach this folder this way).

Design record: [ADR 0029](../../docs/adr/0029-icloud-drive-sync-provider-plugin.md). Tests: `npx vitest run tests/unit/icloud-sync-provider.test.ts tests/unit/icloud-sync-plugin.test.ts`.
