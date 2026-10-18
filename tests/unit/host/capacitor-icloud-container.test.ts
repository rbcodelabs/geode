import { describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../../src/renderer/host/browser-host";
import { createCapacitorHost, type ManagedVaultPlugin } from "../../../src/renderer/host/capacitor-host";
import { createCapacitorIcloudBridge, type IcloudContainerPlugin } from "../../../src/renderer/host/capacitor-icloud-container";
import { IcloudBridgeError, type IcloudStat } from "../../../src/shared/icloud-container";

const stat: IcloudStat = { kind: "file", size: 5, mtimeMs: 10, revision: "10:5:abc", availability: "current" };

function pluginFixture(overrides: Partial<Record<keyof IcloudContainerPlugin, unknown>> = {}): IcloudContainerPlugin {
  const plugin = {
    availability: vi.fn(async () => ({ state: "available", containerId: "iCloud.com.rbcodelabs.geode" })),
    listRoots: vi.fn(async () => ({ roots: ["Vault"] })),
    list: vi.fn(async () => ({ found: false })),
    walk: vi.fn(async () => ({ entries: [], problems: [] })),
    stat: vi.fn(async () => ({ found: true, stat })),
    read: vi.fn(async () => ({ base64: btoa("hello"), revision: "10:5:abc" })),
    beginWrite: vi.fn(async () => ({ handle: "h1" })),
    appendChunk: vi.fn(async () => ({})),
    commitWrite: vi.fn(async () => ({ stat })),
    discardWrite: vi.fn(async () => ({})),
    move: vi.fn(async () => ({ stat })),
    mkdir: vi.fn(async () => ({})),
    startDownload: vi.fn(async () => ({})),
    waitForDownload: vi.fn(async () => ({ ready: ["a"], pending: [] })),
    abort: vi.fn(async () => ({})),
    ...overrides,
  };
  return plugin as unknown as IcloudContainerPlugin;
}

describe("createCapacitorIcloudBridge", () => {
  it("decodes the wire format: found flags, base64 bytes, preconditions", async () => {
    const plugin = pluginFixture({
      list: vi.fn(async () => ({ found: true, entries: [{ name: "a.md", kind: "file", availability: "current" }] })),
    });
    let counter = 0;
    const bridge = createCapacitorIcloudBridge(plugin, () => `req-${++counter}`);

    await expect(bridge.listRoots()).resolves.toEqual(["Vault"]);
    await expect(bridge.list("Vault", "")).resolves.toEqual([{ name: "a.md", kind: "file", availability: "current" }]);
    await expect(bridge.stat("Vault", "a.md", { maxHashBytes: 9 })).resolves.toEqual(stat);
    const read = await bridge.read("Vault", "a.md", { offset: 0, length: 5, expectedRevision: "10:5:abc" });
    expect(new TextDecoder().decode(read.bytes)).toBe("hello");
    expect(plugin.read).toHaveBeenCalledWith(expect.objectContaining({ root: "Vault", path: "a.md", offset: 0, length: 5, expectedRevision: "10:5:abc" }));

    await bridge.appendChunk("h1", new TextEncoder().encode("hi").buffer);
    expect(plugin.appendChunk).toHaveBeenCalledWith(expect.objectContaining({ handle: "h1", base64: btoa("hi") }));
    await bridge.commitWrite("h1", { absent: true }, { maxHashBytes: 1 });
    await bridge.commitWrite("h1", { revision: "r" }, { maxHashBytes: 1 });
    await bridge.commitWrite("h1", { any: true }, { maxHashBytes: 1 });
    const wires = (plugin.commitWrite as ReturnType<typeof vi.fn>).mock.calls.map(([arg]) => [arg.precondition, arg.revision]);
    expect(wires).toEqual([["absent", undefined], ["revision", "r"], ["any", undefined]]);
  });

  it("maps absent items to null and walk skip rules to arrays", async () => {
    const plugin = pluginFixture({ stat: vi.fn(async () => ({ found: false })) });
    const bridge = createCapacitorIcloudBridge(plugin);
    await expect(bridge.stat("Vault", "gone", { maxHashBytes: 1 })).resolves.toBeNull();
    await expect(bridge.list("Vault", "gone")).resolves.toBeNull();
    await bridge.walk("Vault", "", { maxHashBytes: 7, skipTopLevel: [".geode-sync"] });
    expect(plugin.walk).toHaveBeenCalledWith(expect.objectContaining({ maxHashBytes: 7, skipNames: [], skipPrefixes: [], skipTopLevel: [".geode-sync"] }));
  });

  it("round-trips an 8 MiB chunk without blowing the call stack", async () => {
    const plugin = pluginFixture();
    const bridge = createCapacitorIcloudBridge(plugin);
    const big = new Uint8Array(8 * 1024 * 1024).fill(65);
    await bridge.appendChunk("h1", big.buffer);
    const base64 = (plugin.appendChunk as ReturnType<typeof vi.fn>).mock.calls[0][0].base64 as string;
    expect(atob(base64).length).toBe(big.length);
  });

  it("rebuilds native rejection codes as IcloudBridgeError", async () => {
    const codes = ["precondition-failed", "not-found", "unavailable", "aborted", "too-large", "invalid-path", "failed"] as const;
    for (const code of codes) {
      const bridge = createCapacitorIcloudBridge(pluginFixture({ stat: vi.fn(async () => { throw Object.assign(new Error("native said so"), { code }); }) }));
      await expect(bridge.stat("Vault", "a", { maxHashBytes: 1 })).rejects.toMatchObject({ name: "IcloudBridgeError", code, message: "native said so" });
    }
    const unknown = createCapacitorIcloudBridge(pluginFixture({ mkdir: vi.fn(async () => { throw Object.assign(new Error("boom"), { code: "SOMETHING_ELSE" }); }) }));
    await expect(unknown.mkdir("Vault", "x")).rejects.toMatchObject({ code: "failed", message: "boom" });
  });

  it("treats a build without the native plugin as unavailable, never as an empty remote", async () => {
    const missing = () => { throw Object.assign(new Error('"GeodeIcloudContainer" plugin is not implemented on ios'), { code: "UNIMPLEMENTED" }); };
    const bridge = createCapacitorIcloudBridge(pluginFixture({ availability: vi.fn(async () => missing()), listRoots: vi.fn(async () => missing()) }));
    await expect(bridge.availability()).resolves.toMatchObject({ state: "unavailable", reason: "unsupported-platform" });
    await expect(bridge.listRoots()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("forwards an abort to native by request id and refuses calls on an already-aborted signal", async () => {
    let release!: () => void;
    const plugin = pluginFixture({ walk: vi.fn(() => new Promise((resolve) => { release = () => resolve({ entries: [], problems: [] }); })) });
    const bridge = createCapacitorIcloudBridge(plugin, () => "req-abort");
    const controller = new AbortController();
    const pending = bridge.walk("Vault", "", { maxHashBytes: 1 }, controller.signal);
    controller.abort();
    expect(plugin.abort).toHaveBeenCalledWith({ requestId: "req-abort" });
    release();
    await pending;

    await expect(bridge.walk("Vault", "", { maxHashBytes: 1 }, controller.signal)).rejects.toBeInstanceOf(IcloudBridgeError);
    await expect(bridge.walk("Vault", "", { maxHashBytes: 1 }, controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("createCapacitorHost icloudContainer wiring", () => {
  const managedVault = {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
  } as unknown as ManagedVaultPlugin;

  it("surfaces host.icloudContainer and the capability only when the native plugin is supplied", async () => {
    const portable = createBrowserHost(createBrowserHostState());
    const without = createCapacitorHost(managedVault, portable);
    expect(without.icloudContainer).toBeUndefined();
    expect(without.capabilities.icloudContainer).toBe(false);

    const plugin = pluginFixture();
    const host = createCapacitorHost(managedVault, portable, { icloudContainer: plugin });
    expect(host.capabilities.icloudContainer).toBe(true);
    await expect(host.icloudContainer!.availability()).resolves.toEqual({ state: "available", containerId: "iCloud.com.rbcodelabs.geode" });
    expect(plugin.availability).toHaveBeenCalledTimes(1);
  });
});
