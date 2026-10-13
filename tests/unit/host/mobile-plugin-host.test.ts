import { describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../../src/renderer/host/browser-host";
import { createCapacitorHost, type ManagedVaultPlugin } from "../../../src/renderer/host/capacitor-host";
import { createMobilePluginSecretService, pluginIdFromEntryPath, type NamespacedSecretBackend } from "../../../src/renderer/host/plugin-secrets";
import { installMobileWindowOpen } from "../../../src/renderer/host/mobile-window-open";
import { parseGeodeDeepLink } from "../../../src/shared/deep-link-parse";

function memoryBackend(): NamespacedSecretBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (ns, key) => store.get(`${ns}/${key}`) ?? null,
    set: async (ns, key, value) => { store.set(`${ns}/${key}`, value); },
    remove: async (ns, key) => { store.delete(`${ns}/${key}`); },
  };
}

describe("mobile plugin secret service", () => {
  it("is unavailable and refuses writes without a backend", async () => {
    const service = createMobilePluginSecretService(undefined);
    expect(service.available).toBe(false);
    expect(service.capabilityFor("gdocs")).toBeUndefined();
    const owned = service.fromCapability("anything");
    await expect(owned.get("k")).resolves.toBeNull();
    await expect(owned.set("k", "v")).rejects.toThrow(/unavailable/);
  });

  it("scopes every key to the plugin that was given the capability", async () => {
    const backend = memoryBackend();
    const service = createMobilePluginSecretService(backend);
    const a = service.capabilityFor("plugin-a")!;
    const b = service.capabilityFor("plugin-b")!;
    expect(a).not.toBe(b);
    expect(service.capabilityFor("plugin-a")).toBe(a);
    await service.fromCapability(a).set("token", "secret-a");
    await service.fromCapability(b).set("token", "secret-b");
    expect([...backend.store.entries()].sort()).toEqual([["plugin-a/token", "secret-a"], ["plugin-b/token", "secret-b"]]);
    await expect(service.fromCapability(a).get("token")).resolves.toBe("secret-a");
    await service.fromCapability(a).remove("token");
    await expect(service.fromCapability(a).get("token")).resolves.toBeNull();
    await expect(service.fromCapability(b).get("token")).resolves.toBe("secret-b");
  });

  it("rejects a forged capability, bad plugin ids, and oversized or empty values", async () => {
    const backend = memoryBackend();
    const service = createMobilePluginSecretService(backend);
    expect(service.capabilityFor("../escape")).toBeUndefined();
    expect(service.capabilityFor("Upper")).toBeUndefined();
    await expect(service.fromCapability("plugin-a").set("k", "v")).rejects.toThrow(/unavailable/);
    const owned = service.fromCapability(service.capabilityFor("plugin-a")!);
    await expect(owned.set("", "v")).rejects.toThrow(/Invalid secret key/);
    await expect(owned.set("k", "x".repeat(65 * 1024))).rejects.toThrow(/too large/);
    expect(backend.store.size).toBe(0);
  });

  it("derives plugin ids only from entrypoint paths", () => {
    expect(pluginIdFromEntryPath(".geode/plugins/claude-threads/main.js")).toBe("claude-threads");
    expect(pluginIdFromEntryPath(".geode/plugins/claude-threads/main.mobile.js")).toBe("claude-threads");
    expect(pluginIdFromEntryPath(".geode/plugins/claude-threads/styles.css")).toBeNull();
    expect(pluginIdFromEntryPath(".geode/plugins/../x/main.js")).toBeNull();
  });
});

describe("browser host mobile plugin plumbing", () => {
  it("returns a secret capability with the entrypoint and prefers reading main.mobile.js when asked", async () => {
    const backend = memoryBackend();
    const state = createBrowserHostState();
    const host = createBrowserHost(state, { secretBackend: backend });
    await host.vaultRegistry.openVault((await host.vaultRegistry.getRecentVaults())[0] ?? "managed://default").catch(() => undefined);
    await host.vaultFiles.mkdir(".geode/plugins/demo");
    await host.vaultFiles.write(".geode/plugins/demo/main.js", "desktop");
    await host.vaultFiles.write(".geode/plugins/demo/main.mobile.js", "mobile");
    const mobile = await host.plugins.readPluginFile(".geode/plugins/demo/main.mobile.js", 1);
    expect(mobile).toMatchObject({ ok: true, content: "mobile" });
    expect(mobile.secretCapability).toBeTruthy();
    const desktop = await host.plugins.readPluginFile(".geode/plugins/demo/main.js", 1);
    expect(desktop.secretCapability).toBe(mobile.secretCapability);
    expect((await host.plugins.readPluginFile(".geode/plugins/demo/manifest.json", 1)).secretCapability).toBeUndefined();
    await host.secrets.fromCapability(mobile.secretCapability!).set("k", "v");
    expect(backend.store.get("demo/k")).toBe("v");
  });

  it("replaces the mobile entrypoint without touching main.js", async () => {
    const host = createBrowserHost(createBrowserHostState());
    await host.vaultRegistry.openVault((await host.vaultRegistry.getRecentVaults())[0] ?? "managed://default").catch(() => undefined);
    await host.vaultFiles.mkdir(".geode/plugins/demo");
    await host.vaultFiles.write(".geode/plugins/demo/manifest.json", "m1");
    await host.vaultFiles.write(".geode/plugins/demo/main.js", "desktop");
    await host.vaultFiles.write(".geode/plugins/demo/main.mobile.js", "mobile-1");
    await host.plugins.replacePluginFiles("demo", "m1", { manifest: "m2", main: "mobile-2", entry: "main.mobile.js", styles: null });
    expect(await host.vaultFiles.read(".geode/plugins/demo/main.mobile.js")).toBe("mobile-2");
    expect(await host.vaultFiles.read(".geode/plugins/demo/main.js")).toBe("desktop");
    expect(await host.vaultFiles.read(".geode/plugins/demo/manifest.json")).toBe("m2");
  });

  it("delivers externally supplied geode:// links as parsed deep links and ignores foreign schemes", () => {
    let push!: (url: string) => void;
    const host = createBrowserHost(createBrowserHostState(), { deepLinks: { subscribe: (cb) => { push = cb; return () => {}; } } });
    const received: unknown[] = [];
    host.runtime.onDeepLink((link) => received.push(link));
    push("geode://gdocs-sync?event=auth_complete&state=abc");
    push("https://example.com/not-a-geode-link");
    expect(received).toEqual([{ action: "gdocs-sync", params: { event: "auth_complete", state: "abc", action: "gdocs-sync" } }]);
  });
});

describe("capacitor host mobile plugin services", () => {
  function plugin(overrides: Partial<ManagedVaultPlugin> = {}): ManagedVaultPlugin {
    const listeners = new Map<string, (event: never) => void>();
    return {
      readPluginFile: vi.fn(async () => ({ content: "module.exports = class {}" })),
      addListener: vi.fn(async (name: string, cb: (event: never) => void) => { listeners.set(name, cb); return { remove: vi.fn(async () => { listeners.delete(name); }) }; }),
      emit: (name: string, event: unknown) => listeners.get(name)?.(event as never),
      ...overrides,
    } as unknown as ManagedVaultPlugin;
  }

  it("keeps secrets unavailable when the native bridge has no Keychain methods", () => {
    const host = createCapacitorHost(plugin(), createBrowserHost(createBrowserHostState()));
    expect(host.secrets.available).toBe(false);
  });

  it("routes plugin secrets to the Keychain under the plugin namespace", async () => {
    const getSecret = vi.fn(async () => ({ value: "stored" }));
    const setSecret = vi.fn(async () => ({}) as Record<string, never>);
    const removeSecret = vi.fn(async () => ({}) as Record<string, never>);
    const native = plugin({ getSecret, setSecret, removeSecret });
    const host = createCapacitorHost(native, createBrowserHost(createBrowserHostState()));
    expect(host.secrets.available).toBe(true);
    const read = await host.plugins.readPluginFile(".geode/plugins/obsidian-gdocs-sync/main.mobile.js", 1);
    expect(read.secretCapability).toBeTruthy();
    const owned = host.secrets.fromCapability(read.secretCapability!);
    await owned.set("google-oauth-tokens", "{}");
    await expect(owned.get("google-oauth-tokens")).resolves.toBe("stored");
    await owned.remove("google-oauth-tokens");
    expect(setSecret).toHaveBeenCalledWith({ namespace: "obsidian-gdocs-sync", key: "google-oauth-tokens", value: "{}" });
    expect(getSecret).toHaveBeenCalledWith({ namespace: "obsidian-gdocs-sync", key: "google-oauth-tokens" });
    expect(removeSecret).toHaveBeenCalledWith({ namespace: "obsidian-gdocs-sync", key: "google-oauth-tokens" });
    expect(native.readPluginFile).toHaveBeenCalledWith({ path: ".geode/plugins/obsidian-gdocs-sync/main.mobile.js", maxBytes: 16 * 1024 * 1024 });
  });

  it("opens only http(s) URLs through the native browser", async () => {
    const openExternal = vi.fn(async () => ({}) as Record<string, never>);
    const host = createCapacitorHost(plugin({ openExternal }), createBrowserHost(createBrowserHostState()));
    await host.navigation.openExternal("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    expect(openExternal).toHaveBeenCalledWith({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    await expect(host.navigation.openExternal("javascript:alert(1)")).rejects.toThrow(/Unsupported URL scheme/);
    await expect(host.navigation.openExternal("file:///etc/passwd")).rejects.toThrow(/Unsupported URL scheme/);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("forwards native deep links, drops foreign ones, and disposes the listener", async () => {
    const native = plugin() as ManagedVaultPlugin & { emit(name: string, event: unknown): void };
    const host = createCapacitorHost(native, createBrowserHost(createBrowserHostState()));
    const received: unknown[] = [];
    const dispose = host.runtime.onDeepLink((link) => received.push(link));
    await Promise.resolve(); await Promise.resolve();
    native.emit("deepLink", { url: "geode://pair?roomId=r1&relay=wss%3A%2F%2Frelay.example" });
    native.emit("deepLink", { url: "https://example.com/x" });
    expect(received).toEqual([{ action: "pair", params: { roomId: "r1", relay: "wss://relay.example", action: "pair" } }]);
    dispose();
    await Promise.resolve(); await Promise.resolve();
    native.emit("deepLink", { url: "geode://pair?roomId=r2" });
    expect(received).toHaveLength(1);
  });
});

describe("mobile window.open", () => {
  it("routes http(s) to the host and swallows everything else", () => {
    const openExternal = vi.fn(async () => {});
    const win = { open: vi.fn(), location: { href: "capacitor://localhost/index.html" } } as unknown as Window;
    const original = win.open;
    const restore = installMobileWindowOpen({ navigation: { openExternal } } as never, win);
    expect(win.open("https://example.com/a")).toBeNull();
    expect(win.open("/relative")).toBeNull();
    expect(win.open("javascript:alert(1)")).toBeNull();
    expect(win.open("geode://x")).toBeNull();
    expect(win.open()).toBeNull();
    expect(openExternal.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["https://example.com/a"]);
    restore();
    expect(win.open).toBe(original);
  });
});

describe("deep link parsing for plugin protocol handlers", () => {
  it("keeps hyphenated plugin actions and query params", () => {
    expect(parseGeodeDeepLink("geode://gdocs-sync?event=auth_complete&access_token=a%2Bb")).toEqual({
      action: "gdocs-sync",
      params: { event: "auth_complete", access_token: "a+b", action: "gdocs-sync" },
    });
  });
});
