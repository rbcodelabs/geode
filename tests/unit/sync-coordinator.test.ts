import { describe, expect, it, vi } from "vitest";
import { SyncCoordinator } from "../../src/renderer/sync/coordinator";
import type { HostServices } from "../../src/renderer/host/contracts";
import type { SyncProvider, SyncRemoteEntry } from "../../src/renderer/sync/types";

function memoryHost(files: Record<string, string> = {}): HostServices {
  const data = new Map(Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)]));
  const state = new Map<string, unknown>();
  const host = {
    capabilities: {} as HostServices["capabilities"],
    runtime: { runtime: "browser", platform: "test", formFactor: "desktop", getWindowChromeState: async () => ({ platform: "test", isFullScreen: false }), onWindowChromeState: () => () => {}, onDeepLink: () => () => {}, onForeground: () => () => {} },
    vaultRegistry: {} as HostServices["vaultRegistry"],
    vaultFiles: {
      list: async () => [...data].map(([path, bytes]) => ({ path, isFolder: false, ctime: 1, mtime: 1, size: bytes.byteLength })),
      read: async path => new TextDecoder().decode(data.get(path)), readBinary: async path => data.get(path)!.buffer.slice(0),
      write: async () => ({ ctime: 1, mtime: 1, size: 0 }),
      writeBinary: async (path, bytes) => { data.set(path, new Uint8Array(bytes)); return { ctime: 1, mtime: 1, size: bytes.byteLength }; },
      mkdir: async () => {}, trash: async path => { data.delete(path); }, rename: async () => {}, settleMutation: async () => {},
      exists: async path => data.has(path), onChange: () => () => {},
      reconcileScan: async () => ({ status: "complete" as const, entries: [...data].map(([path, bytes]) => ({ path, isFolder: false, ctime: 1, mtime: 1, size: bytes.byteLength })) }),
    },
    deviceState: { read: async key => state.get(key) ?? null, write: async (key, value) => { state.set(key, structuredClone(value)); }, remove: async key => { state.delete(key); } },
    secrets: { available: false, get: async () => null, set: async () => { throw new Error("unavailable"); }, remove: async () => {} },
    config: {} as HostServices["config"], metadataIndex: {} as HostServices["metadataIndex"], navigation: {} as HostServices["navigation"], plugins: {} as HostServices["plugins"],
  } satisfies HostServices;
  return host;
}

function provider(entries: SyncRemoteEntry[] = []): SyncProvider {
  const create = vi.fn(async input => ({ id: `id:${input.path}`, path: input.path, kind: "file" as const, revision: "1", size: input.data.byteLength }));
  const remote = {
    id: "test.remote", name: "Test remote",
    capabilities: { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true },
    open: async () => ({
      scan: async () => ({ status: "complete", entries, cursor: "next" }),
      read: async entry => new TextEncoder().encode(`remote:${entry.path}`).buffer,
      create,
      update: vi.fn(async input => ({ id: input.id, path: input.path, kind: "file", revision: "2", size: input.data.byteLength })),
      move: vi.fn(), trash: vi.fn(), close: vi.fn(),
    }),
  } satisfies SyncProvider;
  return Object.assign(remote, { create });
}

describe("SyncCoordinator", () => {
  it("allows many registered providers but only one active provider for a vault", async () => {
    const coordinator = new SyncCoordinator(memoryHost(), () => "vault-a");
    coordinator.register("plugin-a", provider());
    coordinator.register("plugin-b", { ...provider(), id: "test.other", name: "Other" });
    await coordinator.activate("test.remote");
    await expect(coordinator.activate("test.other")).rejects.toThrow(/disconnect/i);
  });

  it("builds a first-sync preview without mutating either side until approval", async () => {
    const host = memoryHost({ "Local.md": "local" });
    const remote = provider([{ id: "remote-1", path: "Remote.md", kind: "file", revision: "1", size: 6 }]);
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    const preview = await coordinator.preview();
    expect(preview).toMatchObject({ uploads: 1, downloads: 1, deletes: 0, conflicts: 0, requiresApproval: true });
    expect(await host.vaultFiles.exists("Remote.md")).toBe(false);
    expect((remote as SyncProvider & { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it("requires a preview of the exact first-sync state before approval", async () => {
    const host = memoryHost({ "Local.md": "local" });
    const remote = provider();
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await expect(coordinator.run({ approvePreview: true })).rejects.toThrow(/preview/i);
    await coordinator.preview();
    await expect(coordinator.run({ approvePreview: true })).resolves.toMatchObject({ uploads: 1 });
    expect((remote as SyncProvider & { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledOnce();
  });

  it("never infers a remote deletion from a partial scan", async () => {
    const host = memoryHost({ "Kept.md": "local" });
    const remote = provider();
    remote.open = async () => ({ ...(await provider().open({ vaultId: "vault-a" })), scan: async () => ({ status: "partial", entries: [] }) });
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await expect(coordinator.preview()).rejects.toThrow(/complete/i);
    expect(await host.vaultFiles.exists("Kept.md")).toBe(true);
  });

  it("cancels active work and unregisters a provider when its plugin unloads", async () => {
    let observedAbort = false;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const remote = provider();
    remote.open = async () => ({
      ...(await provider().open({ vaultId: "vault-a" })),
      scan: async (_cursor, signal) => new Promise((resolve) => { markStarted(); signal.addEventListener("abort", () => { observedAbort = true; resolve({ status: "cancelled", entries: [] }); }); }),
    });
    const coordinator = new SyncCoordinator(memoryHost(), () => "vault-a");
    const unregister = coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    const running = coordinator.preview().catch(() => undefined);
    await started;
    unregister();
    await running;
    expect(observedAbort).toBe(true);
    expect(coordinator.listProviders()).toEqual([]);
  });
});
