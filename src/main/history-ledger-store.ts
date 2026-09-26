import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { HistoryLedgerDelta } from "../shared/history-ledger";

/**
 * SQLite-backed store for the append-only history ledger (ADR-0027): one
 * file per identity, one row per record/quarantine entry. Mirrors
 * `metadata-cache-store.ts`'s shape (`node:sqlite` `DatabaseSync`, WAL,
 * upsert functions) with one deliberate difference — `synchronous = FULL`,
 * not `NORMAL` — because this ledger is the local copy of the authoritative
 * append-only history and is not rebuildable from a rescan the way the
 * metadata cache is.
 */
export const HISTORY_LEDGER_SCHEMA_VERSION = 1;

/** Apply the history_records/history_quarantine schema/pragmas to an already-open handle. Idempotent — safe to call on every open. */
export function initializeHistoryLedgerSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`PRAGMA user_version = ${HISTORY_LEDGER_SCHEMA_VERSION}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_records (
      record_id   TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL,
      record_json TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_records_entity ON history_records(entity_id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_quarantine (
      record_id  TEXT PRIMARY KEY,
      entry_json TEXT NOT NULL
    )
  `);
}

/**
 * `<deviceStateDir>/history/<sha256(identity)hex>.sqlite` — the same
 * identity hash `PrivateKeyStore.paths()` computes, so the ledger file's
 * stem matches its small-state JSON sibling (`<deviceStateDir>/<hash>.json`)
 * for correlation and joint cleanup.
 */
export function historyLedgerPath(deviceStateDir: string, identity: string): string {
  const hash = createHash("sha256").update(identity).digest("hex");
  return path.join(deviceStateDir, "history", `${hash}.sqlite`);
}

/** Open (creating the file and parent directory if needed) one identity's history ledger database. */
export function openHistoryLedgerDb(deviceStateDir: string, identity: string): DatabaseSync {
  const target = historyLedgerPath(deviceStateDir, identity);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  try {
    initializeHistoryLedgerSchema(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Full rehydration read for `history.records`, keyed by `recordId` — the shape `history-controller.ts`'s `load()` expects. */
export function readAllHistoryRecords(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare("SELECT record_id AS recordId, record_json AS recordJson FROM history_records").all() as unknown as {
    recordId: string;
    recordJson: string;
  }[];
  const records: Record<string, unknown> = {};
  for (const row of rows) records[row.recordId] = JSON.parse(row.recordJson);
  return records;
}

/** Full rehydration read for `history.quarantined`, keyed by `recordId`. */
export function readAllHistoryQuarantine(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare("SELECT record_id AS recordId, entry_json AS entryJson FROM history_quarantine").all() as unknown as {
    recordId: string;
    entryJson: string;
  }[];
  const entries: Record<string, unknown> = {};
  for (const row of rows) entries[row.recordId] = JSON.parse(row.entryJson);
  return entries;
}

function upsertRecordsStatement(db: DatabaseSync) {
  return db.prepare(`
    INSERT INTO history_records (record_id, entity_id, record_json)
    VALUES (?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      entity_id = excluded.entity_id,
      record_json = excluded.record_json
  `);
}

function upsertQuarantineStatement(db: DatabaseSync) {
  return db.prepare(`
    INSERT INTO history_quarantine (record_id, entry_json)
    VALUES (?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      entry_json = excluded.entry_json
  `);
}

/** Upsert a batch of records. Caller is expected to already be inside a transaction for multi-step deltas — see `applyHistoryLedgerDelta`. */
export function upsertHistoryRecords(db: DatabaseSync, records: Record<string, { entityId: string }>): void {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const stmt = upsertRecordsStatement(db);
  for (const id of ids) { const record = records[id]; stmt.run(id, record.entityId, JSON.stringify(record)); }
}

/** Upsert a batch of quarantine entries. Same transaction expectation as `upsertHistoryRecords`. */
export function upsertHistoryQuarantine(db: DatabaseSync, entries: Record<string, unknown>): void {
  const ids = Object.keys(entries);
  if (!ids.length) return;
  const stmt = upsertQuarantineStatement(db);
  for (const id of ids) stmt.run(id, JSON.stringify(entries[id]));
}

/** Delete rows moving out of `history_records` (into `history_quarantine`). A no-op for any id that was never a plain record. */
export function deleteHistoryRecords(db: DatabaseSync, recordIds: string[]): void {
  if (!recordIds.length) return;
  const stmt = db.prepare("DELETE FROM history_records WHERE record_id = ?");
  for (const id of recordIds) stmt.run(id);
}

/** True when a delta actually touches something — the caller's signal to skip the SQLite transaction (and, at the IPC boundary, opening the database at all) entirely. */
export function hasHistoryLedgerDelta(delta: HistoryLedgerDelta): boolean {
  return Object.keys(delta.upsertRecords).length > 0 || Object.keys(delta.upsertQuarantine).length > 0 || delta.deleteRecordIds.length > 0;
}

/**
 * Apply a full delta (upserts plus quarantine-moves) as one
 * `BEGIN IMMEDIATE`/`COMMIT` transaction, matching
 * `metadata-cache-store.ts`'s `upsertMetadataEntries` pattern. A no-op
 * (no transaction opened) when the delta is empty.
 */
export function applyHistoryLedgerDelta(db: DatabaseSync, delta: HistoryLedgerDelta): void {
  if (!hasHistoryLedgerDelta(delta)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    upsertHistoryRecords(db, delta.upsertRecords);
    upsertHistoryQuarantine(db, delta.upsertQuarantine);
    deleteHistoryRecords(db, delta.deleteRecordIds);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
