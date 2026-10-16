import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_HOST_STORAGE_KEY, createBrowserHost, createBrowserHostState, type BrowserHostStorage } from "../../src/renderer/host/browser-host";
import { createCapacitorHost } from "../../src/renderer/host/capacitor-host";
import { withDurableMobileStorage } from "../../src/renderer/host/mobile-storage";
import { createIdbConfig, createIdbDeviceState, pruneUnregisteredVaultRecords, createIdbConnection } from "../../src/renderer/host/idb-device-state";
import { buildVaultManifest } from "../../src/renderer/reconciliation";
import { extractMentionIndexKeys, METADATA_CACHE_SCHEMA_VERSION } from "../../src/renderer/metadata-cache";
import { parseMetadata } from "../../src/wiki/metadata";
import { FakeManagedVault } from "../helpers/fake-managed-vault";
import { fakeIdb, type FakeIdb } from "../helpers/fake-idb";

/**
 * After #370 moved the reconcile manifest out, the browser host's single localStorage snapshot (about 5 MB on iOS,
 * shared with every other localStorage key of the origin) still carries the metadata cache, which grows with every
 * note: about 2.5 K characters per realistic note, so a few thousand notes fill it. Most tests use a scaled-down cap;
 * the scale scenario uses the real one with real parsed notes.
 */
const SCALED_QUOTA = 200_000;
const WEBKIT_QUOTA = 5_000_000;

function quotaStorage(quota = SCALED_QUOTA): BrowserHostStorage & { values: Map<string, string>; rejected: number } {
  const values = new Map<string, string>();
  const storage = {
    values,
    rejected: 0,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const total = [...values].reduce((sum, [k, v]) => sum + (k === key ? 0 : k.length + v.length), 0) + key.length + value.length;
      if (total > quota) { storage.rejected++; throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); }
      values.set(key, value);
    },
  };
  return storage;
}

function noteText(i: number, n: number): string {
  return `---\ntags: [project, area-${i % 40}]\ncreated: 2026-01-01\n---\n# Meeting notes ${i}\n\nDiscussed [[Meeting notes ${(i + 1) % n}]] and [[Project ${i % 50}]] with the team. #status/open\n\n## Actions\n- [ ] Follow up on [[Meeting notes ${(i * 7) % n}]]\n- Review the budget for next quarter\n`;
}

/** The shape MetadataCache.persistCache hands the mobile host: one entry per markdown file. */
function metadataCache(count: number, parsed = false) {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const text = noteText(i, count);
    entries[`Projects/Area ${i % 60}/Meeting notes ${i}.md`] = parsed
      ? { mtimeMs: 1_760_000_000_000 + i, size: text.length, metadata: parseMetadata(text), mentionKeys: extractMentionIndexKeys(text) }
      : { mtimeMs: 1_760_000_000_000 + i, size: 900, metadata: { links: [{ link: `Meeting notes ${i + 1}`, original: `[[Meeting notes ${i + 1}]]` }], headings: [{ heading: `Meeting notes ${i}`, level: 1 }] } };
  }
  return { schemaVersion: METADATA_CACHE_SCHEMA_VERSION, entries };
}

function snapshotOf(storage: { values: Map<string, string> }) {
  return JSON.parse(storage.values.get(BROWSER_HOST_STORAGE_KEY)!) as { metadataCache: unknown; config: Array<[string, unknown]> };
}

async function phone(options: { storage?: ReturnType<typeof quotaStorage>; idb?: FakeIdb; vaults?: string[]; open?: string; registered?: string[] } = {}) {
  const storage = options.storage ?? quotaStorage();
  const idb = options.idb ?? fakeIdb();
  const native = new FakeManagedVault("managed://default");
  const state = createBrowserHostState({ storage });
  const portable = createBrowserHost(state);
  const capacitor = createCapacitorHost(native.plugin, portable);
  const registered = options.registered ?? ["managed://default"];
  const prunes: Array<() => void> = [];
  const host = withDurableMobileStorage({
    ...capacitor,
    vaultRegistry: {
      ...capacitor.vaultRegistry,
      openVault: async (id: string) => ({ root: id, name: id }),
      getRecentVaults: async () => registered,
    },
  }, idb, { legacyConfigNames: () => state.config.keys(), schedulePrune: task => { prunes.push(task); } });
  await host.vaultRegistry.openVault(options.open ?? "managed://default");
  return { host, portable, storage, idb, state, prunes, runPrunes: async () => { for (const task of prunes.splice(0)) await task(); } };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("metadata cache on a phone", () => {
  it("scale: 6,000 real parsed notes overflow WebKit's 5 MB localStorage cap in the plain browser host", async () => {
    const storage = quotaStorage(WEBKIT_QUOTA);
    const portable = createBrowserHost(createBrowserHostState({ storage }));
    await portable.vaultRegistry.openVault("managed://default");
    await expect(portable.metadataIndex.writeCache(metadataCache(6000, true))).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("scale: the same 6,000-note cache goes to IndexedDB on native iOS; settings persist and the snapshot stays small", async () => {
    const storage = quotaStorage(WEBKIT_QUOTA);
    const first = await phone({ storage });
    const cache = metadataCache(6000, true);
    await expect(first.host.metadataIndex.writeCache(cache)).resolves.toBeUndefined();
    await first.host.config.write("app", { baseFontSize: 18 });
    expect(storage.values.get(BROWSER_HOST_STORAGE_KEY)!.length).toBeLessThan(10_000);
    expect(snapshotOf(storage).metadataCache).toBeNull();

    // Relaunch: a new page over the same localStorage and IndexedDB.
    const second = await phone({ storage, idb: first.idb });
    expect(await second.host.config.read("app")).toEqual({ baseFontSize: 18 });
    const restored = await second.host.metadataIndex.readCache() as { entries: Record<string, unknown> };
    expect(Object.keys(restored.entries)).toHaveLength(6000);
  });

  it("scale: 60,000 notes are stored without touching localStorage", async () => {
    const storage = quotaStorage(WEBKIT_QUOTA);
    const { host } = await phone({ storage });
    await expect(host.metadataIndex.writeCache(metadataCache(60_000))).resolves.toBeUndefined();
    expect(storage.rejected).toBe(0);
    expect(Object.keys((await host.metadataIndex.readCache() as { entries: object }).entries)).toHaveLength(60_000);
  });

  it("migrates a legacy localStorage copy on the first write and frees the snapshot", async () => {
    const storage = quotaStorage();
    const legacyHost = createBrowserHost(createBrowserHostState({ storage }));
    await legacyHost.vaultRegistry.openVault("managed://default");
    await legacyHost.metadataIndex.writeCache(metadataCache(300));
    const before = storage.values.get(BROWSER_HOST_STORAGE_KEY)!.length;

    const { host } = await phone({ storage });
    // Before any write the legacy copy is still found, so the first launch after the update is not a cold index.
    expect(Object.keys((await host.metadataIndex.readCache() as { entries: object }).entries)).toHaveLength(300);
    await host.metadataIndex.writeCache(metadataCache(301));
    expect(snapshotOf(storage).metadataCache).toBeNull();
    expect(storage.values.get(BROWSER_HOST_STORAGE_KEY)!.length).toBeLessThan(before / 10);
    expect(Object.keys((await host.metadataIndex.readCache() as { entries: object }).entries)).toHaveLength(301);
  });

  it("keeps one cache per vault", async () => {
    const idb = fakeIdb();
    const storage = quotaStorage();
    const a = await phone({ storage, idb, open: "managed://default", registered: ["managed://default", "external://b"] });
    await a.host.metadataIndex.writeCache(metadataCache(3));
    await a.host.vaultRegistry.openVault("external://b");
    expect(await a.host.metadataIndex.readCache()).toBeNull();
    await a.host.metadataIndex.writeCache(metadataCache(5));
    await a.host.vaultRegistry.openVault("managed://default");
    expect(Object.keys((await a.host.metadataIndex.readCache() as { entries: object }).entries)).toHaveLength(3);
  });

  it("a failed cache write never rejects: it logs a diagnostic category once and backs off instead of retrying every call", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const idb = fakeIdb({ failPut: key => key.startsWith("metadata-cache:") ? new DOMException("quota", "QuotaExceededError") : undefined });
    const { host } = await phone({ idb });
    await expect(host.metadataIndex.writeCache(metadataCache(3000))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("STORAGE_QUOTA_EXCEEDED");
    expect(String(warn.mock.calls[0][0])).not.toMatch(/Meeting notes/);
    const puts = idb.calls.put;
    await host.metadataIndex.writeCache(metadataCache(3000));
    await host.metadataIndex.writeCache(metadataCache(3000));
    expect(idb.calls.put).toBe(puts);
    expect(warn).toHaveBeenCalledTimes(1);

    // Later, the next attempt is allowed and succeeds once space is available.
    idb.options.failPut = undefined;
    vi.setSystemTime(1_000_000 + 10 * 60_000);
    await host.metadataIndex.writeCache(metadataCache(3000));
    expect(Object.keys((await host.metadataIndex.readCache() as { entries: object }).entries)).toHaveLength(3000);
  });

  it("a failed cache write does not leave the oversized cache crowding out settings", async () => {
    const storage = quotaStorage();
    const { host } = await phone({ storage, idb: fakeIdb({ failOpens: 99 }) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(host.metadataIndex.writeCache(metadataCache(3000))).resolves.toBeUndefined();
    await expect(host.config.write("app", { baseFontSize: 20 })).resolves.toBeUndefined();
    expect(snapshotOf(storage).metadataCache).toBeNull();
  });
});

describe("IndexedDB availability", () => {
  it("falls back to localStorage for small payloads when IndexedDB cannot open, and still rejects vault-sized ones", async () => {
    const storage = quotaStorage();
    const { host } = await phone({ storage, idb: fakeIdb({ failOpens: 99 }) });
    const key = `device-reconcile:${encodeURIComponent("managed://default")}`;
    const small = buildVaultManifest("managed://default", [{ path: "a.md", isFolder: false, mtime: 1, ctime: 1, size: 1 }]);
    await expect(host.config.write(key, small)).resolves.toBeUndefined();
    expect(await host.config.read(key)).toEqual(small);
    await expect(host.deviceState.write("sync:progress", { cursor: 3 })).resolves.toBeUndefined();
    expect(await host.deviceState.read("sync:progress")).toEqual({ cursor: 3 });
    const vaultSized = buildVaultManifest("managed://default", Array.from({ length: 30_000 }, (_, i) => ({ path: `n${i}.md`, isFolder: false, mtime: i, ctime: 1, size: 1 })));
    await expect(host.config.write(key, vaultSized)).rejects.toBeTruthy();
  });

  it("small metadata caches use the localStorage fallback too, so small vaults keep a warm start without IndexedDB", async () => {
    const { host } = await phone({ idb: fakeIdb({ failOpens: 99 }) });
    await host.metadataIndex.writeCache(metadataCache(10));
    expect(Object.keys((await host.metadataIndex.readCache() as { entries: object }).entries)).toHaveLength(10);
  });

  it("does not cache a rejected open: the next use opens again", async () => {
    const idb = fakeIdb({ failOpens: 1 });
    const legacyValues = new Map<string, unknown>();
    const config = createIdbConfig({ read: async name => legacyValues.get(name) ?? null, write: async (name, data) => { legacyValues.set(name, data); } }, idb);
    await config.write("device-reconcile:x", { first: true });
    expect(legacyValues.get("device-reconcile:x")).toEqual({ first: true });
    await config.write("device-reconcile:x", { second: true });
    expect(idb.calls.open).toBe(2);
    expect(await config.read("device-reconcile:x")).toEqual({ second: true });
    // The IndexedDB write emptied the fallback copy.
    expect(legacyValues.get("device-reconcile:x")).toBeNull();
  });

  it("does not create a rejected open eagerly (no unhandled rejection before first use)", async () => {
    const idb = fakeIdb({ failOpens: 1 });
    createIdbDeviceState({ read: async () => null, write: async () => {}, remove: async () => {} }, idb);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(idb.calls.open).toBe(0);
  });

  it("an open that never settles times out and falls back instead of hanging every read", async () => {
    const idb = fakeIdb({ hangOpen: true });
    const legacyValues = new Map<string, unknown>([["device-reconcile:x", { legacy: true }]]);
    const config = createIdbConfig({ read: async name => legacyValues.get(name) ?? null, write: async (name, data) => { legacyValues.set(name, data); } }, createIdbConnection(idb, 20));
    expect(await config.read("device-reconcile:x")).toEqual({ legacy: true });
    // A hung open is not retried on every read: the next reads fail fast to the fallback for a while.
    const started = Date.now();
    expect(await config.read("device-reconcile:x")).toEqual({ legacy: true });
    expect(Date.now() - started).toBeLessThan(15);
    expect(idb.calls.open).toBe(1);
  });

  it("reopens once when WebKit drops an open connection, and the request still succeeds", async () => {
    const idb = fakeIdb();
    const state = createIdbDeviceState({ read: async () => null, write: async () => {}, remove: async () => {} }, idb);
    await state.write("k", { v: 1 });
    idb.options.failTransactions = 1;
    expect(await state.read("k")).toEqual({ v: 1 });
    expect(idb.calls.open).toBe(2);
  });
});

describe("downgrade and upgrade", () => {
  it("prefers a legacy value written by an older build after this build's IndexedDB record (newest wins)", async () => {
    const storage = quotaStorage();
    const key = `device-reconcile:${encodeURIComponent("managed://default")}`;
    const older = buildVaultManifest("managed://default", [{ path: "old.md", isFolder: false, mtime: 1, ctime: 1, size: 1 }]);
    const newer = buildVaultManifest("managed://default", [{ path: "new.md", isFolder: false, mtime: 2, ctime: 1, size: 1 }]);
    const first = await phone({ storage });
    await first.host.config.write(key, older);
    // An older build (no IndexedDB config) runs and writes the manifest into the snapshot again.
    const oldBuild = createBrowserHost(createBrowserHostState({ storage }));
    await oldBuild.config.write(key, newer);
    const second = await phone({ storage, idb: first.idb });
    expect(await second.host.config.read(key)).toEqual(newer);
    // The next write settles it back in IndexedDB.
    await second.host.config.write(key, older);
    expect(await second.host.config.read(key)).toEqual(older);
    expect(await second.portable.config.read(key)).toBeNull();
  });

  it("ignores a legacy copy it could not clear, so a stale baseline does not win", async () => {
    const legacyValues = new Map<string, unknown>([["k", { v: "stale" }]]);
    const state = createIdbDeviceState({
      read: async <T>(key: string) => (legacyValues.get(key) ?? null) as T,
      write: async (key, value) => { legacyValues.set(key, value); },
      remove: async () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
    }, fakeIdb());
    await state.write("k", { v: "new" });
    expect(await state.read("k")).toEqual({ v: "new" });
  });

  it("still reads records written by #370 (raw, untagged values)", async () => {
    const idb = fakeIdb();
    idb.data.set("config:device-reconcile:x", { version: 1, raw: true });
    const config = createIdbConfig({ read: async () => null, write: async () => {} }, idb);
    expect(await config.read("device-reconcile:x")).toEqual({ version: 1, raw: true });
  });
});

describe("pruning vaults that are no longer registered", () => {
  it("removes IndexedDB and legacy records of unregistered vaults, keeping registered and active ones", async () => {
    const storage = quotaStorage();
    const idb = fakeIdb();
    const gone = encodeURIComponent("external://gone");
    const kept = encodeURIComponent("external://kept");
    idb.data.set(`config:device-reconcile:${gone}`, { version: 1 });
    idb.data.set(`config:device-reconcile:${kept}`, { version: 1 });
    idb.data.set(`metadata-cache:${gone}`, { geodeDurable: 1, value: {} });
    idb.data.set(`metadata-cache:${encodeURIComponent("external://active")}`, { geodeDurable: 1, value: {} });
    idb.data.set("sync:unrelated", 1);
    const legacy = createBrowserHost(createBrowserHostState({ storage }));
    await legacy.config.write(`device-reconcile:${gone}`, { version: 1, entries: { a: 1 } });
    await legacy.config.write("app", { baseFontSize: 16 });

    const { runPrunes, portable } = await phone({ storage, idb, open: "external://active", registered: ["managed://default", "external://kept"] });
    await runPrunes();
    expect([...idb.data.keys()].sort()).toEqual([`config:device-reconcile:${kept}`, `metadata-cache:${encodeURIComponent("external://active")}`, "sync:unrelated"].sort());
    expect(await portable.config.read(`device-reconcile:${gone}`)).toBeNull();
    expect(await portable.config.read("app")).toEqual({ baseFontSize: 16 });
  });

  it("prunes nothing when the registry cannot be read", async () => {
    const idb = fakeIdb();
    idb.data.set("metadata-cache:x", { geodeDurable: 1, value: {} });
    await pruneUnregisteredVaultRecords(createIdbConnection(idb), async () => { throw new Error("registry unavailable"); });
    expect(idb.data.has("metadata-cache:x")).toBe(true);
  });

  it("is scheduled once per launch, after the first vault opens", async () => {
    const { host, prunes } = await phone({ registered: ["managed://default", "external://b"] });
    await host.vaultRegistry.openVault("external://b");
    expect(prunes).toHaveLength(1);
  });
});
