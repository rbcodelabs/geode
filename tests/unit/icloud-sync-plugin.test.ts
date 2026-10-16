import { afterEach, describe, expect, it, vi } from "vitest";

// `geode` and `obsidian` only exist at plugin runtime (the loader's require shim), so they are mocked here.
vi.mock("geode", () => ({ SyncPreconditionError: class SyncPreconditionError extends Error {} }));
vi.mock("obsidian", () => ({
  Notice: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Plugin: class {
    app = { vault: { root: "/Users/me/Notes/My Vault" }, sync: { getActiveProvider: () => null } };
    registered: unknown[] = [];
    tabs: unknown[] = [];
    data: unknown = null;
    registerSyncProvider(provider: unknown) {
      this.registered.push(provider);
    }
    addSettingTab(tab: unknown) {
      this.tabs.push(tab);
    }
    async loadData() {
      return this.data;
    }
    async saveData(data: unknown) {
      this.data = data;
    }
  },
}));

import IcloudSyncPlugin from "../../packages/geode-icloud-sync/src/main";

const realPlatform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }));

type Loaded = { onload(): Promise<void>; registered: Array<{ id: string; protocol: string }>; tabs: unknown[] };

describe("IcloudSyncPlugin", () => {
  it("registers the iCloud provider and its settings tab on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const plugin = new IcloudSyncPlugin() as unknown as Loaded;
    await plugin.onload();
    expect(plugin.registered).toHaveLength(1);
    expect(plugin.registered[0]).toMatchObject({ id: "icloud", protocol: "conditional-mutation-v1" });
    expect(plugin.tabs).toHaveLength(1);
  });

  it("registers nothing off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = new IcloudSyncPlugin() as unknown as Loaded;
    await plugin.onload();
    expect(plugin.registered).toHaveLength(0);
    expect(plugin.tabs).toHaveLength(0);
  });
});
