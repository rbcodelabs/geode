import type { ConfigService, DeviceStateService, MetadataIndexService } from "./contracts";
import { isQuotaExceeded } from "../../shared/vault-refresh";

/**
 * Durable stores for the native iOS shell, backed by IndexedDB. The browser host snapshots all of its state into one
 * localStorage value, and WKWebView caps an origin's localStorage at about 5 MB (shared with every other key: unsaved
 * edit recovery copies, view state). Anything that grows with the vault (per-file sync history, the reconcile manifest,
 * the metadata cache) overflows that, so it lives here instead.
 *
 * Every store has a `legacy` counterpart (the localStorage-backed browser host service):
 * - reads fall back to it, so values written by an earlier build are still found;
 * - a successful IndexedDB write empties the legacy copy, so the snapshot shrinks;
 * - if IndexedDB cannot be used, small payloads are written to legacy instead of failing (vault-sized ones still fail);
 * - a legacy value that is present next to an IndexedDB record is newer than it (this build always empties legacy
 *   after writing IndexedDB, so only an older build after a downgrade, or the fallback above, can have written it)
 *   and wins, unless the record notes that its legacy cleanup failed.
 */
const DB_NAME = "geode-device-state";
const STORE = "kv";
const OPEN_TIMEOUT_MS = 10_000;
const OPEN_HANG_COOLDOWN_MS = 60_000;
/** Largest payload (JSON characters) that may fall back to the shared ~5 MB localStorage snapshot. */
const LEGACY_FALLBACK_MAX_CHARS = 256 * 1024;

export interface IdbConnection {
  db(): Promise<IDBDatabase>;
  /** Forget the current connection (closed, lost, or failed) so the next use opens a new one. */
  reset(): void;
}

/**
 * One lazily opened connection shared by the stores. The open is not started until first use (so a rejection is never
 * left unhandled), a failed or timed-out open is not cached (a transient WebKit failure at launch must not disable
 * IndexedDB until the next relaunch), and a connection the browser closes is reopened on next use.
 */
export function createIdbConnection(factory: IDBFactory | undefined, timeoutMs = OPEN_TIMEOUT_MS, now: () => number = Date.now): IdbConnection {
  let pending: Promise<IDBDatabase> | null = null;
  // After an open that hung until the timeout, fail fast for a while instead of making every read wait again.
  let hungUntil = 0;
  const connection: IdbConnection = {
    db: () => {
      if (pending) return pending;
      if (now() < hungUntil) return Promise.reject(Object.assign(new Error("IndexedDB open timed out recently"), { name: "TimeoutError" }));
      const attempt = openDb(factory, timeoutMs);
      pending = attempt;
      attempt.then(db => {
        db.onclose = () => { if (pending === attempt) pending = null; };
        db.onversionchange = () => { db.close(); if (pending === attempt) pending = null; };
      }, error => {
        if (pending === attempt) pending = null;
        if ((error as { name?: unknown })?.name === "TimeoutError") hungUntil = now() + OPEN_HANG_COOLDOWN_MS;
      });
      return attempt;
    },
    reset: () => { pending = null; },
  };
  return connection;
}

function openDb(factory: IDBFactory | undefined, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(Object.assign(new Error("IndexedDB is unavailable"), { name: "NotSupportedError" })); return; }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(Object.assign(new Error("IndexedDB open timed out"), { name: "TimeoutError" }));
    }, timeoutMs);
    let request: IDBOpenDBRequest;
    try { request = factory.open(DB_NAME, 1); }
    catch (error) { clearTimeout(timer); reject(error); return; }
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
}

function runOnce<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Runs one request. A failed open is final for this request (the next use opens again). A failed transaction on an open
 * connection (WebKit drops it: "Connection to Indexed Database server lost") is retried once on a new connection,
 * except a quota failure, which a retry cannot fix.
 */
async function run<T>(connection: IdbConnection, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await connection.db();
  try {
    return await runOnce(db, mode, action);
  } catch (error) {
    if (isQuotaExceeded(error)) throw error;
    connection.reset();
    return runOnce(await connection.db(), mode, action);
  }
}

function toConnection(source: IDBFactory | IdbConnection | undefined): IdbConnection {
  return source && typeof (source as IdbConnection).db === "function" && typeof (source as IdbConnection).reset === "function"
    ? source as IdbConnection
    : createIdbConnection(source as IDBFactory | undefined);
}

/** What this build stores. Records written by #370 are raw values without this wrapper. */
interface DurableRecord { geodeDurable: 1; value: unknown; legacyStale?: true; deleted?: true }

function asRecord(stored: unknown): DurableRecord {
  return stored && typeof stored === "object" && (stored as DurableRecord).geodeDurable === 1 ? stored as DurableRecord : { geodeDurable: 1, value: stored };
}

/** One logical value with an IndexedDB key and a legacy (localStorage snapshot) location. */
interface LegacySlot {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

async function readLegacy(legacy: LegacySlot): Promise<unknown> {
  try { return await legacy.read(); } catch { return null; }
}

async function readDurable(connection: IdbConnection, key: string, legacy: LegacySlot): Promise<unknown> {
  let stored: unknown;
  try { stored = await run(connection, "readonly", store => store.get(key)); }
  catch { return legacy.read(); }
  const legacyValue = await readLegacy(legacy);
  if (stored === undefined) return legacyValue;
  const record = asRecord(stored);
  if (legacyValue !== null && legacyValue !== undefined && !record.legacyStale) return legacyValue;
  return record.deleted ? null : record.value;
}

function fitsLegacy(value: unknown, maxChars = LEGACY_FALLBACK_MAX_CHARS): boolean {
  try { return (JSON.stringify(value) ?? "").length <= maxChars; } catch { return false; }
}

async function writeDurable(connection: IdbConnection, key: string, value: unknown, legacy: LegacySlot, small: (value: unknown) => boolean = fitsLegacy): Promise<void> {
  try {
    await run(connection, "readwrite", store => store.put({ geodeDurable: 1, value } satisfies DurableRecord, key));
  } catch (error) {
    // IndexedDB is unavailable or full. A small value still fits next to settings; the newer legacy copy wins on read.
    if (!small(value)) throw error;
    await legacy.write(value);
    return;
  }
  await clearLegacy(connection, key, legacy, { geodeDurable: 1, value, legacyStale: true });
}

/**
 * Empties the legacy copy after IndexedDB holds the value. Emptying rewrites the whole snapshot and can itself throw;
 * that never fails the write that already succeeded, but the record then notes that the legacy copy is stale.
 */
async function clearLegacy(connection: IdbConnection, key: string, legacy: LegacySlot, staleRecord: DurableRecord): Promise<void> {
  if ((await readLegacy(legacy)) === null) return;
  try { await legacy.clear(); }
  catch { await run(connection, "readwrite", store => store.put(staleRecord, key)).catch(() => {}); }
}

export function createIdbDeviceState(legacy: DeviceStateService, source: IDBFactory | IdbConnection | undefined = indexedDB): DeviceStateService {
  const connection = toConnection(source);
  const slot = (key: string): LegacySlot => ({
    read: () => legacy.read(key),
    write: value => legacy.write(key, value),
    clear: () => legacy.remove(key),
  });
  return {
    read: async <T>(key: string) => (await readDurable(connection, key, slot(key)) ?? null) as T | null,
    write: (key, value) => writeDurable(connection, key, value, slot(key)),
    remove: async key => {
      try {
        await run(connection, "readwrite", store => store.delete(key));
      } catch (error) {
        // IndexedDB is unavailable: a value can only have been written to legacy (the fallback), so remove it there.
        await legacy.remove(key).catch(() => { throw error; });
        return;
      }
      await clearLegacy(connection, key, slot(key), { geodeDurable: 1, value: null, deleted: true, legacyStale: true });
    },
  };
}

const CONFIG_KEY_PREFIX = "config:";
const RECONCILE_CONFIG_PREFIX = "device-reconcile:";

/**
 * Config keys that live in IndexedDB instead of the host's localStorage snapshot. Only the derived reconcile manifest:
 * it grows with the vault (one entry per file) and was the value that pushed the 5 MB snapshot over its cap
 * ("save-manifest" failures on iOS). Everything else is small and is also read through the portable config by sync-safety,
 * so it stays where it is.
 */
export function isLargeDerivedConfigKey(name: string): boolean {
  return name.startsWith(RECONCILE_CONFIG_PREFIX);
}

/**
 * Config whose large derived keys are stored in IndexedDB. Reads fall back to the legacy store so a manifest written
 * by an earlier build is still found; a write moves the value and then empties the legacy copy (best effort) so the
 * localStorage snapshot shrinks and stops crowding out settings.
 */
export function createIdbConfig(legacy: ConfigService, source: IDBFactory | IdbConnection | undefined = indexedDB, shouldStore: (name: string) => boolean = isLargeDerivedConfigKey): ConfigService {
  const connection = toConnection(source);
  const slot = (name: string): LegacySlot => ({
    read: () => legacy.read(name),
    write: value => legacy.write(name, value),
    clear: () => legacy.write(name, null),
  });
  return {
    read: async name => shouldStore(name) ? readDurable(connection, CONFIG_KEY_PREFIX + name, slot(name)) : legacy.read(name),
    write: (name, data) => shouldStore(name) ? writeDurable(connection, CONFIG_KEY_PREFIX + name, data, slot(name)) : legacy.write(name, data),
  };
}

const METADATA_KEY_PREFIX = "metadata-cache:";
const METADATA_LEGACY_MAX_ENTRIES = 500;
const METADATA_RETRY_INITIAL_MS = 60_000;
const METADATA_RETRY_MAX_MS = 30 * 60_000;

export function metadataCacheKey(vaultId: string): string {
  return METADATA_KEY_PREFIX + encodeURIComponent(vaultId);
}

/** A fixed identifier for a storage failure: safe to log (never a message, path, or note text). */
export function storageFailureCode(error: unknown): string {
  if (isQuotaExceeded(error)) return "STORAGE_QUOTA_EXCEEDED";
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  const known = ["NotSupportedError", "TimeoutError", "UnknownError", "InvalidStateError", "DataCloneError", "AbortError", "VersionError", "NotFoundError", "SecurityError", "TransactionInactiveError"];
  return typeof name === "string" && known.includes(name) ? name : "UNKNOWN";
}

function smallMetadataCache(value: unknown): boolean {
  const entries = value && typeof value === "object" ? (value as { entries?: unknown }).entries : undefined;
  if (entries && typeof entries === "object" && Object.keys(entries).length > METADATA_LEGACY_MAX_ENTRIES) return false;
  return fitsLegacy(value);
}

/**
 * The metadata cache, per vault, in IndexedDB. It is derived from the notes, so a failed write is never an error for
 * the user: it is logged once with a diagnostic category and the cache is rebuilt from the notes on a later launch.
 * After a failure, writes back off (1 minute, doubling to 30 minutes) instead of re-serializing a vault-sized cache
 * into a store that just rejected it.
 */
export function createIdbMetadataIndex(
  legacy: MetadataIndexService,
  source: IDBFactory | IdbConnection | undefined,
  activeVault: () => string | null,
  now: () => number = Date.now,
): MetadataIndexService {
  const connection = toConnection(source);
  const slot: LegacySlot = {
    read: () => legacy.readCache(),
    write: value => legacy.writeCache(value),
    clear: () => legacy.writeCache(null),
  };
  let failures = 0;
  let retryAt = 0;
  return {
    ...legacy,
    readCache: async () => {
      const vault = activeVault();
      if (!vault) return legacy.readCache();
      try { return await readDurable(connection, metadataCacheKey(vault), slot); }
      catch { return null; }
    },
    writeCache: async data => {
      const vault = activeVault();
      if (!vault || now() < retryAt) return;
      try {
        await writeDurable(connection, metadataCacheKey(vault), data, slot, smallMetadataCache);
        failures = 0;
        retryAt = 0;
      } catch (error) {
        const delay = Math.min(METADATA_RETRY_MAX_MS, METADATA_RETRY_INITIAL_MS * 2 ** failures);
        failures += 1;
        retryAt = now() + delay;
        console.warn(`[geode] metadata cache not saved (${storageFailureCode(error)}); it will be rebuilt from your notes. Next save attempt in ${Math.round(delay / 1000)} s.`);
      }
    },
  };
}

/** Which vault a per-vault IndexedDB key belongs to, or null for keys that are not per vault. */
function vaultOfRecord(key: string): string | null {
  const prefix = [CONFIG_KEY_PREFIX + RECONCILE_CONFIG_PREFIX, METADATA_KEY_PREFIX].find(candidate => key.startsWith(candidate));
  if (!prefix) return null;
  try { return decodeURIComponent(key.slice(prefix.length)); } catch { return null; }
}

/**
 * Deletes the derived per-vault records (reconcile manifest, metadata cache) of vaults that are no longer registered:
 * each can be megabytes and nothing would ever read them again. Notes are never touched; a vault that is added back
 * simply rebuilds them. Does nothing if the registry cannot be read.
 */
export async function pruneUnregisteredVaultRecords(
  source: IDBFactory | IdbConnection | undefined,
  registeredVaults: () => Promise<Iterable<string>>,
  legacyConfig?: { names(): Iterable<string>; config: ConfigService },
): Promise<number> {
  let registered: Set<string>;
  try { registered = new Set(await registeredVaults()); } catch { return 0; }
  registered.add("managed://default");
  const connection = toConnection(source);
  let removed = 0;
  try {
    const keys = await run(connection, "readonly", store => store.getAllKeys());
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const vault = vaultOfRecord(key);
      if (vault === null || registered.has(vault)) continue;
      await run(connection, "readwrite", store => store.delete(key));
      removed += 1;
    }
  } catch { /* IndexedDB unavailable: nothing stored there to prune */ }
  if (legacyConfig) {
    for (const name of [...legacyConfig.names()]) {
      if (!name.startsWith(RECONCILE_CONFIG_PREFIX)) continue;
      let vault: string;
      try { vault = decodeURIComponent(name.slice(RECONCILE_CONFIG_PREFIX.length)); } catch { continue; }
      if (registered.has(vault)) continue;
      try {
        if ((await legacyConfig.config.read(name)) === null) continue;
        await legacyConfig.config.write(name, null);
        removed += 1;
      } catch { /* best effort */ }
    }
  }
  return removed;
}
