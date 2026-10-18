# ADR-0029: iCloud Drive Sync Provider (Plugin)

**Date:** 2026-10-05
**Status:** Superseded by [ADR-0030](0030-core-icloud-sync-native-bridge.md). The community plugin described here was never released and was removed; its provider semantics (path ids, `mtime:size:sha256` revisions, `.geode-sync/marker.json`, ops index, `.geode-trash/`, placeholder and conflict-copy handling) live on unchanged in the core iCloud sync plugin, now over Geode's own iCloud container instead of `com~apple~CloudDocs/Geode`. Live multi-device behavior remains unverified.

## Context

[ADR-0015](0015-plugin-provided-vault-sync.md) made sync a host-orchestrated engine with plugin-provided transports. A user on several Apple devices wants vault sync without OAuth or a vendor API. iCloud Drive already syncs a folder across devices, so the transport can be a filesystem folder.

## Decision

Ship a separate plugin, `packages/geode-icloud-sync`, not core code. It registers `{ id: "icloud", protocol: "conditional-mutation-v1" }` with `binary`, `conditionalWrites`, `completeSnapshots`, `atomicMoves` and `trash` true and `delta` false. The remote root is `~/Library/Mobile Documents/com~apple~CloudDocs/Geode/<remote folder name>`. macOS only; Geode's host engine is unchanged.

Key choices:

- **Remote folder is a user choice, not path-derived.** The first version derived the folder from the local vault path, so a second Mac with a different path never reached the same remote (found in a live test). A settings tab now sets a per-vault "Remote folder name" (default: the vault folder's basename) and lists existing marker-bearing folders to pick. `open()` resolves: chosen name, else the old path-derived name only if that folder already exists (back-compat), else the default. Changing it while the provider is active is refused (disconnect first, per ADR-0015); binding a non-empty folder without `.geode-sync/marker.json` is refused. Names are NFC-normalised with separators, control characters and leading dots removed; derived defaults get a hash suffix when altered so they stay collision-safe, while user-typed names intentionally collide (that is how two devices share one).

- **Revision** = `mtime:size:sha256`. Write-side checks re-hash from disk and compare immediately before temp-file write + atomic rename. Mismatch throws `SyncPreconditionError`.
- **Create idempotency** via a durable op record under `.geode-sync/ops/` (written pending, committed after the file lands); creates publish with a hard link so they never overwrite.
- **Eviction**: `.name.icloud` placeholders trigger `brctl download` and bounded polling; any placeholder left makes the scan `partial`, so the cursor never advances and nothing is inferred deleted.
- **Conflict copies** (`name 2.ext` beside `name.ext`) are withheld and force `partial`. Silently importing them as new files would duplicate or clobber user data; blocking is conservative and recoverable by renaming/deleting the copy. Geode-created paths are exempt via the op index.
- **Trash** moves into `.geode-trash/` in the remote root (recoverable, excluded from scans). `.geode-sync/marker.json` guards against treating a half-arrived folder as an authoritative snapshot.
- **Ids are path-based**: APFS inodes change on atomic replace, so a remote rename appears to the host as delete+create (recoverable through trash).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Filesystem provider in a plugin (chosen) | No auth/network; isolated from core; reuses the existing contract | Correctness bounded by iCloud's own semantics; macOS only |
| Core-integrated iCloud sync | Could use native APIs (NSFileCoordinator) | Couples core to an Apple service; needs native code |
| Append-only-history provider ([ADR-0016](0016-causal-append-only-vault-history.md)) | No mutable-write race | Heavier; storage grows; unnecessary when atomic rename exists locally |

## Consequences and limits

- The check-to-rename window is not atomic, and iCloud itself can apply a remote change in it. ADR-0015 already accepts this race for local files; the same beta caution (disposable vault copies) applies, and this provider must not be combined with another filesystem sync engine on the same folder.
- A hand-made `Foo 2.md` beside `Foo.md` on another device blocks sync until renamed.
- Whole-file hashing costs reads on scan (mitigated by an in-session cache).
- Op index and trash are never garbage-collected.
- **Not verified**: real iCloud propagation, eviction/download timing with `brctl`, conflict-copy naming on current macOS, or two-device races. Unit tests use a temp directory with simulated placeholders; a live two-Mac soak is a release gate before this is recommended.
