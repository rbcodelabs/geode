# Hub chunked blob storage (append-aware at rest)

Status: implemented for the hub store (`FsStoreSession`); client-side append-aware upload is designed here but **not** implemented.

## Problem (measured)

On a production hub (`claude-box`), 36 GB of blobs, 94% under `Claude/logs`. History is append-only and every version of a file is a whole
content-addressed blob (`HistoryRecord.blob: BlobRef {id, sha256, size}`, `id === sha256` of the whole file, `FsBlobWriter.commit`). A session log
that grows by a few KB per edit is therefore stored in full per version: `e44f5eb7…jsonl` is 463 versions of a 30.7 MB file = 7.9 GB. 6,671 log
blobs = 34 GB; all were uploaded by one desktop device, median gap 14-24 s. Only 9.5 GB of the 36 GB is referenced by current records.

`capabilities.delta: true` (`AppendOnlySyncProvider.capabilities`, `FsStoreProvider`) is **not** a blob-delta hook: it declares the scan/tombstone mode
(`SyncProviderCapabilities.delta`, `types.ts`: "A delta can delete only through explicit tombstones"), and `SyncService` hard-requires the exact
literal capability set (`sync-service.ts`, `!c.binary || c.conditionalWrites || !c.appendOnly || !c.delta || c.maxFileSize !== SYNC_MAX_FILE_BYTES`).
It cannot carry a new storage mode without breaking every existing client, so this design does not touch it.

## Design: fixed-size chunks at rest, transparent to the protocol

Blobs of at least `AT_REST_MIN_BYTES` (2 MiB) are stored as `AT_REST_CHUNK_BYTES` (1 MiB) chunks in a content-addressed pool (`chunks/<xx>/<sha256>`)
plus a manifest (`blobs/<id>.manifest`, `{v,size,chunk,chunks[]}`). **Fixed, offset-aligned chunks are the right fit for append-only files**: every full
chunk of version N is byte-identical in N+1, so only the changed tail chunk is new storage. (Content-defined chunking would be needed for inserts in
the middle of a file; Markdown notes are small and logs only append, so it is not worth the complexity.)

What does **not** change: `BlobRef`, the record schema (`isHistoryRecord`'s `onlyKeys(value.blob, ['id','sha256','size'])` in `history-reducer.ts`),
`AppendOnlySession` (`putBlob`/`readBlob`), the RPC/WebSocket frames (`serve.ts`: `putBlobStart/Chunk/Commit`, `readBlobRange`), blob verification in the
engine (`HistoryController.verified`, `readBlob` re-hash), and `blobAvailability`. Chunking is entirely inside `FsStoreSession`/`FsBlobWriter`.

### Hub (implemented, `src/sync-node/fs-store.ts`)
- `FsBlobWriter.begin` / `blobPresent`: a blob is "existing" if the whole file **or** a complete manifest is present (a manifest with a missing chunk is removed and re-stored).
- `FsBlobWriter.commit`: after the usual size + sha256 verification of the temp file, `storeChunksFrom` splits it into chunks (skipping chunks already in the pool, `linkNew` for exclusive durable creation), the manifest is linked **after** every chunk is durable, then the temp file is removed. Crash order: orphan chunks possible, a visible half-blob never.
- `FsStoreSession.readBlobRange` / `readChunkedRange` / `blobSize`: whole file first, else manifest. `readBlob`, `serve.ts` `readBlobRange` and `appendRecord`'s "referenced blob exists with the declared size" check work unchanged on top of these.
- `FsStoreSession.chunkLegacyBlob(id)`: converts one whole-file blob in place (verify sha256 → store chunks → link manifest → unlink whole file). Online-safe because readers fall back from whole file to manifest.
- `sweepOrphanChunks(store, {apply})`: deletes unreferenced chunks older than 1 h; refuses if any manifest is unreadable.
- `GEODE_HUB_CHUNKED=0` stops new blobs being chunked (reads of manifests still work): a rollback lever.

### Client engine (not implemented; phase 2)
At-rest chunking saves hub disk but each sync still uploads the whole file (a 30 MB log = 30 MB over the wire). To make uploads append-aware:
1. Negotiate: add a `putBlobChunks` flag to `ServerFeatures` (`parseFeatures` in `rpc-store.ts` / `http-store.ts`, advertised in the `hello` reply of `serve.ts`; `LEGACY_FEATURES` when absent, exactly how `putBlob` / `appendRecords` were added).
2. New RPCs: `haveChunks {sha256[]} -> missing[]` and `putBlobFromChunks {sha256,size,chunks[]}` which the hub validates (all chunks present, concatenated hash equals `sha256`) before linking the manifest.
3. `HistoryController` upload step (`session.putBlob` call sites around the `payload`/`stage` path) asks the session, via an optional `AppendOnlySession.putBlobChunked?` hook (like `appendRecords?`), and falls back to `putBlob` when absent.
4. Needs the client to hash chunks (it already hashes the whole file once per scan).
Not done here because it needs a protocol feature, an engine change in `HistoryController`, and a coordinated desktop-app release; the at-rest change delivers the disk win by itself and is deployable on the hub alone.

## Backward compatibility
- Old desktop app against a new hub: unaffected (identical wire behaviour). New app against an old hub: n/a (hub-side only).
- The store directory gains `chunks/` and `blobs/*.manifest`. An **older `geode-wiki` binary opening the same directory directly** would not find chunked blobs (`not-found`); only the hub process should open the store, and the hub is the single binary that must be upgraded first. Do not point two different versions at one store.
- Clients that read the directory without going through `FsStoreSession` (e.g. `tests/unit/sync-store-*` layout assertions) were updated to accept either form (`storedBlobSize` in the test harness).

## Migration of existing blobs
`node scripts/hub-chunk-migrate.mts <store> [--apply] [--limit N]` (dry run by default; `--sweep` for orphans). Largest-first, one blob at a time, nice'd, resumable (a converted blob reports `already-chunked`). Reads each candidate once; transient extra space ≤ one blob's new chunks. Corrupt blobs (bytes ≠ id) are reported and left untouched. Run it with a `pct snapshot` taken first and watch `df`.
Measured on the production store (read-only, 1 MiB aligned chunks over all versions of each log, `/tmp/hubscan/dedupe-all.ts`): 3,102 `.jsonl` entities, **35.82 GB → 9.89 GB (3.6x), 25.9 GB saved**; the heavy logs dedupe far better (`e35a2543`: 607 versions 4.99 GB → 0.35 GB, 14x); the remaining 9.9 GB is mostly single-version logs that cannot dedupe.

## Test plan
- `tests/unit/fs-store-chunked.test.ts` (11 tests): round trip + ranged reads across chunk boundaries + `blobSize`; small blobs stay whole; appended versions cost only their tails (exact chunk count/bytes); idempotent re-put; legacy → chunked conversion incl. dedupe across legacy versions, small and corrupt blobs; damaged/missing chunk is detected and healed by re-put; `appendRecord` accepts a chunked blob; RPC server round trip; orphan sweep (age guard, refusal on a bad manifest).
- Mutation check: raising `AT_REST_MIN_BYTES` makes 8 of the 11 fail.
- Existing conformance/fault/latency/http-store suites run unchanged against chunked storage (layout assertions generalised).
- Before production: run `hub-chunk-migrate` on a copy of the real store, then `geode-wiki sync status/conflicts` from two devices and compare `diff -r` of the materialised vaults.
