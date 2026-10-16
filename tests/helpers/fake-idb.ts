export interface FakeIdbOptions {
  /** The first N `open` calls fail (a transient WebKit failure, a blocked upgrade, private-mode restrictions). */
  failOpens?: number;
  /** `open` never settles (the WKWebView "IndexedDB hangs after relaunch" failure). */
  hangOpen?: boolean;
  /** The next N `db.transaction` calls throw, as WebKit does after it drops the connection. */
  failTransactions?: number;
  /** Return an error to abort a `put` (for example a QuotaExceededError), or nothing to let it land. */
  failPut?: (key: string, value: unknown) => Error | undefined;
}

export type FakeIdb = IDBFactory & {
  /** The object store's contents, by key. Values are stored by reference (no structured clone). */
  readonly data: Map<string, unknown>;
  readonly calls: { open: number; put: number; get: number; delete: number; getAllKeys: number };
  options: FakeIdbOptions;
};

/** Just enough IndexedDB for one object store: open/upgrade, get/put/delete/getAllKeys inside a transaction. */
export function fakeIdb(options: FakeIdbOptions = {}): FakeIdb {
  const data = new Map<string, unknown>();
  const calls = { open: 0, put: 0, get: 0, delete: 0, getAllKeys: 0 };
  const factory = { data, calls, options } as unknown as FakeIdb;
  const store = (tx: { oncomplete: (() => void) | null; onabort: (() => void) | null; error: unknown }) => {
    const request = (result: unknown): IDBRequest => {
      const req = { result, onsuccess: null as null | (() => void) } as unknown as IDBRequest;
      queueMicrotask(() => { (req as any).onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
      return req;
    };
    return {
      get: (key: string) => { calls.get++; return request(data.get(key)); },
      put: (value: unknown, key: string) => {
        calls.put++;
        const error = factory.options.failPut?.(key, value);
        if (error) {
          const req = { result: undefined, onsuccess: null } as unknown as IDBRequest;
          queueMicrotask(() => { tx.error = error; tx.onabort?.(); });
          return req;
        }
        data.set(key, value);
        return request(key);
      },
      delete: (key: string) => { calls.delete++; data.delete(key); return request(undefined); },
      getAllKeys: () => { calls.getAllKeys++; return request([...data.keys()]); },
    };
  };
  const db = {
    createObjectStore: () => undefined,
    close: () => undefined,
    transaction: () => {
      if ((factory.options.failTransactions ?? 0) > 0) { factory.options.failTransactions!--; throw new DOMException("The database connection is closing.", "InvalidStateError"); }
      const tx: any = { oncomplete: null, onabort: null, onerror: null, error: null }; tx.objectStore = () => store(tx); return tx;
    },
  };
  (factory as any).open = () => {
    calls.open++;
    const req: any = { result: db, error: null };
    if (factory.options.hangOpen) return req;
    if ((factory.options.failOpens ?? 0) > 0) {
      factory.options.failOpens!--;
      queueMicrotask(() => { req.error = new DOMException("Internal error opening backing store for indexedDB.open.", "UnknownError"); req.onerror?.(); });
      return req;
    }
    queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
    return req;
  };
  return factory;
}
