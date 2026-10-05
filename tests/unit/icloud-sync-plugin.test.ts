import { afterEach, describe, expect, it, vi } from "vitest";

// `geode` only exists at plugin runtime (the loader's require shim), so it is mocked here.
vi.mock("geode", () => ({
  Plugin: class {
    registered: unknown[] = [];
    registerSyncProvider(provider: unknown) {
      this.registered.push(provider);
    }
  },
  SyncPreconditionError: class SyncPreconditionError extends Error {},
}));

import IcloudSyncPlugin from "../../packages/geode-icloud-sync/src/main";

const realPlatform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }));

describe("IcloudSyncPlugin", () => {
  it("registers the iCloud provider on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const plugin = new IcloudSyncPlugin() as unknown as { onload(): void; registered: Array<{ id: string; protocol: string }> };
    plugin.onload();
    expect(plugin.registered).toHaveLength(1);
    expect(plugin.registered[0]).toMatchObject({ id: "icloud", protocol: "conditional-mutation-v1" });
  });

  it("registers nothing off macOS", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = new IcloudSyncPlugin() as unknown as { onload(): void; registered: unknown[] };
    plugin.onload();
    expect(plugin.registered).toHaveLength(0);
  });
});
