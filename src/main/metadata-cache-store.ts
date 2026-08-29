import * as path from "node:path";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { METADATA_INDEX_SCHEMA_VERSION } from "../indexer/metadata-indexer";
import type {
  MetadataFileStat,
  PersistedMetadataIndexEntry,
  PersistedMetadataIndexSnapshot,
} from "../indexer/metadata-indexer";

/**
 * SQLite-backed replacement for the old `.geode/metadata-cache/cache.json`.
 * A single table, one row per file, JSON-blob metadata column — see the plan
 * for why this beats a normalized schema for this data shape. Shared by the
 * indexer utility process (its primary writer) and the main process (the
 * renderer-fallback reader/writer used only when the indexer is unavailable).
 */
export const METADATA_DB_RELATIVE_PATH = path.join(".geode", "metadata-cache", "index.sqlite");

/** Apply the metadata_entries schema/pragmas to an already-open handle. Idempotent — safe to call on every open. */
export function initializeMetadataSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA user_version = ${METADATA_INDEX_SCHEMA_VERSION}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata_entries (
      path              TEXT PRIMARY KEY,
      mtime_ms          REAL    NOT NULL,
      size              INTEGER NOT NULL,
      metadata_json     TEXT    NOT NULL,
      mention_keys_json TEXT
    )
  `);
}

/**
 * Open (creating the file and parent directory if needed) a vault's metadata
 * database. No migration from the old JSON cache: if this file doesn't exist
 * yet, that's today's existing "no persisted match -> full reconcile" path.
 */
export function openMetadataDb(root: string): DatabaseSync {
  const target = path.join(root, METADATA_DB_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  initializeMetadataSchema(db);
  return db;
}

/** Small, content-less (path, mtimeMs, size) projection used for reconcile's reuse-detection — no metadata JSON parsing. */
export function readMetadataStats(db: DatabaseSync): MetadataFileStat[] {
  const rows = db.prepare("SELECT path, mtime_ms AS mtimeMs, size FROM metadata_entries").all() as unknown as {
    path: string;
    mtimeMs: number;
    size: number;
  }[];
  return rows.map((row) => ({ path: row.path, mtimeMs: row.mtimeMs, size: row.size }));
}

/** Full content-less snapshot of every row — the renderer's warm-start hydration read and the main-process fallback read. */
export function readAllMetadataEntries(db: DatabaseSync): PersistedMetadataIndexSnapshot {
  const rows = db
    .prepare("SELECT path, mtime_ms AS mtimeMs, size, metadata_json, mention_keys_json FROM metadata_entries")
    .all() as unknown as {
    path: string;
    mtimeMs: number;
    size: number;
    metadata_json: string;
    mention_keys_json: string | null;
  }[];
  const entries: Record<string, PersistedMetadataIndexEntry> = {};
  for (const row of rows) {
    entries[row.path] = {
      mtimeMs: row.mtimeMs,
      size: row.size,
      metadata: JSON.parse(row.metadata_json),
      ...(row.mention_keys_json ? { mentionKeys: JSON.parse(row.mention_keys_json) } : {}),
    };
  }
  return { schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries };
}

function upsertStatement(db: DatabaseSync) {
  return db.prepare(`
    INSERT INTO metadata_entries (path, mtime_ms, size, metadata_json, mention_keys_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size = excluded.size,
      metadata_json = excluded.metadata_json,
      mention_keys_json = excluded.mention_keys_json
  `);
}

/** Upsert a batch of entries in one transaction — avoids one commit per file and one all-or-nothing whole-vault transaction. */
export function upsertMetadataEntries(db: DatabaseSync, entries: Record<string, PersistedMetadataIndexEntry>): void {
  const paths = Object.keys(entries);
  if (!paths.length) return;
  const stmt = upsertStatement(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const path of paths) {
      const entry = entries[path];
      stmt.run(path, entry.mtimeMs, entry.size, JSON.stringify(entry.metadata), entry.mentionKeys ? JSON.stringify(entry.mentionKeys) : null);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Delete a single entry (e.g. one live vault-event delete). */
export function deleteMetadataEntry(db: DatabaseSync, path: string): void {
  db.prepare("DELETE FROM metadata_entries WHERE path = ?").run(path);
}

/** Delete multiple entries in one transaction (e.g. reconcile's removed-file sweep, or a debounced multi-path flush). */
export function deleteMetadataEntries(db: DatabaseSync, paths: string[]): void {
  if (!paths.length) return;
  const stmt = db.prepare("DELETE FROM metadata_entries WHERE path = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const path of paths) stmt.run(path);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Atomically replace the ENTIRE table with `snapshot`'s entries — matches the
 * old JSON cache's whole-file-replace semantics. Used only by the
 * main-process renderer-fallback write path (`persistCache()`/
 * `applyRendererFallback()`), which always sends the complete current vault
 * state, not a partial update — a plain upsert-merge would leak stale rows
 * for since-deleted files forever.
 */
export function replaceAllMetadataEntries(db: DatabaseSync, snapshot: PersistedMetadataIndexSnapshot): void {
  const stmt = upsertStatement(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM metadata_entries");
    for (const [path, entry] of Object.entries(snapshot.entries)) {
      stmt.run(path, entry.mtimeMs, entry.size, JSON.stringify(entry.metadata), entry.mentionKeys ? JSON.stringify(entry.mentionKeys) : null);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
