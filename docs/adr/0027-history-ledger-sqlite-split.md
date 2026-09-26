# ADR-0027: Split the append-only history ledger into SQLite

**Date:** 2026-09-26
**Status:** Proposed

## Context

`HistoryControllerState` (`src/renderer/sync/history-controller.ts:68-87`) mixes
two very different kinds of state in one persisted blob:

- **Small/mutable**: `cursor`, `baseline`, `reservedEntities`, `approved`,
  `scopeKey`, `previewSignature`, `conflicts`, `blocked`, `pendingBatch`,
  `abandonRequested`, `recoveryIssues`, `blobAvailability`. Cheap to rewrite
  wholesale; changes every sync cycle.
- **Unbounded/append-only**: `history: HistoryStore` (`records`,
  `quarantined`, from `history-reducer.ts:2`), plus the dead
  `completedOperations: string[]` (line 82), which nothing reads back except
  an `Array.isArray` type-check at load (line 309).

`PrivateKeyStore.write()` (`src/main/private-key-store.ts:54-67`) re-serializes
and fsyncs the *entire* blob (mkdir, write+fsync temp file, rename, fsync
directory, read-back verify) on every save. Per sync cycle this happens 3-4
times (`sync-service.ts` → `history-controller.ts`: `preview()` once,
`run()`'s `execute()` twice plus a final write, `recover()` once more when
resuming). `history.records` and `completedOperations` both grow forever
(`mergeHistory`/`deriveHistory`, `history-reducer.ts:53-226`, never prune), so
this cost scales linearly with total historical record count, forever, on
every save.

`src/main/metadata-cache-store.ts` already solves the analogous problem for
file metadata: `node:sqlite` `DatabaseSync`, one row per key, upsert/prune
functions, WAL journal mode. `history.records` is keyed by an immutable,
content-addressed `recordId`, and the only mutation is quarantine-on-contradiction
(`history-reducer.ts:61-71`) — the same "rare delete, otherwise pure append"
shape metadata-cache already handles.

ADR-0016 states "cursor advancement is atomic with the raw index and
pending/quarantine state." This design revises that specific sentence (see
Decision, ordering).

## Decision

Split `HistoryControllerState` persistence at the host boundary only.
`history-controller.ts`'s ports (`load(): Promise<unknown|null>`,
`save(state): Promise<void>`) and all of `history-reducer.ts`
(`mergeHistory`/`deriveHistory`) are unchanged. The renderer still receives
and hands back one in-memory object with `state.history.records` /
`state.history.quarantined` fully populated, exactly as today.

**Where it moves**: `sync-service.ts`'s port wiring (currently
`host.deviceState.read/write(stateKey)`, lines 326-327) switches, for the
`sync-history/${root}/${bindingKey}` key only, to a new host capability
`host.historyLedger`, backed by two new IPC channels in `main.ts`
(`history-state-read` / `history-state-write`) and a new
`src/main/history-ledger-store.ts` mirroring `metadata-cache-store.ts`.
`coordinator.ts`'s unrelated `sync/`- and `sync-history-binding/`-prefixed
keys keep using generic `device-state-*` untouched.

**Schema** (one SQLite file per identity, see Migration for the path):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;   -- see Options Considered
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS history_records (
  record_id   TEXT PRIMARY KEY,   -- HistoryRecord.recordId (immutable, content-addressed)
  entity_id   TEXT NOT NULL,      -- denormalized for a future entity-scoped read; unused by today's full-scan load
  record_json TEXT NOT NULL       -- canonical HistoryRecord, same shape cloneRecord() produces
);
CREATE INDEX IF NOT EXISTS idx_history_records_entity ON history_records(entity_id);

CREATE TABLE IF NOT EXISTS history_quarantine (
  record_id  TEXT PRIMARY KEY,
  entry_json TEXT NOT NULL        -- { reason, variants } as stored today
);
```

File: `<userData>/device-state/history/<sha256(stateKey)hex>.sqlite`, using
the same identity hash `PrivateKeyStore.paths()` already computes, so the
ledger file's stem matches its small-state JSON sibling
(`device-state/<hash>.json`) for correlation and joint cleanup.

**Read path** (`history-state-read`): read the small JSON via the existing
`deviceStore` `PrivateKeyStore`; if it still carries a `history` key, run the
one-time migration (below) first. Then `SELECT * FROM history_records` /
`history_quarantine`, rehydrate `records`/`quarantined` dictionaries keyed by
`record_id`, and return `{ ...small, history: { records, quarantined } }` —
byte-for-byte the shape `history-controller.ts`'s `load()` already expects.
`completedOperations` is no longer part of the type or the returned object
(see below).

**Write path** (`history-state-write`): the renderer-side glue in
`sync-service.ts` keeps an in-closure `Set<string>` of record/quarantine ids
already known-persisted, seeded fresh from each `load()`. On `save(state)`:
compute `upsertRecords` (new ids in `state.history.records` since last known),
`upsertQuarantine` + `deleteRecordIds` (ids newly present in
`state.history.quarantined` — these move out of `history_records` into
`history_quarantine` in one transaction), then:

1. Send the delta to `history-state-write`; `history-ledger-store.ts` applies
   it as one `BEGIN IMMEDIATE`/`COMMIT` transaction (upsert + delete),
   matching `metadata-cache-store.ts`'s `upsertMetadataEntries` pattern.
2. **Only after that resolves**, write the small-state JSON (unchanged
   `PrivateKeyStore.write`, now carrying a strictly smaller object).

This ordering is mandatory, not incidental — see Failure Modes. A save with
an empty delta (the common case: preview with nothing new) skips step 1
entirely, so the routine cost is exactly what it is today for small state,
zero SQLite writes.

**`completedOperations` removal**: this is a controller-level change (not a
reducer change) confined to `history-controller.ts`: drop the field from the
`HistoryControllerState` interface (line 82), the empty-state initializer
(line 307), the `Array.isArray` load guard (line 309), and the append in
`finish()` (line 829). `history-reducer.ts` never referenced this field.

**Compat shim**: old on-disk JSON blobs (pre-this-change) still have
`completedOperations` physically present. Since the field is removed from the
TS type, it is simply never read — no validation, no error, it is inert until
the next `save()` naturally overwrites the file without it. No special-case
code is needed for this field beyond deleting the four call sites above.

## Migration path

Migration is **lazy and per-identity**, triggered inside `history-state-read`,
not a global upfront pass — `PrivateKeyStore` has no listing API, so there is
no cheap way to enumerate every existing `sync-history/*` identity in
advance, and a vault/binding not currently in use shouldn't pay a migration
cost until it is next touched.

Gate condition: **the presence of a `history` key in the persisted small-JSON
blob** is the migration marker. No separate `migrated: true` flag or schema
version counter is introduced — that would be one more piece of state that
could itself drift from reality.

```
read small-json via deviceStore.read(identity)
if null: return null                      // brand-new state, nothing to do
if small-json has no "history" key:
    already migrated (or already new) -> normal split read
else:
    // one-time migration, inside the identity's existing PrivateKeyStore lock
    open/create the ledger sqlite (CREATE TABLE IF NOT EXISTS, idempotent)
    BEGIN IMMEDIATE
      upsert every small-json.history.records[*] into history_records
      upsert every small-json.history.quarantined[*] into history_quarantine
    COMMIT
    rewrite small-json via deviceStore.write with history AND
      completedOperations stripped out
    proceed to normal split read
```

Wrap the whole migration (read → conditional sqlite txn → conditional
rewrite) inside the same per-identity mutex `PrivateKeyStore.lock()` already
uses for `read()`/`write()`, by adding a `readAndMaybeUpgrade()`-style method
rather than composing bare `read()`+`write()` calls, so a concurrent save
against the same identity can't interleave with an in-flight migration.

## Failure modes

**Crash mid-migration** (after the SQLite upsert commits, before the
small-JSON rewrite): the gate condition (`history` key still present) is
still true on the next read, so migration simply re-runs. The SQLite upsert
is idempotent (`ON CONFLICT DO UPDATE`, same content) — re-running it is a
harmless no-op. The rewrite is then retried and succeeds. No data loss, no
special recovery code: retry-on-next-read is the whole story.

**Crash mid-write, SQLite committed but small-JSON not yet rewritten**: same
shape as above, and safe for the same reason — the cursor in the (stale)
small-JSON is *behind* what the ledger already durably has. The next sync
cycle scans from that stale cursor, re-delivering a record range the ledger
already contains; `mergeHistory` replaying identical existing records is a
documented no-op ("a replay can never rehabilitate an ambiguous ID" /
ADR-0016: "rescans union with known history"). Net effect: one bounded,
redundant re-merge of already-known records, not corruption or loss.

**Crash mid-write, small-JSON committed but SQLite delta not yet committed**:
excluded by construction — the write path awaits the SQLite transaction
before calling `PrivateKeyStore.write` for the small JSON. A crash inside the
SQLite transaction itself leaves it fully absent (WAL commit is atomic), which
is exactly the case above.

**This is why the order is SQLite-first, then small-JSON**, not the reverse.
The reverse order has a real data-loss failure mode: if the cursor advances
before its records are durable and the process dies in between, the next
scan requests records *after* the now-advanced cursor and permanently skips
the lost batch. This ordering requirement is the one place this design
revises ADR-0016's "cursor advancement is atomic with the raw index" — true
cross-store atomicity is not attempted; instead the cursor is guaranteed to
never advance ahead of the ledger, and lagging behind it is proven safe by
the existing replay-idempotence the reducer already guarantees.

**Orphaned ledger files**: today, `deviceState.remove()` is never called for
`sync-history/*` keys (only for `sync-history-binding/*`, `sync-service.ts:429`)
— unbinding a vault already leaks the small-JSON blob. This design does not
fix that pre-existing leak; it adds a second orphaned file (the `.sqlite`) if
one is ever wired up for removal, ledger cleanup must be added alongside it.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Keep single JSON blob, do nothing | No change | Fsync cost and blob size scale with total history forever (the finding this ADR exists to fix) |
| Full-table upsert every save (no delta tracking) | Simpler write path, no closure bookkeeping | Removes the fsync-of-whole-blob multiplier but every save still costs O(total record count) in SQLite writes — does not actually bound per-cycle cost by what changed |
| Delta-only upsert via closure-tracked known-id set (chosen) | Per-save cost bounded by records touched this cycle; empty-delta saves cost nothing extra | Requires tracking "known persisted ids" in `sync-service.ts`'s port wiring, reset per `load()` |
| Normalize `HistoryRecord` fields into columns | Queryable per-field | No current caller needs field-level queries; `deriveHistory` still needs the full object; adds migration surface for no present benefit |
| `synchronous = NORMAL` (match metadata-cache-store) | Consistent with existing precedent, faster | Metadata cache is disposable/rebuildable from a rescan; history records are the local copy of the authoritative append-only ledger. This ADR chooses `FULL` for the ledger; a future perf issue can revisit if measured |

## Consequences

Ledger writes are now O(records touched this cycle), not O(total history).
Small-state writes are unchanged. `history-reducer.ts` is untouched; no
change to the reconciliation algorithm's read-side complexity — `deriveHistory`
still rebuilds the full graph from every row on every `plan()`, which remains
future work if it ever becomes the bottleneck (the `entity_id` index is laid
down now specifically so that follow-up doesn't require a second migration).
`completedOperations` disappears from both the type and disk. Old on-disk
blobs migrate the first time they're next touched, not in a batch at startup.

## Risks

The riskiest assumption is that "records touched this cycle" stays small
relative to total history in the workloads that matter — if a single sync
cycle routinely rewrites a large fraction of all records (e.g. a mass
quarantine event), the delta-upsert cost degrades toward the full-table case,
though still without the JSON-blob fsync multiplier. The migration's
gate condition (bare presence/absence of a JSON key) is deliberately simple;
if a future change ever needs a small-JSON blob to legitimately carry a field
named `history` for an unrelated reason, this gate would need to move to an
explicit marker instead.
