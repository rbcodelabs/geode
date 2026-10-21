import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { CompassSyncPlugin, type CompassSecretStore } from "../../src/renderer/internal-plugins/compass-sync/compass-sync-plugin";
import { FakeCompassServer } from "../helpers/fake-compass-server";

function fakeApp(vaultRoot = "/Users/me/Notes/Vault") {
  const unregister = vi.fn(async () => {});
  const state = new Map<string, unknown>();
  let active: { id: string } | null = null;
  const app = {
    vault: { root: vaultRoot },
    sync: { register: vi.fn((_owner: string, _provider: unknown) => unregister), getActiveProvider: () => active },
    host: { deviceState: { read: async (key: string) => state.get(key) ?? null, write: async (key: string, value: unknown) => void state.set(key, value) } },
  };
  return { app, unregister, state, setActive: (id: string | null) => (active = id ? { id } : null) };
}

function secretStore(available = true): CompassSecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { available, values, get: async (key) => values.get(key) ?? null, set: async (key, value) => void values.set(key, value), remove: async (key) => void values.delete(key) };
}

describe("CompassSyncPlugin", () => {
  it("registers the compass.docs provider on load and unregisters on unload", () => {
    const { app, unregister } = fakeApp();
    const plugin = new CompassSyncPlugin(app as never, { secrets: secretStore() });
    plugin.load();
    const [owner, provider] = app.sync.register.mock.calls[0] as [string, { id: string; name: string; protocol: string }];
    expect(owner).toBe("compass-sync");
    expect(provider).toMatchObject({ id: "compass.docs", name: "Compass", protocol: "conditional-mutation-v1" });
    plugin.unload();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("keeps URL and workspace in device state per vault and the secrets in secure storage only", async () => {
    const { app, state } = fakeApp();
    const secrets = secretStore();
    const plugin = new CompassSyncPlugin(app as never, { secrets });
    expect(await plugin.connection()).toBeNull();
    await plugin.setConfig({ baseUrl: " https://compass.example.com ", workspaceId: "ws", extraHeaderName: "x-vercel-protection-bypass", trashMode: "move", useDelta: false });
    await plugin.setToken(" tok ");
    await plugin.setExtraHeaderValue("bypass");
    expect(await plugin.connection()).toEqual({
      baseUrl: "https://compass.example.com", workspaceId: "ws", token: "tok", trashMode: "move", useDelta: false,
      extraHeader: { name: "x-vercel-protection-bypass", value: "bypass" },
    });
    expect(JSON.stringify([...state.entries()])).not.toContain('"tok"');
    expect(JSON.stringify([...state.entries()])).not.toContain('"bypass"');
    expect(await plugin.hasToken()).toBe(true);
    await plugin.setToken("");
    expect(await plugin.connection()).toBeNull();
    // A different vault has its own settings.
    const other = fakeApp("/other");
    other.state.set("plugin/compass-sync/config", state.get("plugin/compass-sync/config"));
    expect((await new CompassSyncPlugin(other.app as never, { secrets }).getConfig()).baseUrl).toBe("");
  });

  it("refuses to take a token when the host has no secure storage", async () => {
    const { app } = fakeApp();
    const plugin = new CompassSyncPlugin(app as never, { secrets: secretStore(false) });
    expect(plugin.canStoreSecrets).toBe(false);
    await expect(plugin.setToken("tok")).rejects.toThrow(/Secure storage is unavailable/);
    await expect(new CompassSyncPlugin(app as never).setToken("tok")).rejects.toThrow(/Secure storage is unavailable/);
  });

  it("refuses to change the connection while Compass is the active provider", async () => {
    const { app, setActive } = fakeApp();
    const plugin = new CompassSyncPlugin(app as never, { secrets: secretStore() });
    setActive("compass.docs");
    await expect(plugin.setConfig({ baseUrl: "https://x", workspaceId: "w", extraHeaderName: "", trashMode: "move", useDelta: false })).rejects.toThrow(/Disconnect/);
  });

  it("tests the saved connection against the server", async () => {
    const server = new FakeCompassServer();
    await server.start();
    try {
      const { app } = fakeApp();
      const secrets = secretStore();
      const plugin = new CompassSyncPlugin(app as never, { secrets });
      await expect(plugin.testConnection()).rejects.toThrow(/not configured/);
      await plugin.setConfig({ baseUrl: server.baseUrl, workspaceId: server.workspaceId, extraHeaderName: "", trashMode: "move", useDelta: false });
      await plugin.setToken("wrong");
      await expect(plugin.testConnection()).rejects.toThrow(/rejected the access token/);
      await plugin.setToken(server.token);
      await expect(plugin.testConnection()).resolves.toMatch(/Connected/);
    } finally {
      await server.stop();
    }
  });
});

describe("App.syncCompassSyncPlugin", () => {
  const sync = App.prototype.syncCompassSyncPlugin;
  function appThis(enabled: boolean) {
    const { app, unregister } = fakeApp();
    const self = Object.assign(Object.create(null), app, { settings: { compassSyncEnabled: enabled }, host: { ...app.host, secrets: { available: true, app: secretStore() } } });
    return { self, unregister };
  }
  it("loads only while enabled and unloads when disabled", () => {
    const off = appThis(false);
    sync.call(off.self);
    expect(off.self.compassSyncPlugin).toBeUndefined();
    const on = appThis(true);
    sync.call(on.self);
    expect(on.self.compassSyncPlugin).toBeInstanceOf(CompassSyncPlugin);
    on.self.settings.compassSyncEnabled = false;
    sync.call(on.self);
    expect(on.self.compassSyncPlugin).toBeUndefined();
    expect(on.unregister).toHaveBeenCalledTimes(1);
  });
});
