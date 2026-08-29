import type { CachedMetadata } from "../renderer/types";

export const METADATA_INDEX_SCHEMA_VERSION = 1;

/**
 * The on-disk / wire shape of a metadata index entry. Deliberately excludes
 * raw file `content` — shipping every file's full text (over IPC, or into a
 * SQLite blob) is what caused the multi-GB memory blowup this module exists
 * to avoid. Consumers that need a file's content call `vault.cachedRead()`,
 * which is a single cheap on-demand IPC round trip.
 */
export interface PersistedMetadataIndexEntry {
  mtimeMs: number;
  size: number;
  metadata: CachedMetadata;
  /** Additive field; always populated by current writes. */
  mentionKeys?: string[];
}

export interface PersistedMetadataIndexSnapshot {
  schemaVersion: number;
  entries: Record<string, PersistedMetadataIndexEntry>;
}

export interface MetadataFileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface MetadataReconcileStats {
  totalFiles: number;
  parsedFiles: number;
  reusedFiles: number;
  deletedFiles: number;
}

export const METADATA_SNAPSHOT_CHUNK_MAX_BYTES = 256 * 1024;
export const METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES = 50;

export type MetadataSnapshotMessage =
  | { type: "snapshot-start"; schemaVersion: number; totalEntries: number }
  | { type: "snapshot-chunk"; sequence: number; entries: Record<string, PersistedMetadataIndexEntry> }
  | { type: "snapshot-complete"; totalChunks: number };

/**
 * Split a (content-less) snapshot into small structured-clone envelopes. An
 * individual entry that cannot fit is intentionally omitted; the renderer
 * detects the missing path and reads that file normally.
 */
export function chunkMetadataSnapshot(
  snapshot: PersistedMetadataIndexSnapshot,
  limits: { maxBytes?: number; maxEntries?: number } = {},
): MetadataSnapshotMessage[] {
  const maxBytes = limits.maxBytes ?? METADATA_SNAPSHOT_CHUNK_MAX_BYTES;
  const maxEntries = limits.maxEntries ?? METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES;
  const messages: MetadataSnapshotMessage[] = [{
    type: "snapshot-start",
    schemaVersion: snapshot.schemaVersion,
    totalEntries: Object.keys(snapshot.entries).length,
  }];
  let entries: Record<string, PersistedMetadataIndexEntry> = {};
  let entryCount = 0;
  let conservativeBytes = 0;
  let sequence = 0;
  const flush = () => {
    if (!entryCount) return;
    messages.push({ type: "snapshot-chunk", sequence: sequence++, entries });
    entries = {};
    entryCount = 0;
    conservativeBytes = 0;
  };
  for (const [path, entry] of Object.entries(snapshot.entries)) {
    const singleMessage = { type: "snapshot-chunk", sequence, entries: { [path]: entry } };
    const singleBytes = Buffer.byteLength(JSON.stringify(singleMessage));
    // Summing individually enveloped sizes deliberately overestimates the
    // combined message while avoiding repeated serialization of prior entries.
    if (entryCount && (entryCount >= maxEntries || conservativeBytes + singleBytes > maxBytes)) flush();
    if (singleBytes <= maxBytes) {
      entries[path] = entry;
      entryCount += 1;
      conservativeBytes += singleBytes;
    }
  }
  flush();
  messages.push({ type: "snapshot-complete", totalChunks: sequence });
  return messages;
}

export function isPersistedMetadataIndexSnapshot(value: unknown): value is PersistedMetadataIndexSnapshot {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<PersistedMetadataIndexSnapshot>;
  if (cache.schemaVersion !== METADATA_INDEX_SCHEMA_VERSION || !cache.entries || Array.isArray(cache.entries)) return false;
  return Object.values(cache.entries).every((entry) => {
    const item = entry as Partial<PersistedMetadataIndexEntry> | null;
    return !!item && typeof item.mtimeMs === "number" && typeof item.size === "number" &&
      !!item.metadata && Array.isArray(item.metadata.links) &&
      Array.isArray(item.metadata.embeds) && Array.isArray(item.metadata.tags) &&
      Array.isArray(item.metadata.headings) && Array.isArray(item.metadata.aliases) &&
      (item.mentionKeys === undefined ||
        (Array.isArray(item.mentionKeys) && item.mentionKeys.every((key) => typeof key === "string")));
  });
}

const RECONCILE_BATCH_SIZE = 500;

/**
 * The storage operations `reconcileMetadataIndex` needs, injected by the
 * caller rather than imported directly. This keeps this module free of any
 * concrete storage implementation (in production, SQLite via
 * `src/main/metadata-cache-store.ts`) — load-bearing, not just tidy: this
 * file is imported by the renderer bundle (for the shared, content-less
 * entry/snapshot types), which esbuild bundles for the browser platform and
 * cannot resolve `node:sqlite`/`node:fs`. A static import of the SQLite store
 * module here would break that bundle.
 */
export interface MetadataReconcileStore {
  /** Small, content-less (path, mtimeMs, size) projection for reuse-detection. */
  readStats(): MetadataFileStat[];
  /** Upsert a batch of changed/new entries in one transaction. */
  upsertBatch(entries: Record<string, PersistedMetadataIndexEntry>): void;
  /** Delete rows for paths no longer present in the vault. */
  deletePaths(paths: string[]): void;
}

/**
 * Streaming reconcile against a SQLite-backed metadata store: never holds
 * more than one batch's worth of read+parsed data in memory at a time (peak
 * JS heap is O(batch size), not O(vault size)).
 *
 * Only changed/new files are read, parsed, upserted, and handed to `onBatch`
 * (which the caller uses to build the outgoing IPC chunk(s)). Unchanged files
 * are left untouched in the database — their data is already correct there,
 * and the renderer independently warm-starts from the same database via its
 * own `readMetadataCache()` IPC call, so re-shipping unchanged entries over
 * the wire would be pure waste. Files no longer present in `files` have their
 * rows deleted once, after the batch loop.
 */
export async function reconcileMetadataIndex(
  files: MetadataFileStat[],
  store: MetadataReconcileStore,
  read: (path: string) => Promise<string>,
  parse: (content: string) => CachedMetadata,
  onBatch?: (entries: Record<string, PersistedMetadataIndexEntry>) => void,
  onStats?: (stats: MetadataReconcileStats) => void,
  extractMentionKeys?: (content: string) => string[],
): Promise<void> {
  const priorStats = new Map(store.readStats().map((stat) => [stat.path, stat]));
  const currentPaths = new Set(files.map((file) => file.path));
  let parsedFiles = 0;
  let reusedFiles = 0;

  for (let start = 0; start < files.length; start += RECONCILE_BATCH_SIZE) {
    const batch = files.slice(start, start + RECONCILE_BATCH_SIZE);
    const batchEntries: Record<string, PersistedMetadataIndexEntry> = {};
    for (const file of batch) {
      const previous = priorStats.get(file.path);
      if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
        // Already correct on disk: no I/O, no upsert, no wire chunk needed.
        reusedFiles += 1;
        continue;
      }
      const content = await read(file.path);
      const mentionKeys = extractMentionKeys?.(content);
      batchEntries[file.path] = {
        mtimeMs: file.mtimeMs,
        size: file.size,
        metadata: parse(content),
        ...(mentionKeys ? { mentionKeys } : {}),
      };
      parsedFiles += 1;
    }
    if (Object.keys(batchEntries).length) {
      store.upsertBatch(batchEntries);
      onBatch?.(batchEntries);
    }
  }

  const deletedPaths = [...priorStats.keys()].filter((path) => !currentPaths.has(path));
  if (deletedPaths.length) store.deletePaths(deletedPaths);

  onStats?.({
    totalFiles: files.length,
    parsedFiles,
    reusedFiles,
    deletedFiles: deletedPaths.length,
  });
}

const DEBOUNCED_WRITER_MAX_BACKOFF_MS = 5 * 60_000;

/** A dirty path's pending write: an entry to upsert, or `null` for a delete. */
export type MetadataDirtyOp = PersistedMetadataIndexEntry | null;

/**
 * Debounces per-file live edits (create/modify/delete) into a coalesced
 * dirty-path set, flushed as one batched upsert/delete transaction. Multiple
 * `schedule()` calls before a flush MERGE into the pending set (keyed by
 * path) rather than replacing it, so no path's update is lost when several
 * different files change within one debounce window.
 */
export class DebouncedMetadataCacheWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, MetadataDirtyOp>();
  private consecutiveFailures = 0;

  constructor(
    private readonly write: (dirty: Map<string, MetadataDirtyOp>) => Promise<void>,
    private readonly delayMs = 2_000,
    private readonly onError?: (error: unknown, consecutiveFailures: number) => void,
  ) {}

  schedule(path: string, op: MetadataDirtyOp): void {
    this.pending.set(path, op);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    const dirty = this.pending;
    this.pending = new Map();
    try {
      await this.write(dirty);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.onError?.(error, this.consecutiveFailures);
      // A write failure must never be fatal to indexing — keep the dirty
      // paths pending and retry at a capped exponential backoff. A newer
      // schedule() for the SAME path (fresher data) takes priority over the
      // failed batch's stale value for that path.
      for (const [path, op] of dirty) {
        if (!this.pending.has(path)) this.pending.set(path, op);
      }
      const backoffMs = Math.min(this.delayMs * 2 ** this.consecutiveFailures, DEBOUNCED_WRITER_MAX_BACKOFF_MS);
      this.timer = setTimeout(() => void this.flush(), backoffMs);
    }
  }
}
