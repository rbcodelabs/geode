import type { CachedMetadata } from "../renderer/types";

export const METADATA_INDEX_SCHEMA_VERSION = 1;

export interface MetadataIndexEntry {
  mtimeMs: number;
  size: number;
  content: string;
  metadata: CachedMetadata;
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

export function isMetadataIndexSnapshot(value: unknown): value is MetadataIndexSnapshot {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<MetadataIndexSnapshot>;
  if (cache.schemaVersion !== METADATA_INDEX_SCHEMA_VERSION || !cache.entries || Array.isArray(cache.entries)) return false;
  return Object.values(cache.entries).every((entry) => {
    const item = entry as Partial<MetadataIndexEntry> | null;
    return !!item && typeof item.mtimeMs === "number" && typeof item.size === "number" &&
      typeof item.content === "string" && !!item.metadata && Array.isArray(item.metadata.links) &&
      Array.isArray(item.metadata.embeds) && Array.isArray(item.metadata.tags) &&
      Array.isArray(item.metadata.headings) && Array.isArray(item.metadata.aliases);
  });
}

export async function reconcileMetadataIndex(
  files: MetadataFileStat[],
  persisted: MetadataIndexSnapshot | null,
  read: (path: string) => Promise<string>,
  parse: (content: string) => CachedMetadata,
  onComplete?: (stats: MetadataReconcileStats) => void,
): Promise<MetadataIndexSnapshot> {
  const entries: Record<string, MetadataIndexEntry> = {};
  const currentPaths = new Set(files.map((file) => file.path));
  let parsedFiles = 0;
  let reusedFiles = 0;
  for (const file of files) {
    const previous = persisted?.entries[file.path];
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
      entries[file.path] = previous;
      reusedFiles += 1;
      continue;
    }
    const content = await read(file.path);
    entries[file.path] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      content,
      metadata: parse(content),
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

export class DebouncedMetadataCacheWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: MetadataIndexSnapshot | null = null;

  constructor(
    private readonly write: (snapshot: MetadataIndexSnapshot) => Promise<void>,
    private readonly delayMs = 2_000,
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
    if (snapshot) await this.write(snapshot);
  }
}
