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
): Promise<MetadataIndexSnapshot> {
  const entries: Record<string, MetadataIndexEntry> = {};
  for (const file of files) {
    const previous = persisted?.entries[file.path];
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
      entries[file.path] = previous;
      continue;
    }
    const content = await read(file.path);
    entries[file.path] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      content,
      metadata: parse(content),
    };
  }
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
