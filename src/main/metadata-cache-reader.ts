import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { METADATA_DB_RELATIVE_PATH } from "./metadata-cache-store";
import { isPersistedMetadataIndexSnapshot, METADATA_INDEX_SCHEMA_VERSION, type PersistedMetadataIndexEntry } from "../indexer/metadata-indexer";

export interface MetadataCachePage {
  schemaVersion: number;
  sequence: number;
  entries: Record<string, PersistedMetadataIndexEntry>;
  examined: number;
  omitted: { corrupt: number; oversized: number };
  done: boolean;
}
const MAX_ROWS = 50, MAX_BYTES = 256 * 1024, IDLE_MS = 30000, TOTAL_MS = 300000;
interface Reader {
  token: string; generation: number; db: DatabaseSync; after: string | null;
  sequence: number; created: number; touched: number; timer: ReturnType<typeof setTimeout>;
}

/** Main-only ownership/lifetime manager. Each synchronous page returns before the next IPC request. */
export class MetadataCacheReaders {
  private readers = new Map<number, Reader>();
  begin(owner: number, root: string, generation: number): { token: string; schemaVersion: number } {
    this.closeOwner(owner);
    const db = new DatabaseSync(join(root, METADATA_DB_RELATIVE_PATH), { readOnly: true });
    try {
      db.exec("BEGIN");
      if (db.prepare("PRAGMA user_version").get()?.user_version !== METADATA_INDEX_SCHEMA_VERSION) throw Error("Unsupported metadata cache schema");
      // BEGIN is lazy: an actual table read pins the WAL snapshot now.
      db.prepare("SELECT path FROM metadata_entries ORDER BY path LIMIT 1").get();
      const reader: Reader = { token: randomUUID(), generation, db, after: null, sequence: 0, created: Date.now(), touched: Date.now(), timer: undefined! };
      this.readers.set(owner, reader);
      this.arm(owner, reader);
      return { token: reader.token, schemaVersion: METADATA_INDEX_SCHEMA_VERSION };
    } catch (error) { db.close(); throw error; }
  }
  private arm(owner: number, reader: Reader): void {
    clearTimeout(reader.timer);
    reader.timer = setTimeout(() => this.closeOwner(owner), Math.max(0, Math.min(IDLE_MS, reader.created + TOTAL_MS - Date.now())));
    reader.timer.unref();
  }
  private owned(owner: number, generation: number, token: string): Reader {
    const reader = this.readers.get(owner);
    if (!reader || reader.token !== token || reader.generation !== generation) throw Error("Invalid metadata reader owner or session");
    if (Date.now() - reader.touched >= IDLE_MS || Date.now() - reader.created >= TOTAL_MS) {
      this.closeOwner(owner); throw Error("Expired metadata reader");
    }
    return reader;
  }
  page(owner: number, generation: number, token: string, sequence: number): MetadataCachePage {
    const reader = this.owned(owner, generation, token);
    try {
      if (!Number.isSafeInteger(sequence) || sequence !== reader.sequence) throw Error("Invalid metadata page sequence");
      const page: MetadataCachePage = { schemaVersion: METADATA_INDEX_SCHEMA_VERSION, sequence, entries: Object.create(null), examined: 0, omitted: { corrupt: 0, oversized: 0 }, done: false };
      const next = reader.db.prepare(`SELECT path, mtime_ms AS mtimeMs, size,
        length(CAST(metadata_json AS BLOB)) AS metadataBytes,
        coalesce(length(CAST(mention_keys_json AS BLOB)),0) AS mentionBytes
        FROM metadata_entries ${reader.after === null ? "" : "WHERE path > ?"} ORDER BY path LIMIT ${MAX_ROWS}`);
      const rows = (reader.after === null ? next.all() : next.all(reader.after)) as unknown as { path: string; mtimeMs: number; size: number; metadataBytes: number; mentionBytes: number }[];
      for (const row of rows) {
        page.examined++;
        // Preflight blob byte lengths before fetching any potentially giant JSON.
        if (row.metadataBytes + row.mentionBytes + Buffer.byteLength(JSON.stringify(row.path)) > MAX_BYTES - 256) {
          page.omitted.oversized++; reader.after = row.path; continue;
        }
        let entry: PersistedMetadataIndexEntry;
        const data = reader.db.prepare("SELECT metadata_json, mention_keys_json FROM metadata_entries WHERE path = ?").get(row.path) as { metadata_json: string; mention_keys_json: string | null };
        try {
          entry = { mtimeMs: row.mtimeMs, size: row.size, metadata: JSON.parse(data.metadata_json), ...(data.mention_keys_json ? { mentionKeys: JSON.parse(data.mention_keys_json) } : {}) };
          if (!isPersistedMetadataIndexSnapshot({ schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries: { [row.path]: entry } })) throw Error("Invalid persisted entry");
        } catch { page.omitted.corrupt++; reader.after = row.path; continue; }
        page.entries[row.path] = entry;
        // Reserve the largest counters this page may still accrue, so later
        // omissions cannot grow an already-full response beyond its byte cap.
        if (Buffer.byteLength(JSON.stringify({ ...page, examined: MAX_ROWS, omitted: { corrupt: MAX_ROWS, oversized: MAX_ROWS } })) > MAX_BYTES) {
          delete page.entries[row.path];
          if (Object.keys(page.entries).length) { page.examined--; break; }
          page.omitted.oversized++;
        }
        reader.after = row.path;
      }
      // Only read an indexed key to establish completion, never another blob.
      page.done = !reader.db.prepare("SELECT path FROM metadata_entries WHERE path > ? ORDER BY path LIMIT 1").get(reader.after ?? "");
      reader.sequence++; reader.touched = Date.now();
      if (page.done) this.closeOwner(owner); else this.arm(owner, reader);
      return page;
    } catch (error) { this.closeOwner(owner); throw error; }
  }
  cancel(owner: number, generation: number, token: string): void {
    const reader = this.readers.get(owner);
    if (!reader) return;
    this.owned(owner, generation, token); this.closeOwner(owner);
  }
  closeOwner(owner: number): void {
    const reader = this.readers.get(owner);
    if (!reader) return;
    this.readers.delete(owner); clearTimeout(reader.timer);
    try { reader.db.exec("ROLLBACK"); } finally { reader.db.close(); }
  }
  closeAll(): void { for (const owner of this.readers.keys()) this.closeOwner(owner); }
}
