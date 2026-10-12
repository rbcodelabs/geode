import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import { createCapacitorHost } from "../../src/renderer/host/capacitor-host";
import { HUB_PROVIDER_ID, HubSyncProvider } from "../../src/renderer/sync/hub-provider";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { hubTokenKey } from "../../src/shared/hub-sync";
import { startHttpStoreServer, type HttpStoreServer } from "../../src/sync-node/index";
import { appDevice, rmrf, tmpDir, tree } from "../helpers/app-hub-harness";
import { FakeManagedVault } from "../helpers/fake-managed-vault";
import { put } from "../helpers/node-host-harness";
import { HTTP_TEST_TOKEN } from "../helpers/sync-store-harness";

vi.setConfig({ testTimeout: 90_000 });

const ROOT = "managed://default";

/** The phone: the real Capacitor host (guarded sync, Keychain secrets) over an in-memory native plugin, with the real SyncService and hub provider. */
async function phone(url: string) {
  const native = new FakeManagedVault(ROOT);
  const host = createCapacitorHost(native.plugin, createBrowserHost(createBrowserHostState()));
  await host.vaultRegistry.openVault(ROOT);
  await host.secrets.app!.set(hubTokenKey(url), HTTP_TEST_TOKEN);
  const app = host.secrets.app!;
  const provider = new HubSyncProvider(undefined, host.deviceState, () => ROOT, { secrets: { available: true, get: k => app.get(k), set: (k, v) => app.set(k, v), remove: k => app.remove(k) }, http: { allowInsecure: true } });
  const service = new SyncService(host, () => ROOT);
  const device = {
    native, host, provider, service,
    tree: () => Object.fromEntries([...native.files].filter(([path]) => !path.split("/").some(part => part.startsWith("."))).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]).sort(([a], [b]) => String(a).localeCompare(String(b)))),
    async configure() { await host.deviceState.write(`sync-hub/config/${ROOT}`, { schema: 1, target: { kind: "http", url }, create: false }); },
    async connect() { service.register("geode", provider); await service.activate(HUB_PROVIDER_ID); const [descriptor] = await service.discoverVaults(); if (!descriptor) throw new Error("hub holds no vault"); await service.joinVault(descriptor); },
    async firstSync() { await service.preview(); const result = await service.run({ approvePreview: true }); await service.cancel(); return result; },
    async sync() { try { return await service.run(); } finally { await service.cancel(); } },
  };
  return device;
}

describe("a desktop-style device and the phone host converge through a real HTTPS-hub server", () => {
  const cleanups: string[] = [], servers: HttpStoreServer[] = [];
  const dir = (prefix: string) => { const d = tmpDir(prefix); cleanups.push(d); return d; };
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const d of cleanups.splice(0)) rmrf(d); });

  async function setup() {
    const server = await startHttpStoreServer({ store: dir("hub"), token: HTTP_TEST_TOKEN, port: 0, pingIntervalMs: 60_000 });
    servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/`;
    const desk = appDevice({ vault: dir("desk-vault"), userData: dir("desk-userdata"), noBridge: true, ignorePortableConfig: true, providerOptions: { secrets: { available: true, get: async () => HTTP_TEST_TOKEN, set: async () => {}, remove: async () => {} }, http: { allowInsecure: true } } });
    return { url, desk: Object.assign(desk, { write: (rel: string, text: string) => put(desk.vault, rel, text), read: (rel: string) => readFileSync(join(desk.vault, rel), "utf8"), has: (rel: string) => existsSync(join(desk.vault, rel)), remove: (rel: string) => rmSync(join(desk.vault, rel), { force: true }) }) };
  }

  it("creates, edits and deletes propagate both ways; mobile applies are guarded, private bytes stay out of the vault, the token stays in the Keychain", async () => {
    const { url, desk } = await setup();
    desk.write("Home.md", "home"); desk.write("Projects/Deep/Plan.md", "plan v1"); desk.write("Doomed.md", "doomed");
    await desk.configureUnchecked({ kind: "http", url }, true);
    await desk.connect({ create: "Wiki" });
    await desk.firstSync();

    const mobile = await phone(url);
    await mobile.configure();
    await mobile.connect();
    await mobile.firstSync();
    expect(mobile.tree()).toEqual(tree(desk.vault));
    expect(mobile.native.folders.has("Projects/Deep")).toBe(true);
    // Downloads really went through the guarded native write (parents first), not around it.
    expect(mobile.native.calls).toContain("writeBinary Projects/Deep/Plan.md");
    expect(mobile.native.calls.indexOf("mkdir Projects/Deep")).toBeLessThan(mobile.native.calls.indexOf("writeBinary Projects/Deep/Plan.md"));

    desk.write("Projects/Deep/Plan.md", "plan v2 from desk"); desk.remove("Doomed.md");
    mobile.native.put("FromPhone.md", "typed on the phone");
    await desk.sync(); await mobile.sync(); await desk.sync();
    expect(mobile.tree()).toEqual(tree(desk.vault));
    expect(mobile.native.text("Projects/Deep/Plan.md")).toBe("plan v2 from desk");
    expect(desk.read("FromPhone.md")).toBe("typed on the phone");
    expect(mobile.native.files.has("Doomed.md")).toBe(false);
    expect(mobile.native.trashed).toContain("Doomed.md");

    // The phone edits and then the desktop deletes: the phone's edit made after it last synced must never be silently trashed.
    mobile.native.put("Home.md", "phone edit");
    desk.remove("Home.md");
    await desk.sync();
    await mobile.sync().catch(() => undefined);
    expect(mobile.native.text("Home.md")).toBe("phone edit");
    expect(mobile.native.trashed).not.toContain("Home.md");

    const vaultBytes = [...mobile.native.files.values()].map(bytes => new TextDecoder().decode(bytes)).join("\n");
    expect(vaultBytes).not.toContain(HTTP_TEST_TOKEN);
    expect(JSON.stringify([...mobile.native.privateFiles.keys()])).not.toContain(HTTP_TEST_TOKEN);
    expect(mobile.native.privateDump()).not.toContain(HTTP_TEST_TOKEN);
    expect(JSON.stringify(await mobile.host.deviceState.read(`sync-hub/config/${ROOT}`))).not.toContain(HTTP_TEST_TOKEN);
    expect(mobile.native.keychain.get(hubTokenKey(url))).toBe(HTTP_TEST_TOKEN);
    expect([...mobile.native.privateFiles.keys()].every(key => !key.startsWith("Welcome") && !mobile.native.files.has(key))).toBe(true);
    await desk.close();
  });

  it("a file the phone has not downloaded from iCloud is blocked: never deleted from the hub, never overwritten", async () => {
    const { url, desk } = await setup();
    desk.write("Home.md", "home"); desk.write("Away.md", "on the desktop");
    await desk.configureUnchecked({ kind: "http", url }, true);
    await desk.connect({ create: "Wiki" });
    await desk.firstSync();

    const mobile = await phone(url);
    mobile.native.put("Home.md", "home").put(".Away.md.icloud", "stub");
    await mobile.configure();
    await mobile.connect();
    await mobile.firstSync();
    await mobile.sync();
    await desk.sync();
    expect(desk.read("Away.md")).toBe("on the desktop");
    expect(mobile.native.files.has("Away.md")).toBe(false);
    expect(mobile.native.text(".Away.md.icloud")).toBe("stub");
    await desk.close();
  });
});
