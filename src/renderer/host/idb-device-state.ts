import type { ConfigService, DeviceStateService } from "./contracts";

/**
 * Device state backed by IndexedDB. The browser host snapshots all of its state
 * into one localStorage value, which iOS caps at about 5 MB; the per-file sync
 * history of a real vault overflows that ("The quota has been exceeded").
 * IndexedDB has no such cap. Reads fall back to `legacy` so state written
 * before this store existed (hub settings, sync progress) is still found, and
 * a write or remove clears the legacy copy so the old snapshot shrinks.
 */
const DB_NAME = "geode-device-state";
const STORE = "kv";

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

export function createIdbDeviceState(legacy: DeviceStateService, factory: IDBFactory = indexedDB): DeviceStateService {
  const db = openDb(factory);
  // Removing a legacy key rewrites the browser host's whole localStorage snapshot (which also carries the metadata
  // cache and grows with the vault). That rewrite can itself throw QuotaExceededError, so only touch legacy when it
  // really holds the key, and never let a failed cleanup fail the write that already succeeded in IndexedDB.
  const dropLegacy = async (key: string): Promise<void> => {
    try { if ((await legacy.read(key)) !== null) await legacy.remove(key); } catch { /* the IndexedDB value is the one that counts */ }
  };
  return {
    read: async <T>(key: string) => {
      const stored = await run(await db, "readonly", store => store.get(key));
      return stored === undefined ? legacy.read<T>(key) : (stored as T);
    },
    write: async (key, value) => {
      await run(await db, "readwrite", store => store.put(value, key));
      await dropLegacy(key);
    },
    remove: async key => {
      await run(await db, "readwrite", store => store.delete(key));
      await dropLegacy(key);
    },
  };
}

const CONFIG_KEY_PREFIX = "config:";

/**
 * Config keys that live in IndexedDB instead of the host's localStorage snapshot. Only the derived reconcile manifest:
 * it grows with the vault (one entry per file) and was the value that pushed the 5 MB snapshot over its cap
 * ("save-manifest" failures on iOS). Everything else is small and is also read through the portable config by sync-safety,
 * so it stays where it is.
 */
export function isLargeDerivedConfigKey(name: string): boolean {
  return name.startsWith("device-reconcile:");
}

/**
 * Config whose large derived keys are stored in IndexedDB. Reads fall back to the legacy store so a manifest written
 * by an earlier build is still found; a write moves the value and then empties the legacy copy (best effort) so the
 * localStorage snapshot shrinks and stops crowding out settings.
 */
export function createIdbConfig(legacy: ConfigService, factory: IDBFactory = indexedDB, shouldStore: (name: string) => boolean = isLargeDerivedConfigKey): ConfigService {
  const db = openDb(factory);
  const dropLegacy = async (name: string): Promise<void> => {
    try { if ((await legacy.read(name)) !== null) await legacy.write(name, null); } catch { /* the IndexedDB value is the one that counts */ }
  };
  return {
    read: async name => {
      if (!shouldStore(name)) return legacy.read(name);
      let stored: unknown;
      try { stored = await run(await db, "readonly", store => store.get(CONFIG_KEY_PREFIX + name)); } catch { return legacy.read(name); }
      return stored === undefined ? legacy.read(name) : stored;
    },
    write: async (name, data) => {
      if (!shouldStore(name)) return legacy.write(name, data);
      await run(await db, "readwrite", store => store.put(data, CONFIG_KEY_PREFIX + name));
      await dropLegacy(name);
    },
  };
}
