import type { PrivateKeyStore } from "./private-key-store";
import {
  applyHistoryLedgerDelta,
  hasHistoryLedgerDelta,
  openHistoryLedgerDb,
  readAllHistoryQuarantine,
  readAllHistoryRecords,
} from "./history-ledger-store";
import type { HistoryLedgerWritePayload } from "../shared/history-ledger";

/**
 * ADR-0027: orchestrates the split read/write across the small-state
 * `PrivateKeyStore` and the per-identity SQLite ledger — the logic behind
 * `main.ts`'s `history-state-read`/`history-state-write` IPC handlers, kept
 * in its own module (rather than inline in `main.ts`) so it can be unit
 * tested against a real `PrivateKeyStore` pointed at a temp directory,
 * without booting Electron. `history-ledger-store.ts` itself stays pure
 * SQLite mechanics, mirroring `metadata-cache-store.ts`'s scope.
 */

/**
 * Read `identity`'s state: transparently migrate a legacy (pre-split) blob
 * in place if it still carries a `history` key (the migration gate — see the
 * ADR), then merge in the ledger's full `records`/`quarantined` tables.
 * Returns the shape `history-controller.ts`'s `load()` expects, or `null`
 * when nothing is persisted yet for this identity.
 */
export async function readHistoryLedgerState(deviceStore: PrivateKeyStore, deviceStateDir: string, identity: string): Promise<unknown | null> {
  const bytes = await deviceStore.readAndMaybeUpgrade(identity, async (current) => {
    let parsed: unknown;
    try { parsed = JSON.parse(current.toString("utf8")); }
    catch { return null; }
    if (typeof parsed !== "object" || parsed === null || !("history" in parsed)) return null;
    const record = parsed as Record<string, unknown> & {
      history?: { records?: Record<string, { entityId: string }>; quarantined?: Record<string, unknown> };
    };
    const db = openHistoryLedgerDb(deviceStateDir, identity);
    try {
      applyHistoryLedgerDelta(db, {
        upsertRecords: record.history?.records ?? {},
        upsertQuarantine: record.history?.quarantined ?? {},
        deleteRecordIds: [],
      });
    } finally { db.close(); }
    // completedOperations is dead (history-controller.ts no longer reads it back)
    // and always arrives alongside `history` on a pre-split blob — the same gate
    // that triggers this migration also strips it, so no separate marker is needed.
    const { history: _history, completedOperations: _completedOperations, ...rest } = record;
    return Buffer.from(JSON.stringify(rest), "utf8");
  });
  if (bytes === null) return null;
  const small = JSON.parse(bytes.toString("utf8"));
  const db = openHistoryLedgerDb(deviceStateDir, identity);
  try { return { ...small, history: { records: readAllHistoryRecords(db), quarantined: readAllHistoryQuarantine(db) } }; }
  finally { db.close(); }
}

/**
 * Commit `payload.delta` to the SQLite ledger first — skipped entirely
 * (database never even opened) when the delta is empty — and only once that
 * resolves, write `payload.small` via the existing small-state store. This
 * ordering is mandatory, not incidental: see ADR-0027's Failure Modes
 * section for the data-loss mode a reversed order would reintroduce.
 */
export async function writeHistoryLedgerState(deviceStore: PrivateKeyStore, deviceStateDir: string, identity: string, payload: HistoryLedgerWritePayload): Promise<void> {
  if (hasHistoryLedgerDelta(payload.delta)) {
    const db = openHistoryLedgerDb(deviceStateDir, identity);
    try { applyHistoryLedgerDelta(db, payload.delta); }
    finally { db.close(); }
  }
  await deviceStore.write(identity, Buffer.from(JSON.stringify(payload.small)));
}
