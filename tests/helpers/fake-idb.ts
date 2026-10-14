/** Just enough IndexedDB for one object store: open/upgrade, get/put/delete inside a transaction. */
export function fakeIdb(): IDBFactory {
  const data = new Map<string, unknown>();
  const store = (tx: { oncomplete: (() => void) | null }) => {
    const request = (result: unknown): IDBRequest => {
      const req = { result, onsuccess: null as null | (() => void) } as unknown as IDBRequest;
      queueMicrotask(() => { (req as any).onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
      return req;
    };
    return {
      get: (key: string) => request(data.get(key)),
      put: (value: unknown, key: string) => { data.set(key, value); return request(key); },
      delete: (key: string) => { data.delete(key); return request(undefined); },
    };
  };
  const db = { createObjectStore: () => undefined, transaction: () => { const tx: any = { oncomplete: null, error: null }; tx.objectStore = () => store(tx); return tx; } };
  return {
    open: () => {
      const req: any = { result: db, error: null };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  } as unknown as IDBFactory;
}
