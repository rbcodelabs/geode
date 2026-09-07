import { describe, expect, it, vi } from "vitest";
import { SyncCoordinator } from "../../src/renderer/sync/coordinator";
import type { HostServices } from "../../src/renderer/host/contracts";
import type { SyncProvider, SyncRemoteEntry } from "../../src/renderer/sync/types";

function memoryHost(files: Record<string, string> = {}, sharedState = new Map<string, unknown>()): HostServices {
  const data = new Map(Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)]));
  const mtimes = new Map([...data.keys()].map(path => [path, 1]));
  const state = sharedState;
  const host = {
    capabilities: {} as HostServices["capabilities"],
    runtime: { runtime: "browser", platform: "test", formFactor: "desktop", getWindowChromeState: async () => ({ platform: "test", isFullScreen: false }), onWindowChromeState: () => () => {}, onDeepLink: () => () => {}, onForeground: () => () => {} },
    vaultRegistry: {} as HostServices["vaultRegistry"],
    vaultFiles: {
      list: async () => [...data].map(([path, bytes]) => ({ path, isFolder: false, ctime: 1, mtime: mtimes.get(path) ?? 1, size: bytes.byteLength })),
      read: async path => new TextDecoder().decode(data.get(path)), readBinary: async path => data.get(path)!.buffer.slice(0),
      write: async () => ({ ctime: 1, mtime: 1, size: 0 }),
      writeBinary: async (path, bytes) => { data.set(path, new Uint8Array(bytes)); const mtime = (mtimes.get(path) ?? 1) + 1; mtimes.set(path, mtime); return { ctime: 1, mtime, size: bytes.byteLength }; },
      mkdir: async () => {}, trash: async path => { data.delete(path); }, rename: async () => {}, settleMutation: async () => {},
      exists: async path => data.has(path), onChange: () => () => {},
      reconcileScan: async () => ({ status: "complete" as const, entries: [...data].map(([path, bytes]) => ({ path, isFolder: false, ctime: 1, mtime: mtimes.get(path) ?? 1, size: bytes.byteLength })) }),
    },
    deviceState: { read: async key => state.get(key) ?? null, write: async (key, value) => { state.set(key, structuredClone(value)); }, remove: async key => { state.delete(key); } },
    secrets: { available: false, fromCapability: () => ({ get: async () => null, set: async () => { throw new Error("unavailable"); }, remove: async () => {} }) },
    config: {} as HostServices["config"], metadataIndex: {} as HostServices["metadataIndex"], navigation: {} as HostServices["navigation"], plugins: {} as HostServices["plugins"],
  } satisfies HostServices;
  return Object.assign(host, {
    testWrite(path: string, value: string) { data.set(path, new TextEncoder().encode(value)); mtimes.set(path, (mtimes.get(path) ?? 1) + 1); },
    testDelete(path: string) { data.delete(path); mtimes.delete(path); },
    testSilentWrite(path: string, value: string) { data.set(path, new TextEncoder().encode(value)); },
    testRead(path: string) { const bytes = data.get(path); return bytes ? new TextDecoder().decode(bytes) : undefined; },
  });
}

function provider(entries: SyncRemoteEntry[] = []): SyncProvider {
  const create = vi.fn(async input => ({ id: `id:${input.path}`, path: input.path, kind: "file" as const, revision: "1", size: input.data.byteLength }));
  const remote = {
    id: "test.remote", name: "Test remote",
    capabilities: { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true },
    open: async () => ({
      scan: async () => ({ status: "complete", mode: "snapshot", entries, cursor: "next" }),
      read: async entry => new TextEncoder().encode(`remote:${entry.path}`).buffer,
      create,
      update: vi.fn(async input => ({ id: input.id, path: input.path, kind: "file", revision: "2", size: input.data.byteLength })),
      move: vi.fn(), trash: vi.fn(), close: vi.fn(),
    }),
  } satisfies SyncProvider;
  return Object.assign(remote, { create });
}

describe("SyncCoordinator", () => {
  it("does not overwrite an equal-size equal-timestamp edit during a download", async () => {
    const host = memoryHost() as HostServices & { testSilentWrite(path: string, value: string): void };
    let revision = "1"; let race = false;
    const remote = provider();
    remote.open = async () => ({ ...(await provider().open({ vaultId: "vault-a" })),
      scan: async () => ({ status: "complete", mode: "snapshot", entries: [{ id: "r", path: "Note.md", kind: "file", revision }] }),
      read: async () => { if (race) host.testSilentWrite("Note.md", "two"); return new TextEncoder().encode("one").buffer; },
    });
    const coordinator = new SyncCoordinator(host, () => "vault-a"); coordinator.register("plugin-a", remote); await coordinator.activate(remote.id);
    await coordinator.preview(); await coordinator.run({ approvePreview: true }); revision = "2"; race = true;
    await coordinator.run(); expect(await host.vaultFiles.read("Note.md")).toBe("two"); expect(await coordinator.listConflicts()).toHaveLength(1);
    expect((await coordinator.preview()).uploads).toBe(0);
  });

  it("retains conflicts after a failed conditional resolution", async () => {
    const host = memoryHost({ "Note.md": "local" }); const remote = provider([{ id: "r", path: "Note.md", kind: "file", revision: "1" }]);
    const session = await remote.open({ vaultId: "vault-a" }); remote.open = async () => ({ ...session, update: async () => { throw new Error("Remote changed"); } });
    const coordinator = new SyncCoordinator(host, () => "vault-a"); coordinator.register("plugin-a", remote); await coordinator.activate(remote.id);
    await coordinator.preview(); await coordinator.run({ approvePreview: true });
    const [conflict] = await coordinator.listConflicts();
    await expect(coordinator.resolveConflict(conflict.id, "keep-local")).rejects.toThrow("Remote changed");
    expect(await coordinator.listConflicts()).toHaveLength(1); expect(coordinator.getStatus().conflicts).toBe(1);
  });

  it("recovers the uploaded-byte baseline without blessing a later local edit", async () => {
    const state = new Map<string, unknown>(); const host = memoryHost({ "Note.md": "two" }, state);
    state.set("sync/vault-a", { providerId: "test.remote", approved: true, baseline: {}, remoteIndex: {}, conflicts: {}, journal: [{ id: "op1", type: "upload", path: "Note.md", phase: "prepared", localFingerprint: "sha256:7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed" }] });
    const remote = provider([{ id: "r", path: "Note.md", kind: "file", revision: "1", operationKey: "op1" }]);
    const coordinator = new SyncCoordinator(host, () => "vault-a"); coordinator.register("plugin-a", remote);
    expect((await coordinator.preview()).uploads).toBe(1);
  });
  it("detects equal-size edits with unchanged timestamps and preserves deletion conflicts across restart", async () => {
    const state = new Map<string, unknown>();
    const host = memoryHost({ "Note.md": "one" }, state) as HostServices & { testSilentWrite(path: string, value: string): void };
    const remote = provider();
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview(); await coordinator.run({ approvePreview: true });
    host.testSilentWrite("Note.md", "two");
    const result = await coordinator.run();
    expect(result.conflicts).toBe(1);
    expect(await host.vaultFiles.read("Note.md")).toBe("two");
    const restarted = new SyncCoordinator(host, () => "vault-a");
    restarted.register("plugin-a", remote);
    expect(await restarted.listConflicts()).toHaveLength(1);
    const [conflict] = await restarted.listConflicts();
    await restarted.resolveConflict(conflict.id, "keep-local");
    expect(await restarted.listConflicts()).toHaveLength(0);
    expect(await host.vaultFiles.read("Note.md")).toBe("two");
  });

  it("invalidates preview approval after same-size same-timestamp edits", async () => {
    const host = memoryHost({ "Note.md": "one" }) as HostServices & { testSilentWrite(path: string, value: string): void };
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", provider()); await coordinator.activate("test.remote");
    await coordinator.preview(); host.testSilentWrite("Note.md", "two");
    await expect(coordinator.run({ approvePreview: true })).rejects.toThrow(/preview/i);
  });
  it("claims the run mutex synchronously before loading state", async () => {
    const coordinator = new SyncCoordinator(memoryHost(), () => "vault-a");
    coordinator.register("plugin-a", provider());
    await coordinator.activate("test.remote");

    const first = coordinator.preview();
    await expect(coordinator.preview()).rejects.toThrow(/already running/i);
    await first;
  });
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

  it("does not overwrite a local edit made after planning a remote download", async () => {
    const host = memoryHost() as HostServices & { testWrite(path: string, value: string): void; testRead(path: string): string | undefined };
    const remote = provider([{ id: "remote-1", path: "Note.md", kind: "file", revision: "1", size: 14 }]);
    remote.open = async () => ({
      ...(await provider().open({ vaultId: "vault-a" })),
      scan: async () => ({ status: "complete", mode: "snapshot", entries: [{ id: "remote-1", path: "Note.md", kind: "file", revision: "1", size: 14 }] }),
      read: async () => { host.testWrite("Note.md", "typed locally"); return new TextEncoder().encode("remote version").buffer; },
    });
    const coordinator = new SyncCoordinator(host, () => "vault-a", () => 123);
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview();

    const result = await coordinator.run({ approvePreview: true });
    expect(host.testRead("Note.md")).toBe("typed locally");
    expect(host.testRead("Note.sync-conflict-123.md")).toBe("remote version");
    expect(result.conflicts).toBe(1);
  });

  it("treats a local deletion against a newer remote revision as a conflict", async () => {
    const host = memoryHost({ "Note.md": "same" }) as HostServices & { testDelete(path: string): void; testRead(path: string): string | undefined };
    const entries: SyncRemoteEntry[] = [];
    const remote = provider(entries);
    const coordinator = new SyncCoordinator(host, () => "vault-a", () => 456);
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    host.testDelete("Note.md");
    entries.push({ id: "id:Note.md", path: "Note.md", kind: "file", revision: "2", size: 14 });

    const result = await coordinator.run();
    expect(result.conflicts).toBe(1);
    expect(host.testRead("Note.sync-conflict-456.md")).toBe("remote:Note.md");
  });

  it("rejects duplicate exact paths and file-folder kind collisions", async () => {
    const duplicates: SyncRemoteEntry[] = [
      { id: "1", path: "same", kind: "file", revision: "1" },
      { id: "2", path: "same", kind: "folder", revision: "1" },
    ];
    const coordinator = new SyncCoordinator(memoryHost(), () => "vault-a");
    const remote = provider(duplicates);
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await expect(coordinator.preview()).rejects.toThrow(/collision/i);
  });

  it("reconciles delta scans against the persisted remote index", async () => {
    const host = memoryHost({ "Note.md": "one" }) as HostServices & { testWrite(path: string, value: string): void };
    let scanNumber = 0;
    const update = vi.fn(async input => ({ id: input.id, path: input.path, kind: "file" as const, revision: "2" }));
    const remote = provider();
    remote.open = async () => ({
      ...(await provider().open({ vaultId: "vault-a" })),
      scan: async () => scanNumber++ < 2
        ? { status: "complete", mode: "snapshot", entries: [], cursor: "c1" } as const
        : { status: "complete", mode: "delta", entries: [], cursor: "c2" } as const,
      create: async input => ({ id: "remote-note", path: input.path, kind: "file", revision: "1", operationKey: input.operationKey }),
      update,
    });
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    host.testWrite("Note.md", "two");

    await coordinator.run();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "remote-note", expectedRevision: "1" }));
  });

  it("cancels an operation for a persisted active provider after restart and unload", async () => {
    const sharedState = new Map<string, unknown>();
    const first = new SyncCoordinator(memoryHost({}, sharedState), () => "vault-a");
    const remote = provider();
    first.register("plugin-a", remote);
    await first.activate(remote.id);

    let releaseOpen!: () => void;
    const waiting = new Promise<void>(resolve => { releaseOpen = resolve; });
    let scanCalled = false;
    remote.open = async () => { await waiting; return { ...(await provider().open({ vaultId: "vault-a" })), scan: async () => { scanCalled = true; return { status: "complete", mode: "snapshot", entries: [] }; } }; };
    const restarted = new SyncCoordinator(memoryHost({}, sharedState), () => "vault-a");
    const unregister = restarted.register("plugin-a", remote);
    const run = restarted.preview().catch(() => undefined);
    await Promise.resolve();
    const unloading = unregister();
    releaseOpen();
    await unloading;
    await run;
    expect(scanCalled).toBe(false);
    expect(restarted.getStatus()).toMatchObject({ state: "error", providerId: remote.id });
  });

  it("persists device-local scope changes and invalidates first-sync approval", async () => {
    const sharedState = new Map<string, unknown>();
    const coordinator = new SyncCoordinator(memoryHost({}, sharedState), () => "vault-a");
    const remote = provider();
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview();
    await coordinator.updateScope({ images: false, excludedFolders: ["Private"] });

    await expect(coordinator.getScope()).resolves.toMatchObject({ images: false, excludedFolders: ["Private"] });
    await expect(coordinator.run({ approvePreview: true })).rejects.toThrow(/preview/i);
  });

  it("rescans after a remote precondition race and preserves the current remote bytes without advancing the baseline", async () => {
    const host = memoryHost({ "Note.md": "local" }) as HostServices & { testWrite(path: string, value: string): void; testRead(path: string): string | undefined };
    let revision = "1";
    let exists = false;
    const update = vi.fn(async () => { revision = "2"; const error = new Error("changed"); error.name = "SyncPreconditionError"; throw error; });
    const remote = provider();
    remote.open = async () => ({
      ...(await provider().open({ vaultId: "vault-a" })),
      scan: async () => ({ status: "complete", mode: "snapshot", entries: exists ? [{ id: "r", path: "Note.md", kind: "file", revision, size: 6 }] : [] }),
      create: async input => { exists = true; return { id: "r", path: input.path, kind: "file", revision: "1", operationKey: input.operationKey }; },
      read: async entry => new TextEncoder().encode(`remote-${entry.revision}`).buffer,
      update,
    });
    const coordinator = new SyncCoordinator(host, () => "vault-a", () => 999);
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    host.testWrite("Note.md", "edited");

    const result = await coordinator.run();
    expect(result.conflicts).toBe(1);
    expect(host.testRead("Note.sync-conflict-999.md")).toBe("remote-2");
    expect((await coordinator.listConflicts())[0]).toMatchObject({ path: "Note.md", remoteRevision: "2" });
  });

  it("creates remote folders locally without trying to read them as files", async () => {
    const host = memoryHost();
    const mkdir = vi.spyOn(host.vaultFiles, "mkdir");
    const remote = provider([{ id: "dir", path: "Folder", kind: "folder", revision: "1" }]);
    const read = vi.fn();
    remote.open = async () => ({ ...(await provider().open({ vaultId: "vault-a" })), read, scan: async () => ({ status: "complete", mode: "snapshot", entries: [{ id: "dir", path: "Folder", kind: "folder", revision: "1" }] }) });
    const coordinator = new SyncCoordinator(host, () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await coordinator.preview();
    await coordinator.run({ approvePreview: true });
    expect(mkdir).toHaveBeenCalledWith("Folder", expect.any(String));
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects scan modes the provider did not advertise", async () => {
    const remote = { ...provider(), capabilities: { ...provider().capabilities, delta: false, completeSnapshots: true } } as SyncProvider;
    remote.open = async () => ({ ...(await provider().open({ vaultId: "vault-a" })), scan: async () => ({ status: "complete", mode: "delta", entries: [] }) });
    const coordinator = new SyncCoordinator(memoryHost(), () => "vault-a");
    coordinator.register("plugin-a", remote);
    await coordinator.activate(remote.id);
    await expect(coordinator.preview()).rejects.toThrow(/unadvertised delta/i);
  });
});
