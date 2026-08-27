import type { CachedMetadata } from "../renderer/types";

export const METADATA_INDEX_SCHEMA_VERSION = 1;

/**
 * The on-disk / persisted shape of a metadata index entry. Deliberately
 * excludes `content` — persisting every file's raw content alongside its
 * parsed metadata is what causes the full-snapshot JSON.stringify to blow
 * past V8's max string length on large vaults (see toPersistedSnapshot).
 */
export interface PersistedMetadataIndexEntry {
  mtimeMs: number;
  size: number;
  metadata: CachedMetadata;
  /** Additive field populated off-renderer; absent in pre-v0.7.15 caches. */
  mentionKeys?: string[];
}

export interface PersistedMetadataIndexSnapshot {
  schemaVersion: number;
  entries: Record<string, PersistedMetadataIndexEntry>;
}

export interface MetadataIndexEntry extends PersistedMetadataIndexEntry {
  content: string;
}

export interface MetadataIndexSnapshot {
  schemaVersion: number;
  entries: Record<string, MetadataIndexEntry>;
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
  | { type: "snapshot-chunk"; sequence: number; entries: Record<string, MetadataIndexEntry> }
  | { type: "snapshot-complete"; totalChunks: number };

/**
 * Split the renderer compatibility snapshot into small structured-clone
 * envelopes. An individual entry that cannot fit is intentionally omitted;
 * the renderer detects the missing path and reads that file normally. The
 * utility keeps the complete authoritative snapshot for disk persistence.
 */
export function chunkMetadataSnapshot(
  snapshot: MetadataIndexSnapshot,
  limits: { maxBytes?: number; maxEntries?: number } = {},
): MetadataSnapshotMessage[] {
  const maxBytes = limits.maxBytes ?? METADATA_SNAPSHOT_CHUNK_MAX_BYTES;
  const maxEntries = limits.maxEntries ?? METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES;
  const messages: MetadataSnapshotMessage[] = [{
    type: "snapshot-start",
    schemaVersion: snapshot.schemaVersion,
    totalEntries: Object.keys(snapshot.entries).length,
  }];
  let entries: Record<string, MetadataIndexEntry> = {};
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

/**
 * Maps an in-memory snapshot (which carries full file content for renderer
 * IPC / reconciliation) down to the on-disk shape. This is what must be
 * serialized for disk persistence — never the raw in-memory snapshot — so
 * the JSON payload scales with metadata size, not vault content size.
 *
 * Only raw `content` is dropped. `mentionKeys` is metadata-sized rather than
 * content-sized and is expensive to recompute, so it must survive the disk
 * round-trip — dropping it would silently undo the warm-start optimization
 * it exists for.
 */
export function toPersistedSnapshot(snapshot: MetadataIndexSnapshot): PersistedMetadataIndexSnapshot {
  const entries: Record<string, PersistedMetadataIndexEntry> = {};
  for (const [path, entry] of Object.entries(snapshot.entries)) {
    entries[path] = entry.mentionKeys
      ? { mtimeMs: entry.mtimeMs, size: entry.size, metadata: entry.metadata, mentionKeys: entry.mentionKeys }
      : { mtimeMs: entry.mtimeMs, size: entry.size, metadata: entry.metadata };
  }
  return { schemaVersion: snapshot.schemaVersion, entries };
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

/**
 * A source entry for reconciliation may come either from the in-memory
 * snapshot (full `content` present) or from a disk-persisted snapshot
 * (`content` absent). Both MetadataIndexSnapshot and
 * PersistedMetadataIndexSnapshot are structurally assignable to
 * ReconcileSourceSnapshot below.
 */
export type ReconcileSourceEntry = PersistedMetadataIndexEntry & { content?: string };

export interface ReconcileSourceSnapshot {
  schemaVersion: number;
  entries: Record<string, ReconcileSourceEntry>;
}

export async function reconcileMetadataIndex(
  files: MetadataFileStat[],
  persisted: ReconcileSourceSnapshot | null,
  read: (path: string) => Promise<string>,
  parse: (content: string) => CachedMetadata,
  onComplete?: (stats: MetadataReconcileStats) => void,
  extractMentionKeys?: (content: string) => string[],
): Promise<MetadataIndexSnapshot> {
  const entries: Record<string, MetadataIndexEntry> = {};
  const currentPaths = new Set(files.map((file) => file.path));
  let parsedFiles = 0;
  let reusedFiles = 0;
  for (const file of files) {
    const previous = persisted?.entries[file.path];
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
      if (typeof previous.content === "string") {
        // Already in memory (e.g. a reused in-memory snapshot passed directly,
        // not round-tripped through disk) — reuse by reference, zero I/O.
        const inMemory = previous as MetadataIndexEntry;
        entries[file.path] = inMemory.mentionKeys || !extractMentionKeys
          ? inMemory
          : { ...inMemory, mentionKeys: extractMentionKeys(inMemory.content) };
      } else {
        // Loaded from disk: metadata was persisted but content wasn't, so a
        // cheap re-read is needed to repopulate content — no re-parse though.
        // mentionKeys survives the disk round-trip, so it is only recomputed
        // for pre-v0.7.15 caches written before that field existed.
        const content = await read(file.path);
        entries[file.path] = {
          mtimeMs: previous.mtimeMs,
          size: previous.size,
          content,
          metadata: previous.metadata,
          mentionKeys: previous.mentionKeys ?? extractMentionKeys?.(content),
        };
      }
      reusedFiles += 1;
      continue;
    }
    const content = await read(file.path);
    entries[file.path] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      content,
      metadata: parse(content),
      mentionKeys: extractMentionKeys?.(content),
    };
    parsedFiles += 1;
  }
  onComplete?.({
    totalFiles: files.length,
    parsedFiles,
    reusedFiles,
    deletedFiles: Object.keys(persisted?.entries ?? {}).filter((path) => !currentPaths.has(path)).length,
  });
  return { schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries };
}

const DEBOUNCED_WRITER_MAX_BACKOFF_MS = 5 * 60_000;

export class DebouncedMetadataCacheWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: MetadataIndexSnapshot | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly write: (snapshot: MetadataIndexSnapshot) => Promise<void>,
    private readonly delayMs = 2_000,
    private readonly onError?: (error: unknown, consecutiveFailures: number) => void,
  ) {}

  schedule(snapshot: MetadataIndexSnapshot): void {
    this.pending = snapshot;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) return;
    try {
      await this.write(snapshot);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.onError?.(error, this.consecutiveFailures);
      // A write failure must never be fatal to indexing — keep the snapshot
      // pending and retry at a capped exponential backoff. A subsequent
      // schedule() call (fresher data) always takes priority and resets
      // the cadence back to the base delay.
      this.pending = snapshot;
      const backoffMs = Math.min(this.delayMs * 2 ** this.consecutiveFailures, DEBOUNCED_WRITER_MAX_BACKOFF_MS);
      this.timer = setTimeout(() => void this.flush(), backoffMs);
    }
  }
}
