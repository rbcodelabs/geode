import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import { createCapacitorHost } from "../../src/renderer/host/capacitor-host";
import { HUB_PROVIDER_ID, HubSyncProvider } from "../../src/renderer/sync/hub-provider";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { hubTokenKey } from "../../src/shared/hub-sync";
import { startHttpStoreServer, type HttpStoreServer } from "../../src/sync-node/index";
import { appDevice, rmrf, tmpDir } from "../helpers/app-hub-harness";
import { FakeManagedVault } from "../helpers/fake-managed-vault";
import { put } from "../helpers/node-host-harness";
import { HTTP_TEST_TOKEN } from "../helpers/sync-store-harness";

vi.setConfig({ testTimeout: 120_000 });
const ROOT = "managed://default";
const FILES = 60;

/** Counts every JS->native bridge call the phone makes while applying FILES downloaded files. */
/*
 * Measured with this exact test (60 downloaded files, each 3 folders deep) before the call-count work:
 *   stat 6.60/file, syncPrivateWrite 6.20, syncPrivateRemove 3.60, syncPrivateRead 3.40, syncPrivateAvailableBytes 1.07, ... total 23.1/file.
 */
describe("bridge calls per applied file on the phone", () => {
  const cleanups: string[] = [], servers: HttpStoreServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of cleanups.splice(0)) rmrf(d); });

  it("stays within the per-file bridge-call budget", async () => {
    const dir = (p: string) => { const d = tmpDir(p); cleanups.push(d); return d; };
    const server = await startHttpStoreServer({ store: dir("hub"), token: HTTP_TEST_TOKEN, port: 0, pingIntervalMs: 60_000 }); servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/`;
    const desk = appDevice({ vault: dir("v"), userData: dir("u"), noBridge: true, ignorePortableConfig: true, providerOptions: { secrets: { available: true, get: async () => HTTP_TEST_TOKEN, set: async () => {}, remove: async () => {} }, http: { allowInsecure: true } } });
    for (let i = 0; i < FILES; i++) put(desk.vault, `Folder${i % 6}/Sub/Note ${i}.md`, `# note ${i}\n` + "x".repeat(500));
    await desk.configureUnchecked({ kind: "http", url }, true); await desk.connect({ create: "Wiki" }); await desk.firstSync();

    const native = new FakeManagedVault(ROOT);
    const counts = new Map<string, number>();
    const counted = new Proxy(native.plugin, { get(target, prop, receiver) { const v = Reflect.get(target, prop, receiver); return typeof v === "function" && typeof prop === "string" ? (...a: unknown[]) => { counts.set(prop, (counts.get(prop) ?? 0) + 1); return v.apply(target, a); } : v; } });
    const host = createCapacitorHost(counted, createBrowserHost(createBrowserHostState()));
    await host.vaultRegistry.openVault(ROOT);
    await host.secrets.app!.set(hubTokenKey(url), HTTP_TEST_TOKEN);
    const app = host.secrets.app!;
    const provider = new HubSyncProvider(undefined, host.deviceState, () => ROOT, { secrets: { available: true, get: k => app.get(k), set: (k, v) => app.set(k, v), remove: k => app.remove(k) }, http: { allowInsecure: true } });
    const service = new SyncService(host, () => ROOT);
    await host.deviceState.write(`sync-hub/config/${ROOT}`, { schema: 1, target: { kind: "http", url }, create: false });
    service.register("geode", provider); await service.activate(HUB_PROVIDER_ID);
    const [descriptor] = await service.discoverVaults(); await service.joinVault(descriptor);
    await service.preview();
    const stateWrites = { n: 0, bytes: 0 }; const write = host.deviceState.write.bind(host.deviceState);
    host.deviceState.write = async (k, v) => { if (k.includes("sync-history")) { stateWrites.n++; stateWrites.bytes += JSON.stringify(v).length; } return write(k, v); };
    counts.clear();
    await service.run({ approvePreview: true }); await service.cancel();
    expect(native.files.size).toBeGreaterThanOrEqual(FILES);
    const rows = [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.padEnd(28)} ${String(v).padStart(6)}  ${(v / FILES).toFixed(2)}/file`);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const report = `CALLS (${FILES} files)\n${rows.join("\n")}\ntotal ${total} = ${(total / FILES).toFixed(1)}/file; state writes ${stateWrites.n} (${stateWrites.bytes} bytes)\n`;
    if (process.env.CALLS_OUT) (await import("node:fs")).writeFileSync(process.env.CALLS_OUT, report);
    const per = (name: string) => (counts.get(name) ?? 0) / FILES;
    // Hash-guard and crash-recovery work is NOT in this list: receipts, journals, staged bytes and the writes themselves are unchanged.
    expect(per("stat")).toBeLessThanOrEqual(4);              // was 6.6: one full-path stat + the nearest existing ancestor + one re-check of the target
    expect(per("syncPrivateAvailableBytes")).toBeLessThan(0.1); // was 1.07: one measurement per batch, not per staged file
    expect(per("syncPrivateRemove")).toBeLessThanOrEqual(2.7);  // was 3.6: the terminal release no longer re-removes a blob already freed
    expect(per("writeBinary")).toBe(1); expect(stateWrites.n).toBeLessThanOrEqual(4); // device state is saved per batch, never per operation
    expect(total / FILES).toBeLessThanOrEqual(19);             // was 23.1
  });
});
