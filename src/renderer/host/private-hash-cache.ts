import type { HashCacheEntry, HashCacheService } from "./contracts";
import type { MobileSyncPorts } from "./mobile-sync-safety";

/**
 * The sync engine's per-path hash cache for the mobile host, kept in the app-sandbox private store (outside every vault, never
 * scanned or synced, excluded from backup). The engine reuses a row only when the file's size and mtime still match it exactly,
 * the row was written by the same provider, and the mtime is old enough to rule out a write racing the stat (see
 * RACY_WRITE_WINDOW_MS in sync-core/ports.ts). Anything else is a cold miss: the file is read and hashed again. Without this the
 * phone read and hashed every local file on every cycle (three times per run), idle or not.
 *
 * One JSON document per vault. It is read once and then held in memory (a single webview owns the vault), and written back only
 * when a cycle actually changed something, so an idle cycle costs one read of the document on the first cycle after launch and
 * no writes. A document that cannot be read or parsed is treated as an empty cache: the next cycle simply re-hashes.
 * Safety does not depend on it: the apply-time hash guard still reads the real bytes.
 */
export function createPrivateHashCache(store: MobileSyncPorts["privateStore"], rootId: () => string | null): HashCacheService {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const loaded = new Map<string, Record<string, HashCacheEntry>>();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(work); tail = next.catch(() => {}); return next; };
  const fileFor = async (root: string) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(root)));
    return `hash-cache/${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}.json`;
  };
  const rowsFor = async (root: string): Promise<Record<string, HashCacheEntry>> => {
    const known = loaded.get(root);
    if (known) return known;
    let rows: Record<string, HashCacheEntry> = {};
    try {
      const bytes = await store.read(await fileFor(root));
      const parsed = bytes ? JSON.parse(decoder.decode(bytes)) as { version?: number; rows?: Record<string, HashCacheEntry> } : null;
      if (parsed?.version === 1 && parsed.rows && typeof parsed.rows === "object") rows = parsed.rows;
    } catch { rows = {}; }
    loaded.set(root, rows);
    return rows;
  };
  const persist = async (root: string, rows: Record<string, HashCacheEntry>) => {
    try { await store.write(await fileFor(root), encoder.encode(JSON.stringify({ version: 1, rows }))); }
    catch { loaded.delete(root); } // not durable: the next read starts from what is really on disk
  };
  return {
    readAll: () => serial(async () => { const root = rootId(); return root ? { ...await rowsFor(root) } : null; }),
    upsertBatch: entries => serial(async () => {
      const root = rootId(); if (!root || !Object.keys(entries).length) return;
      const rows = await rowsFor(root); Object.assign(rows, entries); await persist(root, rows);
    }),
    prune: keepPaths => serial(async () => {
      const root = rootId(); if (!root) return;
      const rows = await rowsFor(root), keep = new Set(keepPaths); let removed = false;
      for (const path of Object.keys(rows)) if (!keep.has(path)) { delete rows[path]; removed = true; }
      if (removed) await persist(root, rows);
    }),
  };
}
