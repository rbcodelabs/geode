import { expect, it, vi } from "vitest";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { APPEND_ONLY_PROTOCOL } from "../../src/renderer/sync/history-types";

it("never reports idle for unresolved integrity or queued actions", () => {
  const service = new SyncService({} as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history" };
  const result = { signature: "preview", requiresApproval: false, uploads: 0, downloads: 0, deletions: 0, conflicts: [], blocked: [], excluded: [], pending: 0, upToDate: false };
  (service as any).summarize(result); expect(service.getStatus().state).toBe("error");
  (service as any).summarize({ ...result, uploads: 1 }); expect(service.getStatus().state).toBe("pending");
});

it("cancels discovery and rejects late results when the vault changes", async () => {
  let finish!: (value: unknown[]) => void; let root = "/synthetic/old"; let signal!: AbortSignal;
  const service = new SyncService({} as never, () => root);
  (service as any).selected = { discover: (_signal: AbortSignal) => { signal = _signal; return new Promise(resolve => { finish = resolve; }); } };
  const pending = service.discoverVaults(); const rejection = expect(pending).rejects.toThrow(/changed/);
  root = "/synthetic/new"; const cancelled = service.cancel(); expect(signal.aborted).toBe(true); finish([]);
  await rejection; await cancelled;
});

it("does not resurrect a binding when disconnect races the join state read", async () => {
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const writes: unknown[] = []; let finish!: (value: unknown) => void;
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }), write: async (_key: string, value: unknown) => { writes.push(value); }, remove: async () => {} } } as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history", discover: async () => [descriptor] };
  const joining = service.joinVault(descriptor as never); const rejected = expect(joining).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const disconnecting = service.disconnect(); finish(null);
  await rejected; await disconnecting; expect(writes).toEqual([]);
});

for (const action of ["disconnect", "unregister"] as const) it(`cancels first activation when ${action} happens before selection`, async () => {
  let finish!: (value: unknown) => void; const write = vi.fn(async () => {});
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }), write, remove: async () => {} }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).restore = async () => {};
  const unregister = service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  const activation = service.activate("history"); const rejection = expect(activation).rejects.toThrow(/changed/);
  const closing = action === "disconnect" ? service.disconnect() : unregister(); finish(null);
  await rejection; await closing; expect(write).not.toHaveBeenCalled(); expect(service.getActiveProvider()).toBeNull();
});

it("does not restore a persisted binding after disconnect during the registration read", async () => {
  let finish!: (value: unknown) => void;
  const remove = vi.fn(async () => {});
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }), remove }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).conditional.disconnect = async () => {};
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  await service.disconnect();
  finish({ schema: 1, localRoot: "/synthetic/vault", providerId: "history", paused: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.getActiveProvider()).toBeNull();
  expect(remove).toHaveBeenCalledWith("sync-history-binding//synthetic/vault");
});

it("does not rearm retries or replace paused status from an old scheduled failure", async () => {
  vi.useFakeTimers();
  try {
    let fail!: (error: Error) => void;
    const service = new SyncService({} as never, () => "/synthetic/vault");
    (service as any).selected = { id: "history" }; (service as any).status = { state: "idle", conflicts: 0 };
    service.run = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
    (service as any).schedule(0); await vi.advanceTimersByTimeAsync(0);
    await service.cancel(); (service as any).status = { state: "paused", conflicts: 0 };
    fail(new Error("old request failed")); await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus().state).toBe("paused"); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("keeps structural parents and trusted renamed identities in Markdown-only scope", async () => {
  const stored = new Map(); const operations = new Map(); const blobs = new Map(); const records: any[] = [];
  let changed: (event: any) => void = () => {};
  let files = [{ path: "Folder", isFolder: true, size: 0, mtime: 1, ctime: 1 }, { path: "Folder/Note.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  let text = "old";
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const host = { config: { read: async () => null }, deviceState: { read: async (key: string) => structuredClone(stored.get(key) ?? null), write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); } },
    vaultFiles: { onChange: (callback: any) => { changed = callback; return () => {}; }, reconcileScan: async () => ({ status: "complete", entries: files }), readBinary: async () => new TextEncoder().encode(text).buffer },
    syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {}, storage: async (_token: string, _binding: string, request: any) => { if (request.action === "load-operations") return [...operations.values()]; if (request.action === "save-operation") { operations.set(request.key, structuredClone(request.value)); return; } if (request.action === "stage") { blobs.set(request.key, request.data.slice(0)); return request.key; } return blobs.get(request.key).slice(0); } },
  };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 }, discover: async () => [descriptor], createVault: async () => descriptor,
    open: async () => ({ scan: async () => ({ status: "complete", records: structuredClone(records) }), putBlob: async (input: any) => { blobs.set(input.operationId, input.data.slice(0)); return { id: input.operationId, sha256: input.sha256, size: input.size }; }, readBlob: async (ref: any) => blobs.get(ref.id).slice(0), appendRecord: async (record: any) => { if (!records.some(item => item.recordId === record.recordId)) records.push(structuredClone(record)); }, close: async () => {} }),
  } as never);
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    expect((await service.preview()).uploads).toBe(2); await service.run({ approvePreview: true });
    const folder = records.find(record => record.kind === "folder"); const note = records.find(record => record.kind === "file");
    files = [{ ...files[0], path: "Moved" }, { ...files[1], path: "Moved/Note.md" }]; text = "new";
    changed({ event: "create-folder", path: "Moved", renamedFrom: "Folder" });
    await service.preview(); await service.run({ approvePreview: true });
    expect(service.getHistoryDetails()).toMatchObject({ conflicts: [], blocked: [] });
    expect(records.filter(record => record.entityId === folder.entityId).at(-1).location.name).toBe("Moved");
    expect(records.filter(record => record.entityId === note.entityId).at(-1).deleted).toBe(false);
    expect(new Set(records.map(record => record.entityId)).size).toBe(2);
  } finally { await service.cancel(); }
});

it("never disconnects the new vault after cancellation crosses a vault switch", async () => {
  let root = "/synthetic/old"; let release!: () => void;
  const remove = vi.fn();
  const service = new SyncService({ deviceState: { remove }, vaultFiles: { onChange: () => () => {} } } as never, () => root);
  (service as any).selected = { id: "history" };
  (service as any).running = new Promise<void>(resolve => { release = resolve; });
  const pending = service.disconnect(); root = "/synthetic/new"; release();
  await expect(pending).rejects.toThrow(/changed/); expect(remove).not.toHaveBeenCalled();
});

it("cancels active history work before changing scope", async () => {
  const stored = new Map();
  const service = new SyncService({ deviceState: { read: async (key: string) => stored.get(key) ?? null, write: async (key: string, value: unknown) => { stored.set(key, value); } }, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history" };
  const abort = new AbortController(); (service as any).abort = abort;
  await service.updateScope({ markdown: false }); expect(abort.signal.aborted).toBe(true); expect(service.getStatus().state).toBe("preview");
});

it("requires explicit create or join and persists creation identity before remote mutation", async () => {
  const stored = new Map<string, unknown>();
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const createVault = vi.fn(async ({ operationId }) => { expect([...stored.values()].some(value => JSON.stringify(value).includes(operationId))).toBe(true); return descriptor; });
  const host = { deviceState: { read: async (key: string) => stored.get(key) ?? null, write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); } }, vaultFiles: { onChange: () => () => {} }, syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {} } };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 }, discover: async () => [descriptor], createVault, open: vi.fn() } as never);
  expect(service.listProviders()).toEqual([{ id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL }]);
  await service.activate("history");
  await expect(service.preview()).rejects.toThrow(/create|join/i);
  await service.createVault("Shared"); expect(createVault).toHaveBeenCalledOnce();
  expect(service.getStatus().state).toBe("preview");
  await service.cancel();
});
