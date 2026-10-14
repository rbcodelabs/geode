import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import { createCapacitorHost } from "../../src/renderer/host/capacitor-host";
import type { HashCacheEntry, HashCacheService } from "../../src/renderer/host/contracts";
import { HUB_PROVIDER_ID, HubSyncProvider } from "../../src/renderer/sync/hub-provider";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { hubTokenKey } from "../../src/shared/hub-sync";
import { startHttpStoreServer, type HttpStoreServer } from "../../src/sync-node/index";
import { appDevice, rmrf, tmpDir } from "../helpers/app-hub-harness";
import { FakeManagedVault } from "../helpers/fake-managed-vault";
import { put } from "../helpers/node-host-harness";
import { HTTP_TEST_TOKEN } from "../helpers/sync-store-harness";

vi.setConfig({ testTimeout: 180_000 });
const ROOT = "managed://default";
const FILES = Number(process.env.IDLE_FILES ?? 300);

export function memoryHashCache(): HashCacheService & { rows: Map<string, HashCacheEntry> } {
  const rows = new Map<string, HashCacheEntry>();
  return { rows, readAll: async () => Object.fromEntries(rows), upsertBatch: async entries => { for (const [path, entry] of Object.entries(entries)) rows.set(path, entry); }, prune: async keep => { const set = new Set(keep); for (const path of [...rows.keys()]) if (!set.has(path)) rows.delete(path); } };
}

describe("an idle sync cycle on the phone", () => {
  const cleanups: string[] = [], servers: HttpStoreServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of cleanups.splice(0)) rmrf(d); });

  async function setup(cache?: ReturnType<typeof memoryHashCache>) {
    const dir = (p: string) => { const d = tmpDir(p); cleanups.push(d); return d; };
    const server = await startHttpStoreServer({ store: dir("hub"), token: HTTP_TEST_TOKEN, port: 0, pingIntervalMs: 60_000 }); servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/`;
    const desk = appDevice({ vault: dir("v"), userData: dir("u"), noBridge: true, ignorePortableConfig: true, providerOptions: { secrets: { available: true, get: async () => HTTP_TEST_TOKEN, set: async () => {}, remove: async () => {} }, http: { allowInsecure: true } } });
    for (let i = 0; i < FILES; i++) put(desk.vault, `Folder${i % 10}/Sub/Note ${i}.md`, `# note ${i}\n` + "x".repeat(300));
    await desk.configureUnchecked({ kind: "http", url }, true); await desk.connect({ create: "Wiki" }); await desk.firstSync();

    const native = new FakeManagedVault(ROOT);
    const counts = new Map<string, number>();
    const counted = new Proxy(native.plugin, { get(target, prop, receiver) { const v = Reflect.get(target, prop, receiver); return typeof v === "function" && typeof prop === "string" ? (...a: unknown[]) => { counts.set(prop, (counts.get(prop) ?? 0) + 1); return v.apply(target, a); } : v; } });
    const host = createCapacitorHost(counted, createBrowserHost(createBrowserHostState()), cache ? { hashCache: () => cache } : undefined);
    await host.vaultRegistry.openVault(ROOT);
    await host.secrets.app!.set(hubTokenKey(url), HTTP_TEST_TOKEN);
    const app = host.secrets.app!;
    const provider = new HubSyncProvider(undefined, host.deviceState, () => ROOT, { secrets: { available: true, get: k => app.get(k), set: (k, v) => app.set(k, v), remove: k => app.remove(k) }, http: { allowInsecure: true } });
    const service = new SyncService(host, () => ROOT);
    await host.deviceState.write(`sync-hub/config/${ROOT}`, { schema: 1, target: { kind: "http", url }, create: false });
    service.register("geode", provider); await service.activate(HUB_PROVIDER_ID);
    const [descriptor] = await service.discoverVaults(); await service.joinVault(descriptor);
    await service.preview(); await service.run({ approvePreview: true }); await service.cancel();
    const cycle = async () => { counts.clear(); await service.run(); await service.cancel(); return new Map(counts); };
    return { native, cycle, cache, counts, desk, service, firstPaths: [...native.files.keys()] };
  }
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const fmt = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");

  const reads = (m: Map<string, number>) => (m.get("readBinary") ?? 0) + (m.get("read") ?? 0);

  // Measured with this file (300 files, one idle cycle): readBinary 900 (3 per file: rail preview, plan, re-plan), list 3, total 907
  // before the hash cache and the idle fast path; readBinary 0, list 2, total 6 after. At 3000 files the "after" is the same 6.
  it("an unchanged vault costs no file reads and no per-file calls after the first cycle", async () => {
    const s = await setup();
    const idle = await s.cycle();
    expect(reads(idle)).toBe(0);
    expect(idle.get("list")).toBeLessThanOrEqual(2);        // one walk of the listing the host already provides (was 3)
    expect(total(idle)).toBeLessThanOrEqual(8);             // independent of the number of files
    expect(idle.get("syncPrivateRead") ?? 0).toBe(0);        // no journals to re-read, no receipts
    expect(idle.get("writeBinary") ?? 0).toBe(0);
    expect(reads(await s.cycle())).toBe(0);
  });

  it("a same-size edit with a new mtime is re-read, re-hashed and published; nothing else is read", async () => {
    const s = await setup();
    const path = "Folder3/Sub/Note 3.md", before = s.native.text(path)!;
    const edited = before.replace("note 3", "NOTE 3"); expect(edited.length).toBe(before.length);
    s.native.edit(path, edited, 5_000);
    const cycle = await s.cycle();
    expect(cycle.get("readBinary")).toBeLessThanOrEqual(2);   // the scan's read of the one changed file (+ the publish read), never the other files
    await s.desk.sync();
    expect(readFileSync(join(s.desk.vault, path), "utf8")).toBe(edited);
    expect(reads(await s.cycle())).toBe(0);                    // and it is cached again afterwards
  });

  it("a file written moments ago (inside the racy window) is re-read until its mtime ages", async () => {
    const s = await setup();
    s.native.edit("Folder1/Sub/Note 1.md", "# note 1\n" + "y".repeat(300), Date.now());
    const first = await s.cycle(), second = await s.cycle();
    expect(first.get("readBinary")).toBeGreaterThanOrEqual(1);
    expect(second.get("readBinary")).toBeGreaterThanOrEqual(1);
    expect((second.get("readBinary") ?? 0)).toBeLessThanOrEqual(3);
  });

  it("the first cycle after an upgrade (no cache rows) hashes every file once, then it is free", async () => {
    const cache = memoryHashCache(), s = await setup(cache);
    cache.rows.clear();
    const upgrade = await s.cycle();
    expect(upgrade.get("readBinary")).toBe(FILES);
    expect(cache.rows.size).toBe(FILES);
    expect(reads(await s.cycle())).toBe(0);
  });

  it("RESIDUAL RISK, stated as a test: identical size and mtime with different bytes is not noticed by the scan", async () => {
    const s = await setup();
    const path = "Folder2/Sub/Note 2.md", before = s.native.text(path)!;
    s.native.edit(path, before.replace("note 2", "NOTE 2")); // same length, mtime untouched (restored/`touch -r`)
    const cycle = await s.cycle();
    expect(reads(cycle)).toBe(0);                             // trusted from the cache, as designed
    // The safety net: any apply over this path still reads the real bytes and hashes them (the guard), so a remote change
    // cannot overwrite it blindly; only an upload of the local edit waits for its stat tuple to change.
  });
});
