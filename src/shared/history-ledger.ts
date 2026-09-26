/**
 * ADR-0027: the append-only history ledger split. `HistoryControllerState`'s
 * small/mutable fields keep going through the existing `DeviceStateService`
 * JSON blob; only the unbounded `history.records`/`history.quarantined`
 * ledger moves through this capability, backed by a per-identity SQLite file
 * on the host (`src/main/history-ledger-store.ts`). Used exclusively for the
 * `sync-history/${root}/${bindingKey}` device-state key — every other
 * `device-state-*` key is untouched.
 */

/** Bounded per-cycle change to the ledger; `sync-service.ts` tracks which ids
 * are already persisted and computes this from what's new since last save. */
export interface HistoryLedgerDelta {
  /** New records this cycle. `entityId` is denormalized into the ledger's
   * `entity_id` column for a future entity-scoped read (see the ADR). */
  upsertRecords: Record<string, { entityId: string }>;
  /** New quarantine entries this cycle. */
  upsertQuarantine: Record<string, unknown>;
  /** Ids moving out of `history_records` into `history_quarantine` this
   * cycle — a no-op delete if the id was never a plain record (e.g.
   * quarantined on first sight). */
  deleteRecordIds: string[];
}

export interface HistoryLedgerWritePayload {
  /** The full small-state object — `HistoryControllerState` minus `history` —
   * the existing whole-blob write, now strictly smaller. */
  small: unknown;
  delta: HistoryLedgerDelta;
}

/** Host capability backing the split. Electron-desktop only: absent hosts
 * must never let an append-only sync provider register (see the guarded-
 * desktop-support check in `sync-service.ts`'s `register()`). */
export interface HistoryLedgerService {
  /**
   * Reads the small JSON for `key`, transparently migrating a legacy
   * (pre-split) blob in place if it still carries a `history` key, then
   * returns the merged `{ ...small, history: { records, quarantined } }`
   * shape `history-controller.ts`'s `load()` expects. `null` when nothing is
   * persisted yet for this identity.
   */
  read(key: string): Promise<unknown | null>;
  /**
   * Commits `payload.delta` to the SQLite ledger first (skipped entirely
   * when the delta is empty), and only once that resolves, writes
   * `payload.small` via the existing small-state store. This ordering is
   * mandatory — see ADR-0027's Failure Modes section.
   */
  write(key: string, payload: HistoryLedgerWritePayload): Promise<void>;
}
