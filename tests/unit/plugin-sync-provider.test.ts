import { describe, expect, it, vi } from "vitest";
import { Plugin } from "../../src/renderer/plugin";
import type { SyncProvider } from "../../src/renderer/sync/types";

const provider: SyncProvider = {
  id: "drive", name: "Drive", capabilities: { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true },
  open: vi.fn() as SyncProvider["open"],
};

describe("Plugin.registerSyncProvider", () => {
  it("stores transport journals in device state rather than vault plugin data", async () => {
    const deviceState = { read: vi.fn(async () => ({ operation: "one" })), write: vi.fn(async () => {}) };
    const plugin = new (class extends Plugin {})({ host: { deviceState } } as never, { id: "gdocs", name: "GDocs", version: "1.0.0", minAppVersion: "0.1.0" });
    plugin.activateHostGeneration();
    await (plugin as any).saveDeviceState("account/vault", { operation: "one" });
    expect(await (plugin as any).loadDeviceState("account/vault")).toEqual({ operation: "one" });
    expect(deviceState.write).toHaveBeenCalledWith("plugin/gdocs/account%2Fvault", { operation: "one" });
  });
  it("registers with plugin ownership and automatically unregisters on unload", async () => {
    const unregister = vi.fn(async () => {});
    const app = { sync: { register: vi.fn(() => unregister) } };
    const plugin = new (class extends Plugin {})(app as never, { id: "gdocs", name: "GDocs", version: "1.0.0", minAppVersion: "0.1.0" });
    plugin.activateHostGeneration();
    plugin.registerSyncProvider(provider);
    expect(app.sync.register).toHaveBeenCalledWith("gdocs", provider);
    await plugin.unloadAndWait();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("namespaces secrets to the owning plugin", async () => {
    const scoped = { get: vi.fn(async () => "value"), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const secrets = { available: true, fromCapability: vi.fn(() => scoped) };
    const plugin = new (class extends Plugin {})({ host: { secrets }, sync: { register: vi.fn() } } as never, { id: "gdocs", name: "GDocs", version: "1.0.0", minAppVersion: "0.1.0" });
    plugin.activateHostGeneration();
    plugin.bindSecretCapability("opaque-gdocs");
    await plugin.saveSecret("oauth", "sentinel");
    await plugin.loadSecret("oauth");
    await plugin.removeSecret("oauth");
    expect(secrets.fromCapability).toHaveBeenCalledWith("opaque-gdocs");
    expect(scoped.set).toHaveBeenCalledWith("oauth", "sentinel");
    expect(scoped.get).toHaveBeenCalledWith("oauth");
    expect(scoped.remove).toHaveBeenCalledWith("oauth");
  });
});
