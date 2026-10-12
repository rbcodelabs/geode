import type { DeviceStateService } from "./contracts";

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
  return {
    read: async <T>(key: string) => {
      const stored = await run(await db, "readonly", store => store.get(key));
      return stored === undefined ? legacy.read<T>(key) : (stored as T);
    },
    write: async (key, value) => {
      await run(await db, "readwrite", store => store.put(value, key));
      await legacy.remove(key);
    },
    remove: async key => {
      await run(await db, "readwrite", store => store.delete(key));
      await legacy.remove(key);
    },
  };
}
