import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SyncHashCacheEntry } from "../sync-core/ports";
import { durableWrite, ensureDurableDirectory } from "./sync-apply";

/**
 * Durable hash cache for the headless host: one JSON file, loaded once, held in
 * memory, atomically rewritten (tmp + rename + fsync via durableWrite) at most once per
 * run: upserts only mark it dirty; the engine's prune() (end of every complete
 * snapshot) and the host's end-of-run flush() write it, and only if it changed. A warm run changes nothing, so it costs one read+parse and
 * no write. Row validity (path, size, mtime, providerId and the RACY_WRITE_WINDOW_MS
 * age guard) is decided by the engine's snapshot, not here: this class only stores
 * what it is given. The cache is derivable, so a missing or corrupt file is simply
 * an empty cache.
 */
export class NodeHashCache {
  private entries: Record<string, SyncHashCacheEntry> | null = null;
  private dirty = false;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, SyncHashCacheEntry>> {
    if (this.entries) return this.entries;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { schema?: number; entries?: Record<string, SyncHashCacheEntry> };
      this.entries = parsed?.schema === 1 && parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
    } catch { this.entries = {}; }
    return this.entries;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn); this.chain = run.catch(() => {}); return run;
  }
  readAll(): Promise<Record<string, SyncHashCacheEntry>> { return this.serial(async () => ({ ...await this.load() })); }
  upsertBatch(updates: Record<string, SyncHashCacheEntry>): Promise<void> {
    return this.serial(async () => { const entries = await this.load(); Object.assign(entries, updates); this.dirty = true; });
  }
  prune(keepPaths: string[]): Promise<void> {
    return this.serial(async () => {
      const entries = await this.load(), keep = new Set(keepPaths);
      for (const key of Object.keys(entries)) if (!keep.has(key)) { delete entries[key]; this.dirty = true; }
      await this.flushNow();
    });
  }
  /** Writes pending changes (no-op when clean). */
  flush(): Promise<void> { return this.serial(() => this.flushNow()); }
  private async flushNow(): Promise<void> {
    if (!this.dirty || !this.entries) return;
    await ensureDurableDirectory(path.dirname(this.file));
    await durableWrite(this.file, Buffer.from(JSON.stringify({ schema: 1, entries: this.entries })));
    this.dirty = false;
  }
}
