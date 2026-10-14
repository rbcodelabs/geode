import { describe, expect, it } from "vitest";
import type { DeviceStateService } from "../../src/renderer/host/contracts";
import { createIdbDeviceState } from "../../src/renderer/host/idb-device-state";

/** Just enough IndexedDB for one object store: open/upgrade, get/put/delete inside a transaction. */
function fakeIdb(): IDBFactory {
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

function legacyStore(options: { removeThrows?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const calls = { remove: 0 };
  const service: DeviceStateService = {
    read: async <T>(key: string) => (values.has(key) ? (values.get(key) as T) : null),
    write: async (key, value) => { values.set(key, value); },
    remove: async key => { calls.remove++; if (options.removeThrows) throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); values.delete(key); },
  };
  return { service, values, calls };
}

describe("IndexedDB device state", () => {
  it("round-trips values and does not touch the legacy store when it does not hold the key", async () => {
    const legacy = legacyStore();
    const state = createIdbDeviceState(legacy.service, fakeIdb());
    await state.write("k", { a: 1 });
    expect(await state.read("k")).toEqual({ a: 1 });
    await state.remove("k");
    expect(await state.read("k")).toBeNull();
    expect(legacy.calls.remove).toBe(0);
  });

  it("falls back to a legacy value and clears it on the next write", async () => {
    const legacy = legacyStore();
    legacy.values.set("old", { v: "legacy" });
    const state = createIdbDeviceState(legacy.service, fakeIdb());
    expect(await state.read("old")).toEqual({ v: "legacy" });
    await state.write("old", { v: "new" });
    expect(await state.read("old")).toEqual({ v: "new" });
    expect(legacy.values.has("old")).toBe(false);
  });

  it("does not fail a write when the legacy cleanup hits the localStorage quota", async () => {
    const legacy = legacyStore({ removeThrows: true });
    legacy.values.set("k", { v: "legacy" });
    const state = createIdbDeviceState(legacy.service, fakeIdb());
    await expect(state.write("k", { v: "new" })).resolves.toBeUndefined();
    expect(await state.read("k")).toEqual({ v: "new" });
  });
});
